//! 端上用户偏好（施工单 M3-07，承接 M2-06 F-02-12）。
//!
//! 只放**用户偏好**：播报开关这类"这台车的主人怎么用"的选择。
//! 与运维配置（M3-02 的注册表）刻意分开——后者是"系统连哪里、用谁的 key"，
//! 由系统管理员在后台改；前者由车主在端上改，跨重启保持。

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::tts::TtsState;

/// 读取播报开关（true = 播报开启）。
#[tauri::command]
pub fn get_broadcast_enabled(state: State<'_, Arc<TtsState>>) -> bool {
    !state.is_muted()
}

/// 设置播报开关；立即生效并持久化。关闭时停掉正在进行的播报。
#[tauri::command]
pub fn set_broadcast_enabled(app: AppHandle, state: State<'_, Arc<TtsState>>, enabled: bool) -> bool {
    state.set_muted(!enabled);
    if !enabled {
        // 关掉时正在播的那句也要停——否则"关了还在说"是最刺耳的 bug
        crate::tts::stop(&state);
        let _ = app.emit_assistant_idle();
    }
    enabled
}

/// 读取垫场话开关（true = 垫场开启）。M18-05，F-45-13。
#[tauri::command]
pub fn get_filler_enabled(state: State<'_, Arc<TtsState>>) -> bool {
    !state.is_filler_muted()
}

/// 设置垫场话开关；立即生效并持久化。
///
/// 与播报总开关**分开**：用户可能要正文播报但不要垫场。
/// 关掉时正在播的那句垫场也要停——只停垫场，不碰正文（`stop_if_filler`）。
///
/// ⚠️ 这只是端上偏好。**服务端还要收到它才算真关**（`TurnInput.fillerEnabled`）：
/// 端上丢弃而服务端照产，判断逻辑仍在跑、指标仍在写，接 L1 后仍会烧钱。
/// 上行链路本单未接，见验收 §7。
#[tauri::command]
pub fn set_filler_enabled(state: State<'_, Arc<TtsState>>, enabled: bool) -> bool {
    state.set_filler_muted(!enabled);
    if !enabled {
        crate::tts::stop_if_filler(&state);
    }
    enabled
}

/// 读取「播报时可以出声打断」开关（施工单 M33-03，F-52-01）。
#[tauri::command]
pub fn get_barge_in_enabled() -> bool {
    crate::voice::sentinel::BARGE_IN_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// 设置「播报时可以出声打断」；立即生效并持久化。
///
/// 关掉 = 回到 M25-03 的行为：播报期哨兵整段丢帧，冲着车喊「停」听不见。
/// 留这个开关是因为回采过滤在极端环境（车内音量很大、扬声器离麦克风很近）
/// 可能不够稳——那时"她自己把自己打断"比"打不断"难受得多，
/// **给车主一条退路，而不是让他忍着**。
#[tauri::command]
pub fn set_barge_in_enabled(app: AppHandle, enabled: bool) -> bool {
    crate::voice::sentinel::BARGE_IN_ENABLED
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
    if let Some(path) = barge_in_prefs_path(&app) {
        if let Err(e) = std::fs::write(&path, if enabled { "on" } else { "off" }) {
            eprintln!("[voice] 打断偏好持久化失败: {e}");
        }
    }
    enabled
}

/// 启动时载入（跨重启保持）。文件不存在 = 默认开。
pub fn load_barge_in_pref(app: &AppHandle) {
    let Some(path) = barge_in_prefs_path(app) else { return };
    let enabled = std::fs::read_to_string(&path).map(|c| c.trim() != "off").unwrap_or(true);
    crate::voice::sentinel::BARGE_IN_ENABLED
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
}

/// 打断偏好文件。与另外三个偏好各存一个，理由同 `filler_prefs_path`。
pub fn barge_in_prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("barge-in-pref"))
}

// ── 哨兵监听（语音唤醒）总开关，M60-01 ─────────────────────────

/// 读取「哨兵监听」开关（true = 常驻监听开着，能听见「暖暖你好」）。
///
/// 真相源是 [`crate::voice::sentinel::SENTINEL_ENABLED`]，不是偏好文件——
/// 文件只在启动时读一次，之后语音/HUD/设置页都改这个静态量。
#[tauri::command]
pub fn get_sentinel_enabled() -> bool {
    crate::voice::sentinel::SENTINEL_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// 设置「哨兵监听」开关；立即生效并持久化。
///
/// 打开 = 麦克风常驻（VAD 分段 → 转写 → 唤醒词判定），车主说「暖暖你好」
/// 不用按任何按钮就能被听见；关闭 = 哨兵不建流，**麦克风不被占用**，
/// 长按说话（PTT）不受影响。
///
/// # 打开时先要到麦克风授权，**要不到就不打开**
///
/// 不挡这一道的话，开关会停在"开"而麦克风从来没打开过——车主对着车
/// 喊「暖暖」毫无反应，而设置页上白纸黑字写着已开启。一个开着却不工作的
/// 开关比一个关着的开关坏得多。要不到授权时返回 `permission_denied`，
/// 由界面回滚那个开关并说清原因。
#[tauri::command]
pub async fn set_sentinel_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    if enabled && !crate::commands::media::acquire_mic_permission().await {
        return Err("permission_denied".into());
    }
    apply_sentinel_enabled(&app, enabled);
    Ok(enabled)
}

