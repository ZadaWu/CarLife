//! 哨兵监听循环（施工单 M25-01，F-52-01）。
//!
//! 线程模型与 PTT 一致的哲学：cpal 归专用线程，外部经 `Send` 的句柄控制。
//! 本模块把三件现成的东西串成循环：
//!
//! ```text
//! ContinuousHandle（cpal 持续采集） → StreamConverter（→16k 单声道帧）
//!   → SegmentAssembler（VAD 分段 + 预卷 + 段上限） → segment_tx（交给转写消费者）
//! ```
//!
//! 控制语义（M25-00 约束 2/3）：
//!  - `SetSwitch(false)`：总开关关——**第一顺位**，流即刻 drop（麦克风占用消失）、
//!    装配器清空在录段与预卷。
//!  - `Pause` / `Resume`：PTT 互斥——长按按下瞬间让出麦克风，松手恢复。
//!    与总开关正交：Pause 期间开关仍是开的，Resume 才回哨兵。
//!  - 设备起流失败不放弃：记录后按 `REBUILD_EVERY` 重试（设备可能只是暂时被占）。

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

/// 播报期语音打断的总开关（施工单 M33-03）。
///
/// 关掉即回到 M25-03 的行为（播报期整段丢帧，语音打不断）。
/// 端上偏好，跨重启保持；界面在 M33-05。默认**开**——
/// 它修的是一条至今不成立的验收标准（AC-45-6），默认关等于没做。
pub static BARGE_IN_ENABLED: AtomicBool = AtomicBool::new(true);

/// 约束 1 的降级位（施工单 M33-03）：窄通道只放行**喊了名字**的段。
///
/// 真机实测若发现回采比对挡不住（挡住率 < 90% 或误判 > 0），把它打开——
/// 代价是打断要说「暖暖，停」而不是「停」，但暖暖不会被自己的话打断。
/// 默认关：主方案先跑，实测说话再改默认值，**并把改动写进验收**。
pub static BARGE_IN_REQUIRE_WAKE: AtomicBool = AtomicBool::new(false);

/// 哨兵监听总开关（施工单 M60-01，F-52-01）。
///
/// # 为什么默认是关
///
/// 它决定"这台设备平时开不开着麦克风"。常驻监听是隐私上最重的一个默认值——
/// 一个用户没点过头就一直在听的麦克风，即使转写未命中即弃，也不该是开箱状态。
/// M25-01～M33 期间它恒为开（循环里写死 `switch_on = true`），因为那时它还没有
/// 任何界面入口，关掉就等于这条链路整个不存在；M60-01 补上了两端设置页的开关，
/// 默认值随之翻成关。
///
/// # 与 `sentinel_start` 的分界
///
/// 关着的时候哨兵**线程照常在跑，但不建 cpal 流**——麦克风不被占用（`SetSwitch(false)`
/// 的既有语义，见 [`sentinel_loop`] 的起停流那一段）。线程留着是为了
/// `voice:sentinel` 指示事件仍然有来源：不然 HUD 的麦克风图标与设置页的开关
/// 会因为"没有事件"而整个不渲染，用户看到的是功能消失而不是功能关着。
///
/// 跨重启保持（`sentinel-pref` 文件），载入在 `commands::prefs::load_sentinel_pref`。
pub static SENTINEL_ENABLED: AtomicBool = AtomicBool::new(false);

/// 播报期放行的最短段（毫秒）。见发送处的说明。
const MIN_BARGE_IN_SEGMENT_MS: u32 = 300;

/// 段与播报的时间重叠判定的余量（走查 2026-08-29 ④）。
///
/// 段的"播报期"标记不能取**收尾那一刻**的 `TTS_PLAYING`：VAD 要 750ms 静音
/// 才收段，播报最后一句的段必然在播报结束之后才收尾——瞬时值恒为 false，
/// 于是回采走了正常路径、绕过回声过滤，又恰好落进播完即开的追问窗口，
/// 直接成了"用户说的话"（实测就是截图里那串自问自答）。
/// 改成时间重叠：段覆盖 [收尾 - 时长, 收尾]，最近一次"在播"落在这个区间
/// （放宽本余量，盖住收尾静音与预卷）就算播报期的段。
/// 余量往大放（多判成播报期）符合 echo.rs 的取向：宁可漏，不可误。
const TTS_OVERLAP_MARGIN_MS: u64 = 1_000;
const REBUILD_EVERY: Duration = Duration::from_secs(3);

