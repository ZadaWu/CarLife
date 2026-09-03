//! AEC 参考信号桥（施工单 M47-02，变更单 ACR-010）。
//!
//! # 它连接的两端
//!
//! ```text
//! 播放线程（rodio）          本模块              哨兵线程
//!  Decoder ─ RenderTap ──→ 有界队列 ──→ StreamConverter → AecProcessor
//!     │                                                        │
//!     └→ 声卡（原样透传）                    converter 出的采集帧 ┘
//! ```
//!
//! 回声消除要的是"扬声器此刻在放什么"。这份信号只存在于播放线程里，
//! 而对消发生在哨兵线程，所以中间必须有一道跨线程的桥——就是本模块。
//!
//! # 第一原则：绝不阻塞播放线程
//!
//! `RenderTap::next` 跑在 rodio 的播放路径上，它慢一点，声音就卡一下。
//! **卡顿的播报比回声更像故障**——回声只是她偶尔自问自答，卡顿是"这车坏了"。
//! 所以这里：
//!
//! - 队列有界，`try_send` 满了就丢，绝不 `send` 阻塞；
//! - 播放线程只做最轻的事——攒一批原始样本推走。重采样、格式转换全在
//!   哨兵线程做（它本来就在做同样的事，多一路不算新增负担）。
//!
//! # 开关关闭时零开销
//!
//! `CARLIFE_AEC_ENABLED` 没开时：不包 `RenderTap`（播放走原来那条路，
//! 一次多余的函数调用都没有）、不建 `AecProcessor`、不碰队列。
//! 这是 M47-02「合入当天所有人的行为逐字节不变」的实现点。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Mutex, OnceLock};

/// 一批参考样本的目标大小（交错样本个数）。
///
/// 取值权衡：太小则播放线程频繁 `try_send`（每次一个原子操作 + 一次可能的
/// 内存分配），太大则参考信号到达 AEC 的时间粒度变粗、延迟估计跟着变糙。
/// 1024 个交错样本在 44.1k 立体声下约 11.6ms，与 APM 的 10ms 帧同量级。
const BATCH_SAMPLES: usize = 1024;

/// 队列容量（批数）。64 批在上述批大小下约 0.7s。
///
/// 它兜的是"哨兵线程偶尔慢一拍"，不是"哨兵卡死"——后者丢多少都救不回来，
/// 而且丢弃计数会明确告诉我们这件事（见 `DROPPED_BATCHES`）。
const QUEUE_BATCHES: usize = 64;

/// 播放线程发给哨兵线程的消息。
pub enum RenderMsg {
    /// 新一段播放开始，带上源格式——**每段都要发**：
    /// 不同 TTS 响应的 mp3 采样率不一定相同，消费侧据此重建重采样器。
    Start { sample_rate: u32, channels: u16 },
    /// 一批交错的原始播放样本。
    Samples(Vec<f32>),
}

/*
 * 延迟提示的**按平台各一份**（施工单 M47-05，ACR-010 分步实施 3a/3b）。
 *
 * # 为什么不能共用一个值
 *
 * `set_stream_delay_ms` 要的是"播出去"到"采回来"的延迟。iOS 的 IO buffer duration
 * 由 `AVAudioSession` 决定，与桌面不是一个量级——ACR-010 立项时就写死了
 * 「两平台的值不共用，各存一份」。共用的下场是：一个平台调好了，另一个平台
 * 用着错的值，而错的固定值**比自适应还差**（上游实测：对齐正确 > 自适应 > 对齐错误，
 * 且第一与第三差三个数量级）。
 *
 * # 为什么现在两个都是 None
 *
 * `None` = 交给 AEC3 自适应估计。这不是偷懒，是**不拿猜的数当基线**：
 * 真值要真机实测（macOS 走 M47-03、iPad 走 M47-05），实测前填任何数字都是编的，
 * 而编错了比不填更糟。调参的人把实测值填进对应的那一行即可，不必改别处。
 *
 * 起点参考：iOS 侧用 `carlife_media::audio_session::audio_latency()` 读一次
 * `outputLatency + inputLatency + IOBufferDuration`——它只覆盖硬件与驱动那一段，
 * 不含 rodio 解码缓冲与本模块的队列，所以是扫描起点不是答案。
 */