/// 开关的**唯一落点**：置静态量 → 拨正在跑的哨兵 → 落盘。
///
/// 抽成函数是因为有两个入口（设置页的 `set_sentinel_enabled` 与 HUD 麦克风
/// 图标的 `sentinel_set_switch`），而它们必须做**同样的三件事**。少做一件的
/// 症状各不相同且都离根因很远：不置静态量 → 重启后循环读到旧值；
/// 不拨哨兵 → 界面已经变了但麦克风还开着；不落盘 → 关掉重启又自己开。
pub fn apply_sentinel_enabled(app: &AppHandle, enabled: bool) {
    use std::sync::atomic::Ordering;
    crate::voice::sentinel::SENTINEL_ENABLED.store(enabled, Ordering::Relaxed);
    if enabled {
        /*
         * 打开时清掉降级锁（M60-02）。
         *
         * 降级是"连败三次"锁上的，解锁靠消费者的退避探测（15s→120s）。
         * 而车主的动作语义很明确——**他就是在说"再试一次"**：让他对着一个
         * 写着"语音唤醒不可用"的界面等两分钟，跟没修没有区别。
         *
         * 只清这个原子量，不去动消费者线程里的 `DegradeGate`：清掉它哨兵就
         * 恢复采段了，而第一次转写成功会把那个 gate 整个复位（`on_success`）。
         * 链路真的还坏着的话，再连败三次自然会重新锁上——这正是该有的行为。
         */
        crate::voice::sentinel::SENTINEL_DEGRADED.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    if let Some(state) = app.try_state::<crate::commands::voice::SentinelState>() {
        state.set_switch(enabled);
    }
    if let Some(path) = sentinel_prefs_path(app) {
        if let Err(e) = std::fs::write(&path, if enabled { "on" } else { "off" }) {
            eprintln!("[sentinel] 监听开关持久化失败: {e}");
        }
    }
}

/// 启动时载入（跨重启保持）。**文件不存在 = 关**——与打断开关相反，
/// 理由见 `SENTINEL_ENABLED` 的文档：常驻麦克风不该是开箱默认。
pub fn load_sentinel_pref(app: &AppHandle) {
    let Some(path) = sentinel_prefs_path(app) else { return };
    let enabled = std::fs::read_to_string(&path).map(|c| c.trim() == "on").unwrap_or(false);
    crate::voice::sentinel::SENTINEL_ENABLED
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
    eprintln!("[sentinel] 监听开关：{}（设置页「语音唤醒」）", if enabled { "开" } else { "关" });
}

/// 哨兵监听开关的偏好文件。与另外几个各存一个，理由同 `filler_prefs_path`。
pub fn sentinel_prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("sentinel-pref"))
}

/// 读取垫场收尾方式（M18-06）。返回 "immediate" 或 "after_sentence"。
#[tauri::command]
pub fn get_filler_preempt_mode(state: State<'_, Arc<TtsState>>) -> String {
    match state.preempt_mode() {
        crate::tts::FillerPreemptMode::Immediate => "immediate".into(),
        crate::tts::FillerPreemptMode::AfterSentence => "after_sentence".into(),
    }
}

/// 设置垫场收尾方式；立即生效并持久化。
///
/// 只认这两个字面量，其它一律回落到**默认的衔接**——
/// 传错值时静默变成抢占，是最不该发生的那种默认。
#[tauri::command]
pub fn set_filler_preempt_mode(state: State<'_, Arc<TtsState>>, mode: String) -> String {
    let m = if mode == "immediate" {
        crate::tts::FillerPreemptMode::Immediate
    } else {
        crate::tts::FillerPreemptMode::AfterSentence
    };
    state.set_preempt_mode(m);
    match m {
        crate::tts::FillerPreemptMode::Immediate => "immediate".into(),
        crate::tts::FillerPreemptMode::AfterSentence => "after_sentence".into(),
    }
}

/// 关闭播报后把助手状态落回 idle（避免停在 speaking）。
trait EmitIdle {
    fn emit_assistant_idle(&self) -> Result<(), tauri::Error>;
}

impl EmitIdle for AppHandle {
    fn emit_assistant_idle(&self) -> Result<(), tauri::Error> {
        use tauri::Emitter;
        self.emit(
            carlife_core::fanout::EVENT_ASSISTANT_STATE,
            carlife_core::contract::AssistantState::Idle,
        )
    }
}

/// 供 setup 使用：偏好文件放在应用数据目录，与消息缓存同目录。
pub fn prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("broadcast-pref"))
}

/// 垫场话偏好文件（M18-05）。与播报开关分开存：两个开关语义不同，
/// 合成一个文件的话，以后想单独重置其中一个就没法做。
pub fn filler_prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("filler-pref"))
}

/// 垫场收尾方式的偏好文件（M18-06）。单独一个，理由同上。
pub fn filler_preempt_prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("filler-preempt-pref"))
}