/// TTS 正在出声（施工单 M25-03，M33-03 改语义）。
///
/// # M25-03～M33-02：丢帧不丢流
///
/// 播报期间麦克风保持打开（起停 cpal 流的抖动比丢几帧贵得多），但采到的一律丢弃、
/// 在录段与预卷清空——助手自己的声音不该被自己转写（M25-02 活体实测：
/// 播报会被回采成串转写调用，唤醒词闸门挡住了成环，但白烧 ASR）。
///
/// # M33-03 起：窄通道
///
/// 那条纪律换来的代价是 **AC-45-6「用户开口即停播」根本做不到**——
/// 车主冲着车喊「停」，系统物理上听不见。所以播报期改成：
/// **段照采照转写，但转写文本只喂打断判定**，其余就地丢弃
/// （AC-52-5 的丢弃纪律原样适用）。自采回环由 `voice::echo::is_echo`
/// 用"此刻正在播的那句原文"挡下来。
///
/// `SENTINEL_DEGRADED` 仍然是整段丢弃——对着坏端点持续上传只会积压。
///
/// 进程级单值：它描述的是"这台设备此刻在不在放助手的声音"，
/// 天然全局；tts 模块置位，哨兵循环消费。
pub static TTS_PLAYING: AtomicBool = AtomicBool::new(false);

/// 转写链路降级中（施工单 M25-04）：连续失败达阈值后由转写消费者置位，
/// 恢复探测成功后清除。降级期间哨兵丢帧不采段——对着坏端点持续上传
/// 只会积压；恢复探测由消费者用退避节奏做，不加独立心跳。
pub static SENTINEL_DEGRADED: AtomicBool = AtomicBool::new(false);

/// 哨兵此刻**有没有真的放开麦克风**（M39-02 真机实测补）。
///
/// # 为什么 `pause()` 不够
///
/// `SentinelHandle::send` 只是把命令塞进通道，哨兵循环 50ms 一拍
/// （[`POLL`]），下一拍才会 `handle.stop()` 真正释放设备。而
/// `commands/media.rs` 的长按在 `pause()` 之后**立刻**就起自己的流——
/// 中间这最长一拍里，两条 cpal 输入流同时存在。
///
/// macOS 允许两条输入流并存，所以这个竞态从 M25-01 埋下起一直没露过面；
/// **iOS 的 RemoteIO / AVAudioSession 是独占的**，晚到的那次 teardown
/// 会把长按刚建好的流一起带走——现场表现是"手指还按着，录音自己结束了"，
/// 而且时有时无（取决于按下的瞬间循环走到哪一拍）。
///
/// 由循环在每一拍末尾按 `active.is_none()` 如实置位：**它描述的是设备状态，
/// 不是命令是否已送达**——后者恰恰是不够用的那个。
pub static MIC_RELEASED: AtomicBool = AtomicBool::new(true);

/// 等哨兵真的放开麦克风。返回是否等到（`false` = 超时）。
///
/// **超时也要让调用方继续**：哨兵卡住时宁可冒一次并存的风险，也不能让长按
/// 变成按不动——那是把一个偶发缺陷换成一个必现缺陷。
pub fn wait_mic_released(timeout: Duration) -> bool {
    wait_flag(&MIC_RELEASED, timeout)
}

/// 轮询等一个标志置真。**参数化是为了可测**：两条测试各拿自己的
/// `AtomicBool`，不去碰进程级的 `MIC_RELEASED`——共用全局的话，
/// cargo 并行跑测试时它们会互相把对方的前置条件改掉（第一版就这么红的）。
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