#[cfg(target_os = "ios")]
const PLATFORM_STREAM_DELAY_MS: Option<u16> = None; // 待 M47-05 真机实测填入
#[cfg(not(target_os = "ios"))]
const PLATFORM_STREAM_DELAY_MS: Option<u16> = None; // 待 M47-03 真机实测填入

/// 本平台的延迟提示，可用 `CARLIFE_AEC_DELAY_MS` 覆盖。
///
/// 环境变量这一档是给**桌面调参**用的：M47-03 扫档位时不必每换一个值就重编译。
/// iOS 上传不了环境变量，所以那边只能改上面的常量重装——这也是为什么
/// M47-05 的工单特意提醒"档位要挑着扫，别指望一次装机试八个值"。
pub fn stream_delay_ms() -> Option<u16> {
    match std::env::var("CARLIFE_AEC_DELAY_MS") {
        Ok(v) if v.eq_ignore_ascii_case("auto") => None,
        Ok(v) => match v.parse::<u16>() {
            Ok(ms) => Some(ms),
            Err(_) => {
                eprintln!("[aec] CARLIFE_AEC_DELAY_MS={v:?} 不是合法毫秒数，按平台默认值处理");
                PLATFORM_STREAM_DELAY_MS
            }
        },
        Err(_) => PLATFORM_STREAM_DELAY_MS,
    }
}

/// AEC 总开关。进程启动时从 `CARLIFE_AEC_ENABLED` 读一次。
///
/// **默认关**（ACR-010 兼容策略：并行运行 + 开关）。调参期它是工程开关不是
/// 用户偏好，所以只读环境变量、不做端上偏好页——重启生效足够。
static AEC_ENABLED: AtomicBool = AtomicBool::new(false);
static AEC_ENABLED_INIT: OnceLock<()> = OnceLock::new();

/// 因队列满而丢弃的批数。非零说明消费侧跟不上，调参时要看它。
static DROPPED_BATCHES: AtomicU64 = AtomicU64::new(0);
/// 已送达消费侧的批数——`CARLIFE_SENTINEL_DEBUG=1` 时打出来。
/// 它是"参考信号这条路到底通没通"的唯一证据：AEC 不生效时，
/// 先看这个数是不是 0，能一眼分开"没接上"与"接上了但没消掉"。
static FED_BATCHES: AtomicU64 = AtomicU64::new(0);

type Bridge = (SyncSender<RenderMsg>, Mutex<Option<Receiver<RenderMsg>>>);

/// 进程级单例队列。
///
/// 用全局而不是"哨兵启动时创建、传给 tts"，是因为两端的生命周期对不上：
/// 播放可能发生在哨兵重建流的间隙（起流失败时它 3s 才重试一次），
/// 那时若没有队列，这段播报就没有参考信号，而 AEC 会拿它当"未知回声"去追。
fn bridge() -> &'static Bridge {
    static BRIDGE: OnceLock<Bridge> = OnceLock::new();
    BRIDGE.get_or_init(|| {
        let (tx, rx) = sync_channel::<RenderMsg>(QUEUE_BATCHES);
        (tx, Mutex::new(Some(rx)))
    })
}

/// 读一次环境变量并锁定本进程的开关状态。
pub fn init_from_env() {
    AEC_ENABLED_INIT.get_or_init(|| {
        let on = std::env::var("CARLIFE_AEC_ENABLED").is_ok_and(|v| v == "1");
        AEC_ENABLED.store(on, Ordering::SeqCst);
        if on {
            eprintln!("[aec] 已启用（CARLIFE_AEC_ENABLED=1）——采集帧将过声学回声消除");
        }
    });
}

/// AEC 此刻是否启用。
pub fn enabled() -> bool {
    init_from_env();
    AEC_ENABLED.load(Ordering::Relaxed)
}

/// 取走消费端。只有第一个调用者拿得到（哨兵循环）。
pub fn take_receiver() -> Option<Receiver<RenderMsg>> {
    bridge().1.lock().ok().and_then(|mut g| g.take())
}

/// 已喂 / 已丢的批数——观测用。
pub fn counters() -> (u64, u64) {
    (FED_BATCHES.load(Ordering::Relaxed), DROPPED_BATCHES.load(Ordering::Relaxed))
}

