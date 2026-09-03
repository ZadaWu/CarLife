//! 语音桥接命令（施工单 M2-03，F-02-07）。
//!
//! `invoke`：`start_push_to_talk` / `stop_push_to_talk`；
//! `emit`：`voice:capture`（`CaptureStatus`，M2-01 契约）——桥接层只传状态，
//! **不传音频字节**（AC-02-2）。采集/编码在 carlife-media，上传在 carlife-net。
//!
//! 网关地址与 token 经设置层（`crate::settings`，env → 端上持久化 → 默认），
//! `session_id` 由前端随 stop 传入（会话引导在 M2-04/05 落地）。

use std::sync::Mutex;

use carlife_core::contract::{
    AudioMeta, CaptureFailed, CaptureMode, CaptureStarted, CaptureStatus, CaptureStopped,
};
use carlife_media::{encode_pcm_s16le, CaptureError, MicPermission, PttHandle};
use carlife_net::{AcceptedTurn, GatewayClient, NetError};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub const CAPTURE_EVENT: &str = carlife_core::fanout::EVENT_VOICE_CAPTURE;

pub(crate) fn gateway_client() -> GatewayClient {
    let (base, token) = crate::settings::gateway();
    GatewayClient::new(base, token)
}

/// 建会话（网络归 Rust 侧，§2.2 C2；WebView 不直接访问网关）。
///
/// # 车机模式下必须带上本次上车的声明（M54-05）
///
/// 车辆级 token 不代表任何人，`POST /v1/session` 没带 activeUserId 就是
/// 400 `active_user_required`。此前这里恒不带——于是「新建对话」按钮在
/// 车机上**永远失败**，而上车声明屏刚刚才问过一次"现在是谁在用车"。
///
/// 判据用 `bound_vin()` 而不是设备角色：真正决定服务端怎么裁的是
/// **手里这枚 token 是哪一种**，角色只是端上的显示状态，两者可能短暂不一致。
#[tauri::command]
pub async fn create_session() -> Result<String, String> {
    if carlife_core::auth::bound_vin().is_some() {
        let Some(declared) = crate::boarding::declared() else {
            // 没声明过就别去撞那个 400——它对用户毫无意义。
            return Err("尚未完成上车声明：请先选择现在是谁在用车".into());
        };
        return gateway_client()
            .create_session_as(Some(declared))
            .await
            .map(|s| s.session_id)
            .map_err(|e| e.to_string());
    }
    gateway_client()
        .create_session()
        .await
        .map(|s| s.session_id)
        .map_err(|e| e.to_string())
}

/// 结束这段对话（施工单 M22-03）——车主点了「退下」。
///
/// **软关闭**：服务端标记会话结束，`messages` 一条不删。端上随后建新会话，
/// 暖暖回到休息形象。服务端幂等，连点两次没有副作用。
#[tauri::command]
pub async fn close_session(session_id: String) -> Result<(), String> {
    gateway_client()
        .close_session(&session_id)
        .await
        .map_err(|e| e.to_string())
}

/// 发送一条文本消息（施工单 M3-07，F-03-09）。
///
/// 对话层的文字输入走这里——**全产品唯一输入框**，HUD 层没有输入框（US-01 AC-01-1）。
/// 与语音上行共用同一个网关端点，仅 content-type 不同。
#[tauri::command]
pub async fn send_text_message(
    app: AppHandle,
    session_id: String,
    content: String,
) -> Result<String, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("empty_content".into());
    }
    // 闲聊旁路开关随每条消息上行（M33-04）：端上关掉不算真关。
    gateway_client()
        .with_filler_enabled(crate::voice::filler_enabled_now(&app))
        .send_text(&session_id, trimmed, carlife_core::contract::MessageSource::Text)
        .await
        .map(|a| a.turn_id)
        .map_err(|e| e.to_string())
}