/// 启动哨兵循环线程。段经 `segment_tx` 交给消费者（commands/voice.rs 的转写循环）；
/// 指示快照经 `indicate` 在状态变化时上报（F-52-06：UI 不得自己维护监听状态）。
pub fn spawn_sentinel(
    cfg: AssemblerConfig,
    segment_tx: SyncSender<(SentinelSegment, bool)>,
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

/// AEC 的消费侧状态（施工单 M47-02）。只在开关打开时构造。
///
/// 三件东西必须待在一起，缺一个另两个就没意义：消除器本体、
/// 把播放样本转成 16k 单声道的重采样器、以及取参考信号的队列口。
struct AecState {
    processor: carlife_media::AecProcessor,
    /// 播放侧格式与麦克风侧不同（mp3 常见 24k/44.1k，可能立体声），
    /// 各自需要一个重采样器。`None` = 还没收到 `Start`，即此刻没在播。
    render_converter: Option<StreamConverter>,
    rx: std::sync::mpsc::Receiver<crate::voice::aec_bridge::RenderMsg>,
}

impl AecState {
    /// 排空参考信号队列喂给消除器。
    ///
    /// **每一拍都要调，不管此刻在不在播报**：AEC3 的回声路径估计是持续过程，
    /// 断续投喂会让它反复重估。队列空时这就是一次 `try_recv` 的开销。
    fn drain_render(&mut self) {
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                crate::voice::aec_bridge::RenderMsg::Start { sample_rate, channels } => {
                    // 每段播报都重建：不同 TTS 响应的 mp3 采样率不一定相同，
                    // 沿用上一段的重采样器会让参考信号整体走音。
                    self.render_converter = Some(StreamConverter::new(sample_rate, channels));
                }
                crate::voice::aec_bridge::RenderMsg::Samples(batch) => {
                    let Some(conv) = self.render_converter.as_mut() else {
                        // 没收到 Start 就来了样本（队列满丢掉了 Start，或消费侧
                        // 刚接管）。丢掉这批而不是猜格式——猜错的参考信号
                        // 比没有参考信号更糟，它会让 AEC 去追一个不存在的回声。
                        continue;
                    };
                    for frame in conv.push(&batch) {
                        if let Err(e) = self.processor.feed_render(&frame) {
                            eprintln!("[aec] 参考帧喂入失败：{e}");
                        }
                    }
                }
            }
        }
    }
}

