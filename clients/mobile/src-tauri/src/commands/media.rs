//! Push-to-talk 采集与上行（施工单 A3，对齐 M2-03）。
//!
//! # 原始音频不出 Rust 侧
//!
//! 采集、编码、上传全在这里；WebView 只拿到状态事件与结果句柄（AC-02-2）。
//! 把 PCM 交给 WebView 意味着任何一个前端依赖都能读到麦克风内容。
//!
//! # 与 cockpit 的差异
//!
//! cockpit 在长按开始时会先停 TTS 播报（播报中打断 → speaking 让位 listening）。
//! 手机端**当前没有本地 TTS**，故无此步；补 TTS 时要连这条一起加，
//! 否则会出现"一边播报一边录音"，录进去的是助手自己的声音。

use std::sync::Mutex;

use carlife_core::contract::{
    CaptureFailed, CaptureMode, CaptureStarted, CaptureStatus, CaptureStopped,
};
use carlife_core::fanout::EVENT_VOICE_CAPTURE;
use carlife_media::{encode_pcm_s16le, CaptureError, MicPermission, PttHandle};
use carlife_net::GatewayClient;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

fn gateway_client() -> GatewayClient {
    // env → 端上持久化 → 默认（`crate::settings` 文件头写了为什么是这个顺序）。
    // 以前这里直接读 env 并回落 8787——那个端口从来就是错的，只是桌面恒有 .env
    // 兜着，直到装上手机（env 缺席的常态）才暴露成"怎么都登录不上"。
    let (base_url, token) = crate::settings::gateway();
    GatewayClient::new(base_url, token)
}

fn emit_status(app: &AppHandle, status: &CaptureStatus) {
    if let Err(e) = app.emit(EVENT_VOICE_CAPTURE, status) {
        eprintln!("[mobile] emit capture status failed: {e}");
    }
}

/// 失败原因映射成稳定的短标识。
///
/// 直接把 `CaptureError` 的 Display 抛给前端会让文案随实现变动，
/// 而前端要按原因分支（没权限 → 引导设置页；设备占用 → 提示关掉别的 App）。
fn reason_of(err: &CaptureError) -> String {
    match err {
        // 系统层面「无输入设备」与「权限被拒」在多数平台上表现一致，
        // 合成一个原因而不是猜是哪种——前端的引导文案要同时覆盖两者。
        CaptureError::NoDevice => "permission_denied_or_no_device".into(),
        CaptureError::DeviceUnavailable(_) => "device_busy".into(),
        CaptureError::AlreadyRecording => "already_recording".into(),
        CaptureError::NotRecording => "not_recording".into(),
        CaptureError::ThreadFailed => "capture_failed".into(),
    }
}

