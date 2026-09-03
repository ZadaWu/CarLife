//! 哨兵监听命令（施工单 M25-01，F-52-01）。
//!
//! `invoke`：`sentinel_start` / `sentinel_stop` / `sentinel_set_switch`。
//! 转写消费者是独立线程：段 → 网关只转写通道 → 文本交 `voice::on_transcript`
//! （唤醒词判定的挂点，M25-02 接管）。
//!
//! 隐私纪律（AC-52-5 的端上半边）：本模块**任何日志不含转写正文**——
//! 只有计数与长度。失败也只记错误类别。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::Mutex;
use std::time::Instant;

use carlife_core::contract::{SentinelIndication, WakeStatus};
use carlife_core::fanout::{EVENT_VOICE_SENTINEL, EVENT_VOICE_WAKE};
use carlife_media::{encode_mono16k_i16, AssemblerConfig, SentinelSegment};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::voice::sentinel::{spawn_sentinel, SentinelCommand, SentinelHandle, SENTINEL_DEGRADED};
use crate::voice::windows::{WakeWindows, WindowConfig, WindowKind};

/*
 * 降级闸（`DegradeGate`）已搬进 `carlife-voice`（M60-01）——手机端的哨兵
 * 用的是同一份阈值与退避节奏。判据两端各写一份会漂，而漂了的现象是
 * "手机上转写坏三次就聋、车上要坏五次"，没有任何报错说得清。
 */
use carlife_voice::DegradeGate;

/// 哨兵状态（Tauri managed）。计数器供验收与 §13-22 的误唤醒数据采集起步。
pub struct SentinelState {
    handle: Mutex<Option<SentinelHandle>>,
    /// 当前会话 id——前端是会话生命周期所有者，这里只是借用（M25-02）。
    /// 409 收编（M25-03）是唯一例外：Rust 新建后经 `SessionAdopted` 事件交还。
    session: Mutex<Option<String>>,
    /// 唤醒对话窗口（M25-03）：聆听/追问的一次性许可。
    windows: Mutex<WakeWindows>,
    pub transcribed: AtomicU64,
    pub failed: AtomicU64,
    /// 唤醒命中（含带指令与只喊名字）。
    pub woken: AtomicU64,
    /// 语音退下命中。
    pub dismissed: AtomicU64,
    /// 语音关闭 / 打开闲聊旁路命中（M33-04）。分开数：
    /// 只有关没有开，说明反向口令的说法没覆盖到车主真会说的那几句。
    pub sidecar_off: AtomicU64,
    pub sidecar_on: AtomicU64,
    /// 语音打断命中（M33-03）。
    pub interrupted: AtomicU64,
    /// 播报期被判为"这是暖暖自己的声音"而丢掉的段（M33-03）。
    ///
    /// **恒为 0 才是问题**：那说明回采过滤压根没生效，
    /// 而它没生效的表现是"她自己把自己打断了"。
    pub echo_filtered: AtomicU64,
    /// 未命中（§13-22 误唤醒率数据的分母起步）。
    pub missed: AtomicU64,
}

impl Default for SentinelState {
    fn default() -> Self {
        Self {
            handle: Mutex::new(None),
            session: Mutex::new(None),
            windows: Mutex::new(WakeWindows::new(WindowConfig::default())),
            transcribed: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            woken: AtomicU64::new(0),
            dismissed: AtomicU64::new(0),
            sidecar_off: AtomicU64::new(0),
            sidecar_on: AtomicU64::new(0),
            interrupted: AtomicU64::new(0),
            echo_filtered: AtomicU64::new(0),
            missed: AtomicU64::new(0),
        }
    }
}

impl SentinelState {
    pub fn bound_session(&self) -> Option<String> {
        self.session.lock().expect("sentinel session poisoned").clone()
    }

    pub fn bind(&self, session_id: Option<String>) {
        *self.session.lock().expect("sentinel session poisoned") = session_id;
    }

    pub fn open_listening(&self) {
        self.windows.lock().expect("wake windows poisoned").open_listening(Instant::now());
    }

    pub fn window_active(&self) -> Option<WindowKind> {
        self.windows.lock().expect("wake windows poisoned").active(Instant::now())
    }

    pub fn consume_window(&self) {
        self.windows.lock().expect("wake windows poisoned").consume();
    }