/// 当前时刻的指示快照——由循环内真实状态推导（listen.rs 纪律的延伸）。
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
    segment_tx: SyncSender<(SentinelSegment, bool)>,
    indicate: Box<dyn Fn(SentinelIndication) + Send>,
) {
    /*
     * 总开关的初值取自持久化偏好（M60-01），**不是写死的 true**。
     *
     * 这一行是"默认关"真正落地的地方：进程刚起、前端还没来得及 invoke 任何东西
     * 的那几百毫秒里，麦克风开不开由它决定。写死 true 再由前端补一条
     * `sentinel_set_switch(false)` 也能收敛，但中间那一段是真的在录音。
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

    /*
     * AEC（M47-02，ACR-010）——只在 CARLIFE_AEC_ENABLED=1 时构造。
     *
     * 开关关闭时这里是 None，后面所有 AEC 相关分支都早退，
     * 采集链与 M47 之前逐字节相同。
     *
     * 构造失败不影响监听：没有 AEC 只是回声消不掉（还有 echo.rs 那道文本防线），
     * 而哨兵起不来是"她彻底听不见了"。两者严重性差一个数量级。
     */
    let mut aec: Option<AecState> = if crate::voice::aec_bridge::enabled() {
        match (carlife_media::AecProcessor::new(), crate::voice::aec_bridge::take_receiver()) {
            (Ok(mut processor), Some(rx)) => {
                // 延迟提示按平台各存一份（M47-05）；两个平台当前都是 None＝自适应，
                // 真机实测出真值后填进 aec_bridge 的常量。桌面调参可用
                // CARLIFE_AEC_DELAY_MS 覆盖，免得每换一档就重编译。
                let delay = crate::voice::aec_bridge::stream_delay_ms();
                processor.set_stream_delay_ms(delay);
                // 起点读数：iOS 上有值，桌面是 None（那边逐档扫描即可，装机成本低）。
                let latency = carlife_media::audio_session::audio_latency();
                eprintln!(
                    "[aec] 哨兵侧已接管参考信号队列（延迟提示={}，系统往返读数={}）",
                    delay.map_or("自适应".to_string(), |d| format!("{d}ms")),
                    latency.map_or("不可用".to_string(), |l| format!("{:.1}ms", l.round_trip_ms()))
                );
                Some(AecState { processor, render_converter: None, rx })
            }
            (Err(e), _) => {
                eprintln!("[aec] 初始化失败，本次运行不做回声消除：{e}");
                None
            }
            (_, None) => {
                eprintln!("[aec] 参考信号队列已被取走（重复启动哨兵？），本次不做回声消除");
                None
            }
        }
    } else {
        None
    };
    // 观测节流：每 5s 打一行，否则 50ms 一拍会把日志淹了。
    let mut last_aec_log = Instant::now();
    // 最近一次观测到 TTS 在出声的时刻——段的"播报期"按时间重叠判，
    // 不取收尾瞬时值（TTS_OVERLAP_MARGIN_MS 处有完整因果链）。
    let mut last_tts_at: Option<Instant> = None;

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
                    return;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    if let Some(p) = active.take() {
                        p.handle.stop();
                    }
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
         * 此刻没有在播报——切类别会打断正在走的输出流，关掉语音唤醒不该顺带
         * 让暖暖那句话断在半截。播报中就等下一拍，`want_release` 留着。
         */
        if want_release && active.is_none() && !switch_on && !TTS_PLAYING.load(Ordering::Relaxed) {
            match carlife_media::release_recording_session() {
                Ok(true) => {
                    eprintln!("[sentinel] 已归还录音档位（系统麦克风指示应随之熄灭）");
                    want_release = false;
                }
                /*
                 * 没还成**不是失败**（2026-09-02 iPad 真机）：要么此刻有采集在进行
                 * （长按说话用的是另一条流，`active` 看不见它），要么档位本来就还着。
                 *
                 * 标志必须**留着**：清掉的话，长按一次之后这一拍的意愿就没了，
                 * 麦克风指示会一直亮到下次开关关闭——而"我说关了、系统说还在用"
                 * 正是 M60-02 要消灭的那个状态。留着则采集一结束的下一拍就还上。
                 *
                 * 这条分支不打日志：它每 50ms 一拍，打了就是 370 行/22 秒的噪声
                 * （那正是真机上抓到的现场）。
                 */
                Ok(false) => {}
                // 真失败也清标志：每拍重试会把日志刷满，而它不是能靠重试解决的错。
                Err(e) => {
                    eprintln!("[sentinel] 归还录音档位失败，系统麦克风指示可能还亮着：{e}");
                    want_release = false;
                }
            }
        }


        /*
         * 3) 丢帧模式的边沿处理（M25-03 定形，M33-03 收窄触发条件）。
         *
         * **只有降级才整段丢**。播报期改走窄通道（段照采，只喂打断判定）——
         * 不然 AC-45-6「用户开口即停播」物理上做不到。
         * 进入丢帧时清段清预卷，退出时恢复；用 assembler 的开关语义实现，
         * 不动 cpal 流——起停设备的抖动比丢帧贵。
         */
        let want_discard = SENTINEL_DEGRADED.load(Ordering::Relaxed)
            || (TTS_PLAYING.load(Ordering::Relaxed) && !BARGE_IN_ENABLED.load(Ordering::Relaxed));
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

        /*
         * 4.5) 排空参考信号队列（M47-02）。
         *
         * 放在消费采样**之前**：这一拍要对消的采集帧，其回声对应的是
         * 稍早播出去的声音，参考信号越早进 AEC3 越好。
         *
         * 放在 `active` 判空之前也是有意的——麦克风流没起来时播报照样在进行，
         * 那时若不排空，队列会一直满、Start 消息被丢掉，等流起来了
         * 第一段参考信号反而没有格式信息（见 drain_render 的 None 分支）。
         */
        if let Some(a) = aec.as_mut() {
            a.drain_render();

            if std::env::var("CARLIFE_SENTINEL_DEBUG").is_ok_and(|v| v == "1")
                && last_aec_log.elapsed() >= Duration::from_secs(5)
            {
                last_aec_log = Instant::now();
                let (fed, dropped) = crate::voice::aec_bridge::counters();
                // 调参就靠这行（M47-03/05）。`fed=0` 一眼分开"参考信号根本没接上"
                // 与"接上了但没消掉"——两者的下一步查法完全不同。
                eprintln!(
                    "[aec][debug] 已喂批次={fed} 丢弃={dropped} 播放中={} 帧长={}",
                    a.render_converter.is_some(),
                    a.processor.frame_samples()
                );
            }
        }

        // 5) 消费采样
        let Some(p) = active.as_mut() else {
            std::thread::sleep(POLL);
            continue;
        };
        match p.handle.data_rx.recv_timeout(POLL) {
            Ok(chunk) => {
                let tts_now = TTS_PLAYING.load(Ordering::Relaxed);
                if tts_now {
                    last_tts_at = Some(Instant::now());
                }
                if discarding {
                    continue; // 播报期间：读走（防积压）但全部丢弃
                }
                for mut frame in p.converter.push(&chunk) {
                    /*
                     * 声学回声消除（M47-02）——**全链路唯一的对消点**。
                     *
                     * 位置刻意在 VAD 分段（`assembler.push_frame`）之前：
                     * 回声本身会触发 VAD 开段，等分完段再消就晚了——
                     * 段已经因为她自己的声音被切出来了。
                     *
                     * 帧长天然对齐：converter 出的是 30ms@16k = 480 = 3 × 160。
                     * 对不齐时 `process_capture` 明确报错而不是默默处理一半
                     * （见 aec.rs 那个不对称的理由）。
                     *
                     * 失败只记一行、继续送原始帧：AEC 出问题不该让哨兵聋掉，
                     * echo.rs 的文本比对仍在后面兜着。
                     */
                    if let Some(a) = aec.as_mut() {
                        if let Err(e) = a.processor.process_capture(&mut frame) {
                            eprintln!("[aec] 采集帧对消失败，按原始帧继续：{e}");
                        }
                    }
                    if let Some(seg) = p.assembler.push_frame(&frame) {
                        /*
                         * "播报期的段" = 与播报有过**时间重叠**的段（走查 2026-08-29 ④），
                         * 不是收尾瞬间恰好在播的段——后者漏掉每次播报的最后一段，
                         * 因果链见 TTS_OVERLAP_MARGIN_MS。
                         */
                        let during_tts = tts_now
                            || last_tts_at.is_some_and(|t| {
                                t.elapsed()
                                    <= Duration::from_millis(
                                        u64::from(seg.duration_ms()) + TTS_OVERLAP_MARGIN_MS,
                                    )
                            });
                        /*
                         * 播报期的段时长下限（M33-03 约束 2/3 的节流位）。
                         *
                         * 播报期段会明显变密（麦克风里一直有声音），而通道容量是 8。
                         * 打断词最短的「停」也有 200ms 以上的有效语音，加上预卷够用；
                         * 短于此的多半是气口与噪声，送上去只是白烧 ASR 并把队列打满。
                         * **只在播报期设这道门**——正常监听那条路一个字都不动。
                         */
                        if during_tts && seg.duration_ms() < MIN_BARGE_IN_SEGMENT_MS {
                            continue;
                        }
                        // 满了丢段不丢循环：转写消费者卡住时哨兵不能死等
                        match segment_tx.try_send((seg, during_tts)) {
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
                // 采集线程没了（设备拔了/系统收走）：丢掉重建
                eprintln!("[sentinel] 采集流断开，将重建");
                active = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本单最核心的那个默认值（M60-01）。
    ///
    /// 静态量的初值就是"进程刚起、前端还没 invoke 任何东西时麦克风开不开"，
    /// 而 `sentinel_loop` 的 `switch_on` 直接读它。写死 true 的那一版
    /// （M25-01～M33）在这里会红。
    #[test]
    fn 哨兵默认关_常驻麦克风不该是开箱状态() {
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

    #[test]
    fn 等待期间被置真_能立刻收到() {
        use std::sync::Arc;
        let flag = Arc::new(AtomicBool::new(false));
        let setter = Arc::clone(&flag);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            setter.store(true, Ordering::Release);
        });
        assert!(wait_flag(&flag, Duration::from_millis(500)));
    }

    /// AEC 消费侧的消息协议（M47-02）。
    ///
    /// 测的是最容易错的那一环：**播放侧的采样率是不定的**（mp3 常见 24k/44.1k，
    /// 可能立体声），而 AEC 只吃 16k 单声道。搞错了不会崩，只会让参考信号走音、
    /// AEC 去追一个对不上的回声——现场表现是"开了 AEC 但没效果"，
    /// 而那时人只会怀疑延迟参数。
    #[test]
    fn aec消费侧按start重建重采样器并吃下样本() {
        use crate::voice::aec_bridge::RenderMsg;
        use std::sync::mpsc::sync_channel;

        let (tx, rx) = sync_channel::<RenderMsg>(8);
        let mut st = AecState {
            processor: carlife_media::AecProcessor::new().expect("APM 应能初始化"),
            render_converter: None,
            rx,
        };

        // 还没收到 Start 就来样本：安全丢弃，不猜格式（猜错比没有更糟）
        tx.send(RenderMsg::Samples(vec![0.1; 512])).expect("入队");
        st.drain_render();
        assert!(st.render_converter.is_none(), "没有 Start 时不该凭空建重采样器");

        // 收到 Start 后建重采样器，随后的样本被吃下（44.1k 立体声 → 16k 单声道）
        tx.send(RenderMsg::Start { sample_rate: 44_100, channels: 2 }).expect("入队");
        tx.send(RenderMsg::Samples(vec![0.2; 4096])).expect("入队");
        st.drain_render();
        assert!(st.render_converter.is_some(), "Start 应建立重采样器");

        // 换一段不同采样率的播报：必须重建，不能沿用上一段的
        tx.send(RenderMsg::Start { sample_rate: 24_000, channels: 1 }).expect("入队");
        tx.send(RenderMsg::Samples(vec![0.3; 2048])).expect("入队");
        st.drain_render();
        assert!(st.render_converter.is_some(), "换格式后仍应有可用的重采样器");
    }
}