#[derive(Default)]
pub struct VoiceState(Mutex<Option<PttHandle>>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopOutcome {
    pub turn_id: String,
    /// 与 `RawCapture::duration_ms()` 同宽（u32）；60s 上限下绰绰有余。
    pub duration_ms: u32,
    /// 是否因超过单条时长上限被截断（FL-02：60s）。
    pub truncated: bool,
}

/// 系统麦克风授权现状："granted" / "denied" / "undetermined"。
/// 前端用它决定暖暖要不要挂"麦克风未授权"的文字说明（走查 2026-08-29 ②）。
#[tauri::command]
pub fn mic_permission_status() -> String {
    carlife_media::mic_permission().as_str().into()
}

/// 长按前的权限门（走查 2026-08-29 ②，与 cockpit 同一套语义）。
///
/// macOS 未授权时 CoreAudio **不报错、只给零样本**：空音频送进 ASR 转出
/// 空文本，端上毫无反应。每次长按都先问系统——没问过就弹授权框；
/// 拒绝过系统不会再弹，改为带去系统设置的麦克风页（这就是"再次长按也能拉起授权"）。
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

/// 申请麦克风授权，**不发采集事件**。
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

#[tauri::command]
pub async fn start_push_to_talk(app: AppHandle, state: State<'_, VoiceState>) -> Result<(), String> {
    {
        let guard = state.0.lock().expect("voice state poisoned");
        // 已在录就直接拒绝，不是"重新开始"：后者会丢掉已录的部分，
        // 而用户按住不放的手感上完全看不出发生过这件事。
        if guard.is_some() {
            return Err("already_recording".into());
        }
    }

    ensure_mic_permission(&app).await?;

    // 用户开口即打断播报（M65-04；车机同样在长按起点停）。不停的话暖暖还在说，
    // 用户说的话与她的声音一起进麦克风。状态由长按流程自己接管，这里不发 idle。
    if let Some(tts) = app.try_state::<std::sync::Arc<carlife_tts::TtsState>>() {
        carlife_tts::stop(&tts);
    }

    /*
     * 哨兵让出麦克风（M60-01）。
     *
     * **要等它真的让出来**，不能只发命令：`pause()` 只是把命令塞进通道，
     * 哨兵循环 50ms 一拍才会释放设备，而下一行马上就起自己的流。
     * iOS 的 RemoteIO 是独占的——晚到的那次 teardown 会把长按刚建好的流
     * 一起带走，现场表现是"手指还按着，录音自己结束了"，且时有时无。
     * 超时也继续（见 `wait_mic_released` 的说明）。
     */
    if let Some(sentinel) = app.try_state::<crate::commands::voice::SentinelState>() {
        sentinel.pause();
        if !crate::voice::wait_mic_released(std::time::Duration::from_millis(200)) {
            eprintln!("[ptt] 哨兵未在 200ms 内放开麦克风，仍继续起流");
        }
    }

    // PttHandle::start 阻塞至流就绪；放 blocking 池避免卡 async 运行时。
    let started = tauri::async_runtime::spawn_blocking(PttHandle::start)
        .await
        .map_err(|e| e.to_string())?;

    match started {
        Ok(handle) => {
            state.0.lock().expect("voice state poisoned").replace(handle);
            emit_status(
                &app,
                &CaptureStatus::Started(CaptureStarted { mode: CaptureMode::PushToTalk }),
            );
            Ok(())
        }
        Err(err) => {
            let reason = reason_of(&err);
            emit_status(&app, &CaptureStatus::Failed(CaptureFailed { reason: reason.clone() }));
            // 起流失败也要把哨兵放回来——否则一次 PTT 失败哨兵就永久哑了
            if let Some(sentinel) = app.try_state::<crate::commands::voice::SentinelState>() {
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
    let handle = state
        .0
        .lock()
        .expect("voice state poisoned")
        .take()
        .ok_or_else(|| "not_recording".to_string())?;

    // 停止（立即释放麦克风）+ 编码，均为阻塞工作。
    // 先释放麦克风再编码：手机上麦克风被占着，来电与其它 App 都会受影响。
    let encoded = tauri::async_runtime::spawn_blocking(move || {
        let capture = handle.stop()?;
        let duration_ms = capture.duration_ms();
        let truncated = capture.truncated;
        // 空/全零样本兜底（走查 2026-08-29 ②）：未授权采集的表现就是全零，
        // 送进 ASR 只会转出空文本。在这里拦下并明说，别把空音频交给网关。
        let silent = carlife_media::is_silent_capture(&capture.samples);
        let (bytes, meta) = encode_pcm_s16le(&capture.samples, capture.sample_rate, capture.channels);
        Ok::<_, CaptureError>((bytes, meta, duration_ms, truncated, silent))
    })
    .await
    .map_err(|e| e.to_string())?;

    // 松手即恢复哨兵（M60-01 互斥的另一半）：麦克风此刻已释放（stop 在上面的
    // spawn_blocking 里完成），编码与上传不占设备，不必等它们跑完。
    if let Some(sentinel) = app.try_state::<crate::commands::voice::SentinelState>() {
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
    match gateway_client().upload_audio(&session_id, &bytes, &meta).await {
        Ok(accepted) => {
            emit_status(&app, &CaptureStatus::Uploaded);
            Ok(StopOutcome { turn_id: accepted.turn_id, duration_ms, truncated })
        }
        Err(err) => {
            eprintln!("[mobile] upload failed session={session_id}: {err}");
            emit_status(
                &app,
                &CaptureStatus::Failed(CaptureFailed { reason: "upload_failed".into() }),
            );
            Err("upload_failed".into())
        }
    }
}
