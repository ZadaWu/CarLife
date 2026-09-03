//! 哨兵监听循环——手机端（施工单 M60-01，F-52-01）。
//!
//! # 与车机端那份的关系：**故意不共用**
//!
//! 车机端的 `clients/cockpit/src-tauri/src/voice/sentinel.rs` 比这份长一倍，
//! 多出来的全部是**本地播报带来的**：AEC 参考信号排空、播报期窄通道、
//! 回采过滤、语音打断。手机端没有本地 TTS（`commands/media.rs` 文件头写了
//! 这件事），那些分支在这里恒不成立。
//!
//! 把两份合成一个带钩子的通用循环，等于为了消除重复去重写一个已经在真车上
//! 跑通的组件。共用的是**判据**而不是循环：唤醒词表、对话窗口、降级闸都在
//! `clients/shared/rust/carlife-voice`，两端一字不差（见那个 crate 的文件头）。
//!
//! 线程模型与 PTT 一致：cpal 归专用线程，外部经 `Send` 的句柄控制。
//!
//! ```text
//! ContinuousHandle（cpal 持续采集） → StreamConverter（→16k 单声道帧）
//!   → SegmentAssembler（VAD 分段 + 预卷 + 段上限） → segment_tx（交给转写消费者）
//! ```
//!
//! 控制语义：
//!  - `SetSwitch(false)`：总开关关——**第一顺位**，流即刻 drop（麦克风占用消失）、
//!    装配器清空在录段与预卷；
//!  - `Pause` / `Resume`：PTT 互斥——长按按下瞬间让出麦克风，松手恢复；
//!  - 设备起流失败不放弃：记录后按 `REBUILD_EVERY` 重试。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use carlife_core::contract::{SentinelIndication, SentinelListenState};
use carlife_media::{
    AssemblerConfig, ContinuousHandle, ListenState, SegmentAssembler, SentinelSegment,
    StreamConverter,
};

const POLL: Duration = Duration::from_millis(50);
const REBUILD_EVERY: Duration = Duration::from_secs(3);

/// 哨兵监听总开关（M60-01，F-52-01）。
///
/// # 为什么默认是关
///
/// 它决定"这台手机平时开不开着麦克风"。常驻监听是隐私上最重的一个默认值，
/// 而手机比车机更甚——它在口袋里、在会议室里、在别人家里。
/// 一个用户没点过头就一直在听的麦克风，即使转写未命中即弃，也不该是开箱状态。
///
/// 关着的时候哨兵**线程照常在跑，但不建 cpal 流**——麦克风不被占用。
/// 线程留着是为了 `voice:sentinel` 指示事件仍然有来源：不然设置页的开关
/// 会因为"没有事件"而看不出当前状态。
///
/// 跨重启保持（`prefs.json` 的 `sentinelEnabled`），载入在
/// `commands::profile::load_sentinel_pref`。
pub static SENTINEL_ENABLED: AtomicBool = AtomicBool::new(false);

/// 转写链路降级中（对齐车机端 M25-04）：连续失败达阈值后由转写消费者置位，
/// 恢复探测成功后清除。降级期间哨兵丢帧不采段——对着坏端点持续上传只会积压。
pub static SENTINEL_DEGRADED: AtomicBool = AtomicBool::new(false);

/// 哨兵此刻**有没有真的放开麦克风**。
///
/// `SentinelHandle::send` 只是把命令塞进通道，循环 [`POLL`] 一拍才会真正
/// 释放设备；而 `commands/media.rs` 的长按在 `pause()` 之后**立刻**起自己的流。
/// **iOS 的 RemoteIO / AVAudioSession 是独占的**，晚到的那次 teardown 会把
/// 长按刚建好的流一起带走——现场表现是"手指还按着，录音自己结束了"，
/// 而且时有时无（取决于按下的瞬间循环走到哪一拍）。车机端 M39-02 真机实测
/// 踩到的就是这个，手机端从第一天起就带上它。
pub static MIC_RELEASED: AtomicBool = AtomicBool::new(true);

/// 等哨兵真的放开麦克风。返回是否等到（`false` = 超时）。
///
/// **超时也要让调用方继续**：哨兵卡住时宁可冒一次并存的风险，也不能让长按
/// 变成按不动——那是把一个偶发缺陷换成一个必现缺陷。
pub fn wait_mic_released(timeout: Duration) -> bool {
    wait_flag(&MIC_RELEASED, timeout)
}