    pub fn clear_windows(&self) {
        self.windows.lock().expect("wake windows poisoned").clear();
    }

    /// PTT 互斥：长按按下让出麦克风（media.rs 调）。哨兵未启动时是空操作。
    pub fn pause(&self) {
        if let Some(h) = self.handle.lock().expect("sentinel state poisoned").as_ref() {
            h.send(SentinelCommand::Pause);
        }
    }

    /// PTT 松手恢复。
    pub fn resume(&self) {
        if let Some(h) = self.handle.lock().expect("sentinel state poisoned").as_ref() {
            h.send(SentinelCommand::Resume);
        }
    }

    /// 拨动总开关（M60-01）。哨兵未启动时是空操作——静态量已经由调用方置好，
    /// 下次 `sentinel_start` 起循环时会读到它（见 `sentinel_loop` 的初值那一行）。
    pub fn set_switch(&self, on: bool) {
        if let Some(h) = self.handle.lock().expect("sentinel state poisoned").as_ref() {
            h.send(SentinelCommand::SetSwitch(on));
        }
    }
}

/// 启动哨兵监听。已在跑返回 `false`（幂等，不重建）。
#[tauri::command]
pub async fn sentinel_start(app: AppHandle, state: State<'_, SentinelState>) -> Result<bool, String> {
    let mut guard = state.handle.lock().expect("sentinel state poisoned");
    if guard.is_some() {
        return Ok(false);
    }

    // 8 段缓冲：转写一段 1~2s，哨兵段最短也要几百 ms 才产得出来，够用
    // 段带一个"这段是不是播报期采到的"标志（M33-03）：**在生产时打**，
    // 不能等消费时再看 TTS_PLAYING —— 段产于播报中、消费在播报后是常态。
    let (segment_tx, segment_rx) = sync_channel::<(SentinelSegment, bool)>(8);
    let indicate_app = app.clone();
    let handle = spawn_sentinel(
        AssemblerConfig::default(),
        segment_tx,
        Box::new(move |ind: SentinelIndication| {
            if let Err(e) = indicate_app.emit(EVENT_VOICE_SENTINEL, &ind) {
                eprintln!("[sentinel] emit indication failed: {e}");
            }
        }),
    );
    guard.replace(handle);
    drop(guard);

    // 转写消费者：独立线程 + block_on（网关客户端是 async 的）。
    // recv 带超时：降级期间哨兵丢帧不产段，恢复探测的节拍靠这里的空转驱动。
    let consumer_app = app.clone();
    std::thread::spawn(move || {
        /*
         * 网关客户端**每次请求现构造**，不在循环外缓一个（M60-02，iPad 真机实测）。
         *
         * 原来这里是 `let gateway = gateway_client();` 提在循环外。`gateway_client()`
         * 读的是 `auth::access_token()`，而这个线程由 `sentinel_start` 在引导时启动
         * ——那一刻 token 往往还没就位（钥匙串恢复与首次刷新都是异步的），
         * `unwrap_or_default()` 给出空串，于是这个客户端**一辈子拿着空 token**。
         *
         * 现场是这样的（2026-09-02 网关日志，同一进程同一时刻）：
         *
         *     POST /v1/cabin/media/sink   by=车机:ELY1   status=200
         *     POST /v1/asr/transcribe     by=未鉴权       status=401
         *
         * 别的路都正常，只有哨兵这条 401。连败三次进降级，界面显示
         * "语音唤醒不可用（长按可用）"，而**恢复探测用的是同一个死客户端**，
         * 所以永远回不来——关掉开关再打开也没用，消费者线程只建一次。
         *
         * 每段现构造的代价是一个 reqwest::Client；段只在有人说话时才产出，
         * 探测按 15s 起步的退避走，这个频率下不值得为省它去缓一个会过期的东西。
         */
        let mut gate = DegradeGate::default();
        // 恢复探测负载：320ms 静音。只求端到端 200，不在乎转写出什么。
        let probe = encode_mono16k_i16(&vec![0i16; 5_120]);
        /*
         * 截断段的拼接缓存（走查 0830-③：「……广州的 4 天行程」只识别到「广州的」）。
         *
         * 段命中上限被强制收尾（truncated）时，车主往往还在说——尾巴会在
         * 静音重去抖之后自成一段到来。截断段**先缓一拍不分发**：等尾段转写
         * 回来拼成整句再走判定；STITCH_WINDOW 内没等到（车主恰好在上限处
         * 收口、或尾段转写失败）就把缓存的半句单独放行——半句也比整句蒸发好。
         * during_tts 取两段之或：头段压着播报尾音时整句都按重叠段判。
         */
        const STITCH_WINDOW: std::time::Duration = std::time::Duration::from_secs(6);
        let mut pending: Option<(String, bool, Instant)> = None;
        /*
         * 与播报重叠过的段走**窄通道判定**（M33-03，0830 放宽）：
         * 先滤回采；播报真在进行时其余只喂打断判定；播报已经
         * 结束的（段只是压着尾巴），非回采会被转回常规分发——
         * 紧跟播报开口的车主不该被丢（0830 实测：追问全灭）。
         */
        fn dispatch(app: &AppHandle, text: &str, during_tts: bool, truncated: bool, duration_ms: u32) {
            if during_tts {
                crate::voice::on_transcript_during_tts(app, text, truncated, duration_ms);
            } else {
                crate::voice::on_transcript(app, text, truncated, duration_ms);
            }
        }
        loop {
            let seg = match segment_rx.recv_timeout(std::time::Duration::from_secs(2)) {
                Ok(pair) => Some(pair),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let Some(state) = consumer_app.try_state::<SentinelState>() else { break };

            // 过期的截断缓存先冲洗（每个循环都查，不只在超时 tick）：
            // 缓存里那半句等不到尾巴了，单独放行，别让它无声蒸发。
            if pending.as_ref().is_some_and(|(_, _, at)| at.elapsed() > STITCH_WINDOW) {
                let (text, during, _) = pending.take().expect("pending checked above");
                eprintln!("[sentinel] 截断段等尾超时，按半句放行（chars={}）", text.chars().count());
                dispatch(&consumer_app, &text, during, true, 0);
            }

            match seg {
                Some((seg, during_tts)) => {
                    let duration_ms = seg.duration_ms();
                    let truncated = seg.truncated;
                    let (bytes, meta) = encode_mono16k_i16(&seg.samples);
                    match tauri::async_runtime::block_on(
                        super::media::gateway_client().transcribe_audio(&bytes, &meta),
                    ) {
                        Ok(t) => {
                            state.transcribed.fetch_add(1, Ordering::Relaxed);
                            if gate.on_success() {
                                sentinel_recovered(&consumer_app);
                            }
                            // 头段在缓存里就拼上（中文直接连写，不加分隔）。
                            let (text, during) = match pending.take() {
                                Some((head, head_during, _)) => {
                                    (format!("{head}{}", t.text), head_during || during_tts)
                                }
                                None => (t.text.clone(), during_tts),
                            };
                            if truncated {
                                pending = Some((text, during, Instant::now()));
                            } else {
                                dispatch(&consumer_app, &text, during, false, duration_ms);
                            }
                        }
                        Err(e) => {
                            state.failed.fetch_add(1, Ordering::Relaxed);
                            eprintln!("[sentinel] 转写失败（dur={duration_ms}ms）：{e}");
                            if gate.on_failure(Instant::now()) {
                                sentinel_degraded(&consumer_app);
                            }
                        }
                    }
                }
                None if gate.probe_due(Instant::now()) => {
                    match tauri::async_runtime::block_on(
                        super::media::gateway_client().transcribe_audio(&probe.0, &probe.1),
                    ) {
                        Ok(_) => {
                            if gate.on_success() {
                                sentinel_recovered(&consumer_app);
                            }
                        }
                        Err(_) => {
                            let _ = gate.on_failure(Instant::now());
                        }
                    }
                }
                None => {}
            }
        }
    });

    Ok(true)
}

/// 进入降级：置丢帧标志（哨兵停采）、广播状态、**一次**简短播报提示。
/// 频控是结构性的——`DegradeGate::on_failure` 只在进入沿返回 true。
fn sentinel_degraded(app: &AppHandle) {
    SENTINEL_DEGRADED.store(true, Ordering::SeqCst);
    emit_wake(app, &WakeStatus::SentinelDegraded { degraded: true });
    eprintln!("[sentinel] 转写链路连续失败，进入降级（退避探测中）");
    if let Some(tts) = app.try_state::<std::sync::Arc<crate::tts::TtsState>>() {
        crate::tts::speak(app, &tts, "语音唤醒暂时不可用，长按说话不受影响。");
    }
}

/// 恢复：静默复位（不出声——坏了要说，好了不用汇报）。
fn sentinel_recovered(app: &AppHandle) {
    SENTINEL_DEGRADED.store(false, Ordering::SeqCst);
    emit_wake(app, &WakeStatus::SentinelDegraded { degraded: false });
    eprintln!("[sentinel] 转写链路恢复，哨兵回位");
}

/// 停止哨兵监听（线程退出、麦克风释放）。未启动时是空操作。
#[tauri::command]
pub async fn sentinel_stop(state: State<'_, SentinelState>) -> Result<(), String> {
    if let Some(h) = state.handle.lock().expect("sentinel state poisoned").take() {
        h.shutdown();
    }
    Ok(())
}

/// 绑定当前会话（施工单 M25-02）。前端在 bootstrap / 新建会话后调用；
/// 唤醒指令与语音退下经它找到"现在这段对话"。传 null 解绑。
#[tauri::command]
pub async fn sentinel_bind_session(
    state: State<'_, SentinelState>,
    session_id: Option<String>,
) -> Result<(), String> {
    state.bind(session_id);
    Ok(())
}

/// 窗口参数热改（施工单 M25-03，F-52-07）：聆听/追问时长，毫秒。
/// 立即生效，不落盘——跨启动默认值回到代码常量（持久化归后续偏好面）。
#[tauri::command]
pub async fn sentinel_set_windows(
    state: State<'_, SentinelState>,
    listening_ms: u64,
    followup_ms: u64,
) -> Result<(), String> {
    if listening_ms == 0 || followup_ms == 0 {
        return Err("window_ms_must_be_positive".into());
    }
    state
        .windows
        .lock()
        .expect("wake windows poisoned")
        .set_config(WindowConfig { listening_ms, followup_ms });
    Ok(())
}

/// 唤醒事件出口（M25-03）。事件只有状态事实，没有转写文本。
pub fn emit_wake(app: &AppHandle, status: &WakeStatus) {
    if let Err(e) = app.emit(EVENT_VOICE_WAKE, status) {
        eprintln!("[sentinel] emit wake status failed: {e}");
    }
}

/// TTS 播放自然结束（tts 模块回调，仅正文播报）：
/// 开追问窗口（聆听窗口开着则重新起算），并广播窗口事件。
pub fn on_tts_finished(app: &AppHandle) {
    let Some(state) = app.try_state::<SentinelState>() else { return };
    let mut windows = state.windows.lock().expect("wake windows poisoned");
    let listening_armed = windows.active(Instant::now()) == Some(WindowKind::Listening);
    windows.on_tts_finished(Instant::now());
    drop(windows);
    emit_wake(
        app,
        &(if listening_armed {
            WakeStatus::ListeningWindow { open: true }
        } else {
            WakeStatus::FollowupWindow { open: true }
        }),
    );
}

/// 麦克风总开关（F-02-08 语义）：关闭时哨兵停采、丢在录段、清预卷。
/// 与 `sentinel_stop` 的差别：开关是**用户意图**（跨启动保持），
/// stop 是进程生命周期管理。
///
/// M60-01 起它**落盘**：HUD 的麦克风图标与设置页的「语音唤醒」是同一个开关，
/// 在哪边拨都一样、都跨重启。此前它只改内存，于是"在 HUD 关掉麦克风、
/// 重启又自己开着"——那是个看起来像失灵的开关。
#[tauri::command]
pub async fn sentinel_set_switch(app: AppHandle, on: bool) -> Result<(), String> {
    // 打开时同样要过麦克风授权那道门（M60-01）——两个入口拨的是同一个开关，
    // 只有一个入口挡授权的话，从没挡的那个打开就会得到一个"开着但不工作"的状态。
    if on && !crate::commands::media::acquire_mic_permission().await {
        return Err("permission_denied".into());
    }
    crate::commands::prefs::apply_sentinel_enabled(&app, on);
    Ok(())
}