/// 把播放样本旁路一份给 AEC 的 Source 包装器。
///
/// 对 rodio 完全透明：`next()` 原样返回内部 Source 的样本，
/// 只是顺手抄了一份。**播放路径上不做任何可能阻塞的事**。
pub struct RenderTap<S> {
    inner: S,
    buf: Vec<f32>,
    tx: SyncSender<RenderMsg>,
    /// 首个样本前要先发 `Start`——消费侧靠它建重采样器。
    announced: bool,
}

impl<S> RenderTap<S>
where
    S: rodio::Source,
{
    pub fn new(inner: S) -> Self {
        Self::with_sender(inner, bridge().0.clone())
    }

    /// 指定发送端。生产路径永远走 [`RenderTap::new`]（那条要的就是**进程级单例**队列，
    /// 理由见 [`bridge`]）；这个口子只给用例。
    ///
    /// # 为什么用例需要它
    ///
    /// 队列是全局的，而 `cargo test` 默认并行跑。于是"我读到的样本数"里可能混进
    /// 别的用例推的批次——`aec队列满时丢弃不阻塞播放` 一口气灌 200 批且不取走任何东西，
    /// 它的残余正好会被下一个读队列的用例算进去。**表现是偶发的 `left: 2148, right: 1124`
    /// （差值恰好一个 `BATCH_SAMPLES`），而单跑永远复现不了**——最容易被当成
    /// "重跑一下就好"而一直留着。
    ///
    /// 给每个要读队列的用例一条自己的通道，这类干扰结构性消失，不靠"谁先跑"。
    fn with_sender(inner: S, tx: SyncSender<RenderMsg>) -> Self {
        Self {
            inner,
            buf: Vec::with_capacity(BATCH_SAMPLES),
            tx,
            announced: false,
        }
    }

    /// 推走当前批次。满则丢并计数——**绝不阻塞**（见模块头）。
    fn flush(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        let batch = std::mem::replace(&mut self.buf, Vec::with_capacity(BATCH_SAMPLES));
        match self.tx.try_send(RenderMsg::Samples(batch)) {
            Ok(()) => {
                FED_BATCHES.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
                DROPPED_BATCHES.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

impl<S> Iterator for RenderTap<S>
where
    S: rodio::Source,
{
    type Item = rodio::Sample;

    fn next(&mut self) -> Option<Self::Item> {
        let Some(sample) = self.inner.next() else {
            // 播完了：把不足一批的尾巴也送走，别让最后几十毫秒的参考信号消失
            // ——播报末尾恰恰是车主最可能插话的时刻。
            self.flush();
            return None;
        };

        if !self.announced {
            self.announced = true;
            let _ = self.tx.try_send(RenderMsg::Start {
                sample_rate: self.inner.sample_rate().get(),
                channels: self.inner.channels().get(),
            });
        }

        self.buf.push(sample);
        if self.buf.len() >= BATCH_SAMPLES {
            self.flush();
        }
        Some(sample)
    }
}

impl<S> rodio::Source for RenderTap<S>
where
    S: rodio::Source,
{
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }

    fn channels(&self) -> rodio::ChannelCount {
        self.inner.channels()
    }

    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }

    fn total_duration(&self) -> Option<std::time::Duration> {
        self.inner.total_duration()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZero;

    /// 最小可用的测试 Source：固定格式的一串样本。
    struct TestSource {
        samples: std::vec::IntoIter<f32>,
        rate: u32,
        ch: u16,
    }

    impl Iterator for TestSource {
        type Item = rodio::Sample;
        fn next(&mut self) -> Option<f32> {
            self.samples.next()
        }
    }

    impl rodio::Source for TestSource {
        fn current_span_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> rodio::ChannelCount {
            NonZero::new(self.ch).expect("测试声道数非零")
        }
        fn sample_rate(&self) -> rodio::SampleRate {
            NonZero::new(self.rate).expect("测试采样率非零")
        }
        fn total_duration(&self) -> Option<std::time::Duration> {
            None
        }
    }

    fn source(n: usize) -> TestSource {
        let samples: Vec<f32> = (0..n).map(|i| (i % 100) as f32 / 100.0).collect();
        TestSource { samples: samples.into_iter(), rate: 44_100, ch: 2 }
    }

    /// **最重要的一条**：tee 不能改变播放的样本。
    ///
    /// 它错了的表现是声音变形/有杂音，而人会先怀疑 TTS 引擎、网络、音量，
    /// 最后才想到"是不是那个旁路把样本改了"。
    #[test]
    fn aec旁路逐样本透传不改变播放() {
        let expect: Vec<f32> = source(5_000).collect();
        let got: Vec<f32> = RenderTap::new(source(5_000)).collect();
        assert_eq!(got, expect, "旁路必须逐样本透传");
    }

    /// Source 的元信息也要透传，否则 rodio 会按错误的格式送进声卡。
    #[test]
    fn aec旁路透传源格式() {
        let tap = RenderTap::new(source(10));
        assert_eq!(rodio::Source::sample_rate(&tap).get(), 44_100);
        assert_eq!(rodio::Source::channels(&tap).get(), 2);
    }

    /// 队列满时丢弃而不阻塞——这条保证的是"播报不会因为 AEC 卡住"。
    ///
    /// 没有消费者时灌远超容量的样本：它必须跑完，且丢弃计数增长。
    #[test]
    fn aec队列满时丢弃不阻塞播放() {
        let before = DROPPED_BATCHES.load(Ordering::Relaxed);
        // 容量 64 批 × 1024 样本；灌 200 批的量，且不取走任何东西
        let n = BATCH_SAMPLES * 200;
        let got = RenderTap::new(source(n)).count();
        assert_eq!(got, n, "样本必须全部透传，一个都不能因为队列满而少");
        assert!(
            DROPPED_BATCHES.load(Ordering::Relaxed) > before,
            "队列满后应计入丢弃，而不是阻塞播放线程"
        );
    }

    /// 一条只属于本用例的通道。见 `RenderTap::with_sender` 的文档注释。
    fn private_channel() -> (SyncSender<RenderMsg>, Receiver<RenderMsg>) {
        sync_channel::<RenderMsg>(QUEUE_BATCHES)
    }

    /// 播完的尾巴要送走：播报末尾正是车主最可能插话的时刻。
    ///
    /// # 为什么不走全局队列
    ///
    /// 原来这条用 `take_receiver()` 从进程级单例队列上读，并靠"谁先取到接收端"
    /// 来防抢。那道防线只挡得住"接收端被别人拿走"，**挡不住"别人在我拿到接收端
    /// 之前（或之后、并行地）已经往队列里推了一批"**——`aec队列满时丢弃不阻塞播放`
    /// 恰好灌 200 批且从不取走。于是 `check:all` 下偶发
    /// `left: 2148, right: 1124`（差值恰好一个 `BATCH_SAMPLES`），
    /// 而单独跑 `cargo test -p cockpit --lib` 十几次全过。
    ///
    /// 自带一条通道之后，这里读到的每一个样本都只可能来自本用例推的那一次播放，
    /// 与并行的其它用例无关，也不依赖任何执行顺序。
    #[test]
    fn aec播放结束时冲刷尾批() {
        let (tx, rx) = private_channel();
        let n = BATCH_SAMPLES + 100; // 一整批 + 不足一批的尾巴
        let _: Vec<f32> = RenderTap::with_sender(source(n), tx).collect();

        let mut total = 0usize;
        while let Ok(msg) = rx.try_recv() {
            if let RenderMsg::Samples(b) = msg {
                total += b.len();
            }
        }
        assert_eq!(total, n, "整批与尾批都应送达，合计等于播放的样本数");
    }

    /// 起播前必须先发一次 `Start`，消费侧靠它建重采样器。
    ///
    /// 与上一条同源：原来它是被"队列里有什么"的噪声盖住的一条断言——
    /// 全局队列里混着别的用例推的 `Start`，验不出"**本次播放**announce 过"。
    #[test]
    fn aec起播先发一次_start_且只发一次() {
        let (tx, rx) = private_channel();
        let _: Vec<f32> = RenderTap::with_sender(source(BATCH_SAMPLES * 3), tx).collect();

        let mut starts = 0usize;
        let mut first_is_start = None;
        while let Ok(msg) = rx.try_recv() {
            let is_start = matches!(msg, RenderMsg::Start { .. });
            if first_is_start.is_none() {
                first_is_start = Some(is_start);
            }
            if let RenderMsg::Start { sample_rate, channels } = msg {
                starts += 1;
                assert_eq!(sample_rate, 44_100, "Start 要带真实源格式");
                assert_eq!(channels, 2);
            }
        }
        assert_eq!(first_is_start, Some(true), "Start 必须排在第一批样本前面");
        assert_eq!(starts, 1, "一段播放只 announce 一次");
    }
}