/// 采集会话的三态（2026-09-02 iPad 真机抓出的竞态）。
///
/// 原来这里是 `Option<PttHandle>`——只有「在录」与「不在录」两态，**没有「正在起流」**。
/// 而 iOS 上起流是秒级的（激活会话 + 建 AURemoteIO 单元），车主完全可能在它就绪之前松手：
/// 松手那一下 `stop` 去 `take()`，此刻句柄还没被存进来，于是它拿到 `None` 直接返回
/// `not_recording`；随后 `start` 把一个**再也没有人会去停**的录音器存了进去。
///
/// 现场（2026-09-02，iPad Pro 12.9 / iPadOS 26.5.2）：麦克风从此一直开着，
/// 之后每一次长按都被判 `already_recording`，而车主看到的只是
/// 「正在聆听」闪一下又回到「长按说话」。**这条错误此前还是静默的**，
/// 直到把失败原因显示到卡片上才被读出来。
#[derive(Default, Debug, PartialEq)]
pub enum Phase<H> {
    #[default]
    Idle,
    /// 起流中。`stop_requested` 记的是「还没起好就已经被松手了」。
    Starting {
        stop_requested: bool,
    },
    Recording(H),
}

/// 松手时拿到了什么。
#[derive(Debug, PartialEq)]
pub enum StopTake<H> {
    /// 正在录，句柄归你，去停它。
    Took(H),
    /// 还没起好就松手了：意愿已记下，收尾归 `settle_start`。
    CancelledBeforeReady,
    /// 本来就没在录。
    NotRecording,
}

/// 声明「我要起流了」。已经在起或在录时返回 false（调用方回 `already_recording`）。
pub fn claim_start<H>(phase: &mut Phase<H>) -> bool {
    match phase {
        Phase::Idle => {
            *phase = Phase::Starting { stop_requested: false };
            true
        }
        _ => false,
    }
}

/// 起流完成。返回 `Some(handle)` 表示**这段不入账**（起流期间已被松手取消，或状态异常），
/// 调用方必须把它停掉——这正是那个泄漏的堵口：不交回来就没人会停它。
pub fn settle_start<H>(phase: &mut Phase<H>, handle: H) -> Option<H> {
    match std::mem::replace(phase, Phase::Idle) {
        Phase::Starting { stop_requested: false } => {
            *phase = Phase::Recording(handle);
            None
        }
        _ => Some(handle),
    }
}

/// 松手。起流中就把取消意愿留在状态里，交给 `settle_start` 收尾。
pub fn take_for_stop<H>(phase: &mut Phase<H>) -> StopTake<H> {
    match std::mem::replace(phase, Phase::Idle) {
        Phase::Recording(h) => StopTake::Took(h),
        Phase::Starting { .. } => {
            *phase = Phase::Starting { stop_requested: true };
            StopTake::CancelledBeforeReady
        }
        Phase::Idle => StopTake::NotRecording,
    }
}

pub type VoicePhase = Phase<PttHandle>;