/// 轮询等一个标志置真。**参数化是为了可测**：测试各拿自己的 `AtomicBool`，
/// 不去碰进程级的 `MIC_RELEASED`——共用全局的话，cargo 并行跑测试时
/// 它们会互相把对方的前置条件改掉。
fn wait_flag(flag: &AtomicBool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if flag.load(Ordering::Acquire) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SentinelCommand {
    /// PTT 按下：让出麦克风。
    Pause,
    /// PTT 松手：回哨兵。
    Resume,
    /// 麦克风总开关。
    SetSwitch(bool),
    Shutdown,
}

pub struct SentinelHandle {
    cmd_tx: SyncSender<SentinelCommand>,
    join: Option<JoinHandle<()>>,
}

impl SentinelHandle {
    pub fn send(&self, cmd: SentinelCommand) {
        // 满/断都不重试：命令是幂等的状态设定，下一条会覆盖
        match self.cmd_tx.try_send(cmd) {
            Ok(()) | Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
        }
    }

    pub fn shutdown(mut self) {
        self.send(SentinelCommand::Shutdown);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for SentinelHandle {
    fn drop(&mut self) {
        // 不 join（drop 可能发生在任意线程）；线程见 Shutdown/断开自会退出
        let _ = self.cmd_tx.try_send(SentinelCommand::Shutdown);
    }
}

/// 启动哨兵循环线程。段经 `segment_tx` 交给消费者（`commands/voice.rs` 的转写循环）；
/// 指示快照经 `indicate` 在状态变化时上报（F-52-06：UI 不得自己维护监听状态）。
pub fn spawn_sentinel(
    cfg: AssemblerConfig,
    segment_tx: SyncSender<SentinelSegment>,
    indicate: Box<dyn Fn(SentinelIndication) + Send>,
) -> SentinelHandle {
    let (cmd_tx, cmd_rx) = sync_channel::<SentinelCommand>(8);
    let join = std::thread::spawn(move || sentinel_loop(cfg, cmd_rx, segment_tx, indicate));
    SentinelHandle { cmd_tx, join: Some(join) }
}

struct ActivePipeline {
    handle: ContinuousHandle,
    converter: StreamConverter,
    assembler: SegmentAssembler,
}

/// 当前时刻的指示快照——由循环内真实状态推导（listen.rs 纪律：宁可迟亮，不可假灭）。
fn indication(
    switch_on: bool,
    paused: bool,
    discarding: bool,
    active: Option<&ActivePipeline>,
) -> SentinelIndication {
    let degraded = SENTINEL_DEGRADED.load(Ordering::Relaxed);
    let state = if !switch_on {
        SentinelListenState::Off
    } else if paused || discarding || active.is_none() {
        SentinelListenState::Suspended
    } else {
        match active.map(|p| p.assembler.state()) {
            Some(ListenState::Listening) => SentinelListenState::Listening,
            Some(ListenState::Uploading) => SentinelListenState::Uploading,
            _ => SentinelListenState::Idle,
        }
    };
    SentinelIndication { switch_on, state, degraded }
}

fn sentinel_loop(
    cfg: AssemblerConfig,
    cmd_rx: Receiver<SentinelCommand>,
    segment_tx: SyncSender<SentinelSegment>,
    indicate: Box<dyn Fn(SentinelIndication) + Send>,
) {
    /*
     * 总开关的初值取自持久化偏好，**不是写死的 true**。
     *
     * 这一行是"默认关"真正落地的地方：进程刚起、WebView 还没来得及 invoke
     * 任何东西的那几百毫秒里，麦克风开不开由它决定。
     */
    let mut switch_on = SENTINEL_ENABLED.load(Ordering::Relaxed);
    let mut paused = false;
    /*
     * 关掉开关后要不要把录音档位还给系统（M60-02，iPad 真机实测）。
     *
     * 停掉 cpal 流**不足以**让 iPadOS 熄灭麦克风指示：系统看的是
     * `AVAudioSession` 的类别，而 `ensure_recording_session()` 把它设成
     * `playAndRecord` 之后，此前全仓没有任何地方切回去。现场表现是
     * "我在设置页关了语音唤醒，状态栏还说这个 App 在用麦克风"——
     * 而车主没有办法判断哪一边是真的。
     *
     * 不在 `Pause` 时归还：那是长按说话让位，麦克风马上就要被 PTT 自己用。
     */
    let mut want_release = false;

    let mut discarding = false;
    let mut active: Option<ActivePipeline> = None;
    let mut last_indication: Option<SentinelIndication> = None;
    // 首次立即尝试起流
    let mut last_attempt = Instant::now() - REBUILD_EVERY;

    loop {
        // 1) 命令优先（总开关第一顺位的实现点：先于任何采样处理）
        loop {
            match cmd_rx.try_recv() {
                Ok(SentinelCommand::Pause) => paused = true,
                Ok(SentinelCommand::Resume) => paused = false,
                Ok(SentinelCommand::SetSwitch(on)) => switch_on = on,
                Ok(SentinelCommand::Shutdown) => {
                    if let Some(p) = active.take() {
                        p.handle.stop();
                    }
                    MIC_RELEASED.store(true, Ordering::Release);
                    return;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    if let Some(p) = active.take() {
                        p.handle.stop();
                    }
                    MIC_RELEASED.store(true, Ordering::Release);
                    return;
                }
            }
        }

        let want_stream = switch_on && !paused;

        // 2) 起停流
        if !want_stream {
            if let Some(p) = active.take() {
                p.handle.stop(); // 立即释放麦克风
            }
            // 只有"用户关了开关"才归还档位；`paused`（PTT 让位）不归还，见声明处。
            if !switch_on {
                want_release = true;
            }
        } else if active.is_none() && last_attempt.elapsed() >= REBUILD_EVERY {
            last_attempt = Instant::now();
            match ContinuousHandle::start() {
                Ok(handle) => {
                    let converter = StreamConverter::new(handle.sample_rate, handle.channels);
                    let mut assembler = SegmentAssembler::new(cfg);
                    assembler.set_switch(true);
                    active = Some(ActivePipeline { handle, converter, assembler });
                }
                Err(e) => {
                    eprintln!("[sentinel] 起流失败（{e}），{}s 后重试", REBUILD_EVERY.as_secs());
                }
            }
        }

        // 每一拍如实汇报设备状态——长按靠它判断"能不能起流了"（见 MIC_RELEASED）。
        MIC_RELEASED.store(active.is_none(), Ordering::Release);

        /*
         * 2.5) 归还录音档位（M60-02）。
         *
         * 三个前置条件缺一不可：流已经停（`active.is_none()`）、用户确实关着开关、
         * 用户确实关着开关。
         *
         * 车机端那份还要多判一个"此刻没在播报"——这边没有本地播报，
         * 那个条件恒成立，所以不写。
         */
        if want_release && active.is_none() && !switch_on {
            match carlife_media::release_recording_session() {
                Ok(true) => {
                    eprintln!("[sentinel] 已归还录音档位（系统麦克风指示应随之熄灭）");
                    want_release = false;
                }
                // 没还成不是失败：有采集在进行（长按用的是另一条流），或档位本来就还着。
                // 标志留着，采集一结束的下一拍再还——清掉的话指示灯就熄不掉了。
                // 车机端那份有一模一样的分支与完整因果链（2026-09-02 iPad 真机）。
                Ok(false) => {}
                // 真失败也清标志：每拍重试会把日志刷满，而它不是能靠重试解决的错。
                Err(e) => {
                    eprintln!("[sentinel] 归还录音档位失败，系统麦克风指示可能还亮着：{e}");
                    want_release = false;
                }
            }
        }


        /*
         * 3) 丢帧模式的边沿处理。
         *
         * 手机端只有一个触发条件——转写链路降级。车机端还有"播报期"，
         * 那一路在这里不存在（没有本地 TTS）。
         * 进入丢帧时清段清预卷，退出时恢复；用 assembler 的开关语义实现，
         * 不动 cpal 流——起停设备的抖动比丢帧贵。
         */
        let want_discard = SENTINEL_DEGRADED.load(Ordering::Relaxed);
        if want_discard != discarding {
            discarding = want_discard;
            if let Some(p) = active.as_mut() {
                p.assembler.set_switch(!discarding);
            }
        }

        // 4) 指示上报（仅变化时；流没建起来也要报——Suspended 同样是事实）
        let ind = indication(switch_on, paused, discarding, active.as_ref());
        if last_indication.as_ref() != Some(&ind) {
            indicate(ind.clone());
            last_indication = Some(ind);
        }

        // 5) 消费采样
        let Some(p) = active.as_mut() else {
            std::thread::sleep(POLL);
            continue;
        };
        match p.handle.data_rx.recv_timeout(POLL) {
            Ok(chunk) => {
                if discarding {
                    continue; // 降级期间：读走（防积压）但全部丢弃
                }
                for frame in p.converter.push(&chunk) {
                    if let Some(seg) = p.assembler.push_frame(&frame) {
                        // 满了丢段不丢循环：转写消费者卡住时哨兵不能死等
                        match segment_tx.try_send(seg) {
                            Ok(()) => {}
                            Err(TrySendError::Full(_)) => {
                                eprintln!("[sentinel] 转写队列满，丢弃一段");
                            }
                            Err(TrySendError::Disconnected(_)) => return,
                        }
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                // 采集线程没了（设备拔了/系统收走/iOS 打断）：丢掉重建
                eprintln!("[sentinel] 采集流断开，将重建");
                active = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 默认关_常驻麦克风不该是开箱状态() {
        // 这条断言看着像废话，但它守的是本单最核心的那个默认值：
        // 静态量的初值就是"进程刚起、WebView 还没说话时麦克风开不开"。
        assert!(!SENTINEL_ENABLED.load(Ordering::Relaxed));
    }

    #[test]
    fn 已放开时立刻返回_不给长按加延迟() {
        let flag = AtomicBool::new(true);
        let t0 = Instant::now();
        assert!(wait_flag(&flag, Duration::from_millis(500)));
        assert!(t0.elapsed() < Duration::from_millis(50));
    }

    #[test]
    fn 一直不放开时超时返回false_而不是永远卡住() {
        // 哨兵卡住是真实可能（起流失败要按 REBUILD_EVERY 重试三秒）。
        // 那时长按必须还能按下去——否则等于把一个偶发缺陷换成一个必现缺陷。
        let flag = AtomicBool::new(false);
        let t0 = Instant::now();
        assert!(!wait_flag(&flag, Duration::from_millis(60)));
        assert!(t0.elapsed() >= Duration::from_millis(60));
    }
}