/// 当前采集会话（同一时刻至多一路）。
#[derive(Default)]
pub struct VoiceState(Mutex<VoicePhase>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopOutcome {
    pub turn_id: String,
    pub duration_ms: u32,
    pub truncated: bool,
    /// 仅在旧会话过期、Rust 侧收编新会话时返回；正常上传不改变前端会话。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// PTT 上行的有限恢复：过期只新建一个会话，并把同一段音频再送一次。
/// 网络错误与 5xx 的既有重试仍由 `GatewayClient::upload_audio` 负责。
async fn upload_with_session_recovery(
    gateway: &GatewayClient,
    session_id: &str,
    bytes: &[u8],
    meta: &AudioMeta,
) -> Result<(AcceptedTurn, Option<String>), NetError> {
    match gateway.upload_audio(session_id, bytes, meta).await {
        Ok(accepted) => Ok((accepted, None)),
        Err(NetError::SessionExpired) => {
            eprintln!("[cockpit] PTT 会话已过期，新建会话并重传一次");
            let created = gateway.create_session().await?;
            let accepted = gateway.upload_audio(&created.session_id, bytes, meta).await?;
            Ok((accepted, Some(created.session_id)))
        }
        Err(err) => Err(err),
    }
}

fn emit_status(app: &AppHandle, status: &CaptureStatus) {
    if let Err(e) = app.emit(CAPTURE_EVENT, status) {
        eprintln!("[cockpit] emit capture status failed: {e}");
    }
}

fn reason_of(err: &CaptureError) -> String {
    match err {
        CaptureError::NoDevice => "permission_denied_or_no_device".into(),
        /*
         * 细节要带出去（2026-09-02 iPad 排障）。
         *
         * 这一档盖着**三种完全不同的失败**：音频会话切不过去、拿不到默认输入配置、
         * cpal 建流失败。原来一律压成 `device_busy` 五个字，端上与日志都只看得到
         * 「设备忙」——真机上长按不出声时，谁都说不出是哪一步断的。
         * 前端只按 `permission_denied` 前缀分支，追加冒号后缀不影响既有判定。
         */
        CaptureError::DeviceUnavailable(msg) => format!("device_busy: {msg}"),
        CaptureError::AlreadyRecording => "already_recording".into(),
        CaptureError::NotRecording => "not_recording".into(),
        CaptureError::ThreadFailed => "capture_failed".into(),
    }
}

/// 系统麦克风授权现状："granted" / "denied" / "undetermined"。
/// 前端用它决定暖暖卡片要不要挂"麦克风未授权"的文字说明（走查 2026-08-29 ②）。
#[tauri::command]
pub fn mic_permission_status() -> String {
    carlife_media::mic_permission().as_str().into()
}

/// 长按前的权限门（走查 2026-08-29 ②）。
///
/// macOS 未授权时 CoreAudio **不报错、只给零样本**，等 cpal 报错等不到——
/// 空音频会一路送进 ASR 转出空文本，端上毫无反应。所以每次长按都先问系统：
///  - 没问过 → 弹系统授权框，等车主作答（阻塞放 blocking 池）；
///  - 拒绝过 → 系统不会再弹，把车主带去系统设置的麦克风页——
///    **每次长按都带**，这就是"再次尝试长按也能拉起授权"。
/// 申请麦克风授权，**不发采集事件**（M60-01）。
///
/// 与 [`ensure_mic_permission`] 的差别只在这一点上，而这一点是必要的：
/// 那个函数在被拒时 emit `CaptureStatus::Failed`，前端据此显示"录音失败"。
/// 哨兵开关是设置页的动作，不是一次录音——借用那条事件会让用户
/// 在设置页里看到一句莫名其妙的录音报错。
pub(crate) async fn acquire_mic_permission() -> bool {
    match carlife_media::mic_permission() {
        MicPermission::Granted => true,
        MicPermission::Undetermined => {
            tauri::async_runtime::spawn_blocking(carlife_media::request_mic_permission_blocking)
                .await
                .unwrap_or(false)
        }
        MicPermission::Denied => {
            // 系统层面已经拒过，App 内再问不会弹框——只能把用户送到设置页。
            carlife_media::open_mic_settings();
            false
        }
    }
}

async fn ensure_mic_permission(app: &AppHandle) -> Result<(), String> {
    let granted = match carlife_media::mic_permission() {
        MicPermission::Granted => true,
        MicPermission::Undetermined => {
            tauri::async_runtime::spawn_blocking(carlife_media::request_mic_permission_blocking)
                .await
                .map_err(|e| e.to_string())?
        }
        MicPermission::Denied => {
            carlife_media::open_mic_settings();
            false
        }
    };
    if granted {
        Ok(())
    } else {
        emit_status(
            app,
            &CaptureStatus::Failed(CaptureFailed { reason: "permission_denied".into() }),
        );
        Err("permission_denied".into())
    }
}

#[tauri::command]
pub async fn start_push_to_talk(
    app: AppHandle,
    state: State<'_, VoiceState>,
) -> Result<(), String> {
    /*
     * 先声明「我要起流了」（见 `VoicePhase`）。
     *
     * 占位必须在**起流之前**落下：起流是秒级的，这段时间里松手的那一下要能找到
     * 一个可以写「已经松手了」的地方，否则它只能什么都不做，然后 start 留下一个
     * 没人会停的录音器。
     */
    if !claim_start(&mut state.0.lock().expect("voice state poisoned")) {
        return Err("already_recording".into());
    }

    /// 任一步失败都要把占位清掉——留着它，这个 App 从此再也起不了流。
    fn clear_claim(state: &State<'_, VoiceState>) {
        *state.0.lock().expect("voice state poisoned") = Phase::Idle;
    }

    // 权限门在打断/哨兵互斥**之前**：没权限的长按不该打断她正在说的话。
    if let Err(e) = ensure_mic_permission(&app).await {
        clear_claim(&state);
        return Err(e);
    }

    /*
     * 打断（M2-05 定形，M33-02 补全）。
     *
     * 原来这里只有 `tts::stop`——**声音停了，服务端那一轮照跑**：delta 继续回、
     * turn_end 继续落库、垫场继续发，等车主问完新问题，旧答案的声音又追上来。
     * 现在走统一入口：停播 + 复位垫场槽位 + 取消服务端那一轮 + 记下这一轮。
     *
     * 位置不动：仍在 `sentinel.pause()` 之前。长按的既有时序（AC-52-8）一步不改。
     */
    crate::interrupt::interrupt_assistant(&app, crate::interrupt::InterruptSource::PushToTalk);

    /*
     * 哨兵互斥（M25-01）：长按期间让出麦克风；PTT 自身行为不变（AC-52-8）。
     *
     * **要等它真的让出来**（M39-02 真机实测补）。`pause()` 只是把命令塞进通道，
     * 哨兵循环 50ms 一拍才会真正 `stop()` 释放设备；原来这里不等就起流，
     * 中间那一拍两条 cpal 输入流并存——macOS 无所谓，**iOS 的 RemoteIO 独占**，
     * 晚到的 teardown 会把刚建好的流一起带走，现场是"手指还按着，录音自己结束了"。
     *
     * 超时上限刻意给得比一拍宽（200ms > POLL 50ms）：正常情况下第一次查询就返回，
     * 等不到也照常起流——哨兵卡住时宁可冒一次并存的风险，也不能让长按按不动。
     */
    if let Some(sentinel) = app.try_state::<super::voice::SentinelState>() {
        sentinel.pause();
        if !crate::voice::wait_mic_released(std::time::Duration::from_millis(200)) {
            eprintln!("[ptt] 等哨兵让出麦克风超时（200ms），照常起流");
        }
    }

    // PttHandle::start 阻塞至流就绪；放 blocking 池避免卡 async 运行时。
    let started = match tauri::async_runtime::spawn_blocking(PttHandle::start).await {
        Ok(v) => v,
        Err(e) => {
            clear_claim(&state);
            return Err(e.to_string());
        }
    };

    match started {
        Ok(handle) => {
            /*
             * 起好了，但车主可能**已经松手**（起流是秒级的，这正是那个竞态）。
             * `stop` 在这种情况下写下的是 `stop_requested`，这里据此二选一：
             * 入账继续录，或者当场停掉丢弃——绝不把一个没人会停的录音器留在状态里。
             */
            let leftover = settle_start(&mut state.0.lock().expect("voice state poisoned"), handle);
            if let Some(h) = leftover {
                // 手指早就离开了，这一段比手势还短，没有内容可上传：停掉、如实说一声。
                let _ = tauri::async_runtime::spawn_blocking(move || h.stop()).await;
                emit_status(
                    &app,
                    &CaptureStatus::Failed(CaptureFailed { reason: "cancelled_before_ready".into() }),
                );
                if let Some(sentinel) = app.try_state::<super::voice::SentinelState>() {
                    sentinel.resume();
                }
                return Err("cancelled_before_ready".into());
            }
            emit_status(&app, &CaptureStatus::Started(CaptureStarted { mode: CaptureMode::PushToTalk }));
            Ok(())
        }
        Err(err) => {
            clear_claim(&state);
            let reason = reason_of(&err);
            emit_status(&app, &CaptureStatus::Failed(CaptureFailed { reason: reason.clone() }));
            // 起流失败也要把哨兵放回来——否则一次 PTT 失败哨兵就永久哑了
            if let Some(sentinel) = app.try_state::<super::voice::SentinelState>() {
                sentinel.resume();
            }
            Err(reason)
        }
    }
}

#[tauri::command]
pub async fn stop_push_to_talk(
    app: AppHandle,
    state: State<'_, VoiceState>,
    session_id: String,
) -> Result<StopOutcome, String> {
    /*
     * 还没起好就松手时，**把取消意愿留在状态里**由 `start` 那一侧收尾——
     * 原来这里拿到 `None` 就直接走了，随后 start 存进来的录音器再也没有人停，
     * 那正是泄漏的入口（`Phase` 的文档记了现场）。
     */
    let handle = match take_for_stop(&mut state.0.lock().expect("voice state poisoned")) {
        StopTake::Took(h) => h,
        StopTake::CancelledBeforeReady => return Err("cancelled_before_ready".into()),
        StopTake::NotRecording => return Err("not_recording".into()),
    };

    // 停止（立即释放麦克风）+ 编码，均为阻塞工作。
    let encoded = tauri::async_runtime::spawn_blocking(move || {
        let capture = handle.stop()?;
        let duration_ms = capture.duration_ms();
        let truncated = capture.truncated;
        // 空/全零样本兜底（走查 2026-08-29 ②）：权限门失效的平台上（或设备
        // 静默失灵），未授权采集的表现就是全零——这样的段送进 ASR 只会转出
        // 空文本、端上毫无反应。在这里拦下并明说，别把空音频交给网关。
        let silent = carlife_media::is_silent_capture(&capture.samples);
        let (bytes, meta) =
            encode_pcm_s16le(&capture.samples, capture.sample_rate, capture.channels);
        Ok::<_, CaptureError>((bytes, meta, duration_ms, truncated, silent))
    })
    .await
    .map_err(|e| e.to_string())?;

    // 松手即恢复哨兵（M25-01 互斥的另一半）：麦克风此刻已释放（stop 在上面的
    // spawn_blocking 里完成），编码与上传不占设备，不必等它们跑完。
    if let Some(sentinel) = app.try_state::<super::voice::SentinelState>() {
        sentinel.resume();
    }

    let (bytes, meta, duration_ms, truncated, silent) = match encoded {
        Ok(v) => v,
        Err(err) => {
            let reason = reason_of(&err);
            emit_status(&app, &CaptureStatus::Failed(CaptureFailed { reason: reason.clone() }));
            return Err(reason);
        }
    };
    if silent {
        emit_status(&app, &CaptureStatus::Failed(CaptureFailed { reason: "empty_capture".into() }));
        return Err("empty_capture".into());
    }
    emit_status(&app, &CaptureStatus::Stopped(CaptureStopped { duration_ms }));

    emit_status(&app, &CaptureStatus::Uploading);
    // 同上：PTT 这条路也要带开关，否则"用语音关了旁路、按住说话仍然有垫场"。
    let gateway = gateway_client().with_filler_enabled(crate::voice::filler_enabled_now(&app));
    match upload_with_session_recovery(&gateway, &session_id, &bytes, &meta).await {
        Ok((accepted, adopted_session_id)) => {
            emit_status(&app, &CaptureStatus::Uploaded);
            Ok(StopOutcome {
                turn_id: accepted.turn_id,
                duration_ms,
                truncated,
                session_id: adopted_session_id,
            })
        }
        Err(err) => {
            eprintln!("[cockpit] upload failed session={session_id}: {err}");
            emit_status(&app, &CaptureStatus::Failed(CaptureFailed { reason: "upload_failed".into() }));
            Err("upload_failed".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn test_meta() -> AudioMeta {
        AudioMeta {
            duration_ms: 1_000,
            format: "pcm_s16le".into(),
            sample_rate_hz: 16_000,
            channels: 1,
        }
    }

    /// 按固定顺序模拟“旧会话拒绝 → 建会话 → 新会话受理”。
    fn spawn_recovery_stub() -> (String, mpsc::Receiver<String>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind recovery stub");
        let addr = listener.local_addr().expect("stub address");
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            let responses = [
                ("409 Conflict", r#"{"error":"session_expired"}"#),
                ("201 Created", r#"{"sessionId":"fresh-session"}"#),
                ("202 Accepted", r#"{"turnId":"turn-fresh"}"#),
            ];
            for (status_line, body) in responses {
                let (mut stream, _) = listener.accept().expect("accept recovery request");
                let mut reader = BufReader::new(stream.try_clone().expect("clone request"));
                let mut request_line = String::new();
                reader.read_line(&mut request_line).expect("read request line");
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).expect("read request headers");
                    if line.trim_end().is_empty() {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut payload = vec![0u8; content_length];
                reader.read_exact(&mut payload).expect("read request body");
                tx.send(request_line.trim().to_string()).expect("record request");

                let response = format!(
                    "HTTP/1.1 {status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).expect("write response");
            }
        });
        (format!("http://{addr}"), rx, handle)
    }

    /// [F-02-04][AC-02-2] 过期 PTT 会话只创建一次并重传同一段音频一次。
    #[test]
    fn expired_ptt_session_is_adopted_and_reuploaded_once() {
        let (base, rx, server) = spawn_recovery_stub();
        let client = GatewayClient::new(base, "demo-token");
        let result = tauri::async_runtime::block_on(upload_with_session_recovery(
            &client,
            "old-session",
            &[1, 2, 3],
            &test_meta(),
        ))
        .expect("PTT recovery should succeed");

        assert_eq!(result.0.turn_id, "turn-fresh");
        assert_eq!(result.1.as_deref(), Some("fresh-session"));
        let requests: Vec<_> = (0..3).map(|_| rx.recv().expect("request record")).collect();
        assert!(requests[0].starts_with("POST /v1/session/old-session/messages"));
        assert!(requests[1].starts_with("POST /v1/session HTTP/1.1"));
        assert!(requests[2].starts_with("POST /v1/session/fresh-session/messages"));
        assert!(rx.try_recv().is_err(), "过期恢复不应产生第四次请求");
        server.join().expect("recovery stub should exit");
    }
}

#[cfg(test)]
mod phase_tests {
    use super::{claim_start, settle_start, take_for_stop, Phase, StopTake};

    /// 用 u32 冒充句柄：这三条迁移与句柄是什么无关，而真 `PttHandle` 带着线程与通道，
    /// 在单测里造不出来。泛型化正是为了让这层逻辑能被单独钉住。
    type P = Phase<u32>;

    #[test]
    fn 起流期间松手不会留下没人停的录音器() {
        // 1) 正常一轮：起流 → 就绪 → 松手拿到句柄。
        let mut p: P = Phase::Idle;
        assert!(claim_start(&mut p));
        assert_eq!(settle_start(&mut p, 7), None, "没被取消就该入账，不交回句柄");
        assert_eq!(take_for_stop(&mut p), StopTake::Took(7));
        assert_eq!(p, Phase::Idle);

        // 2) **本次事故的形态**：起流还没完成就松手（比 0.9 秒短的长按）。
        let mut p: P = Phase::Idle;
        assert!(claim_start(&mut p));
        assert_eq!(take_for_stop(&mut p), StopTake::CancelledBeforeReady);
        assert_eq!(
            settle_start(&mut p, 9),
            Some(9),
            "句柄必须交回调用方去停——不交回来就是 2026-09-02 iPad 上那个泄漏：\
             麦克风一直开着，之后每一次长按都被判 already_recording",
        );
        assert_eq!(p, Phase::Idle, "取消之后必须回到 Idle，否则这个 App 再也起不了流");

        // 3) 取消之后还能再来一次（泄漏时这里是永久 already_recording）。
        assert!(claim_start(&mut p));
        assert_eq!(settle_start(&mut p, 11), None);

        // 4) 已经在录时不接受第二次起流；没在录时松手如实说。
        assert!(!claim_start(&mut p));
        assert_eq!(take_for_stop(&mut p), StopTake::Took(11));
        assert_eq!(take_for_stop(&mut p), StopTake::NotRecording);
    }
}
