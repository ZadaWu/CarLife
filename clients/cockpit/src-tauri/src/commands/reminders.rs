//! 途中提醒的 Tauri 命令（施工单 M77-06 出声、M77-07 开关 / 密度 / 日志）。
//!
//! # 三件事，三种真相源
//!
//! - **出声**：`speak_reminder` 走 `tts::speak_reminder` 正门；本模块只在前面加一道
//!   "此刻该不该出声"的闸（总开关、密度档 × 提醒类别），闸是纯函数 [`reminder_allowed`]。
//! - **偏好**：开关与密度档的真相源是两个静态量（照 `sentinel::SENTINEL_ENABLED` 的形态），
//!   文件只在启动时读一次、每次改动落一次盘；改动同时发事件给前端，设置页与 HUD 据此同步——
//!   语音拨了档而界面不动，用户看到的是"我说了它没听"。
//! - **日志**：进 `carlife-telemetry` 的有界缓冲，**不上报**；「导出最近提醒记录」落到
//!   `app_data_dir/en-route-log.jsonl`。不发明上报端点（`carlife-telemetry` 文件头纪律）。

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;

use carlife_telemetry::{Event, Severity, TelemetryBuffer};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::tts::TtsState;

/// 前端订阅的三个事件名（与 `clients/cockpit/src/features/trip/en-route-prefs.ts` 一字不差）。
pub const EVENT_HUSHED: &str = "en-route-hushed";
pub const EVENT_DENSITY: &str = "en-route-density";
pub const EVENT_ENABLED: &str = "en-route-enabled";

/// 总开关。**默认开**——它是行程规划里"同行者约束"的落地，不是需要主动发现的增强。
pub static EN_ROUTE_ENABLED: AtomicBool = AtomicBool::new(true);
/// 密度档，存 [`Density`] 的 u8。默认适中。
pub static EN_ROUTE_DENSITY: AtomicU8 = AtomicU8::new(Density::Normal as u8);

/// 提醒密度三档（F-62-12）。`low` 只让安全类（连续驾驶）出声，停靠提前只出卡。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Density {
    High = 0,
    Normal = 1,
    Low = 2,
}

impl Density {
    /// 只认三个字面量；其它一律回落到**适中**——传错值时静默变成"不提醒"是最不该发生的那种默认。
    pub fn parse(s: &str) -> Option<Density> {
        match s.trim() {
            "high" => Some(Density::High),
            "normal" => Some(Density::Normal),
            "low" => Some(Density::Low),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Density::High => "high",
            Density::Normal => "normal",
            Density::Low => "low",
        }
    }
    fn from_u8(v: u8) -> Density {
        match v {
            0 => Density::High,
            2 => Density::Low,
            _ => Density::Normal,
        }
    }
    /// 「少提醒点」：往低一档，到底不动。
    pub fn lower(self) -> Density {
        match self {
            Density::High => Density::Normal,
            _ => Density::Low,
        }
    }
    /// 「多提醒点」：往高一档，到顶不动。
    pub fn higher(self) -> Density {
        match self {
            Density::Low => Density::Normal,
            _ => Density::High,
        }
    }
}

pub fn current_density() -> Density {
    Density::from_u8(EN_ROUTE_DENSITY.load(Ordering::Relaxed))
}

pub fn en_route_enabled() -> bool {
    EN_ROUTE_ENABLED.load(Ordering::Relaxed)
}

/// 此刻这一类提醒该不该出声（施工单 M77-07）。**纯函数**。
///
/// | 开关 | 档 | 类别 | 出声 |
/// |---|---|---|---|
/// | 关 | 任意 | 任意 | 否 |
/// | 开 | low | stop | 否（只卡片） |
/// | 开 | low | rest | 是（安全类不降级） |
/// | 开 | high / normal | 任意 | 是 |
pub fn reminder_allowed(enabled: bool, density: Density, kind: &str) -> bool {
    if !enabled {
        return false;
    }
    !(density == Density::Low && kind != "rest")
}

/// 偏好文件 → 开关。**缺省开**；文件损坏当缺省。
pub fn enabled_from_pref(content: Option<&str>) -> bool {
    match content {
        Some(c) => c.trim() != "off",
        None => true,
    }
}

/// 偏好文件 → 档。缺省 / 损坏都回**适中**。
pub fn density_from_pref(content: Option<&str>) -> Density {
    content.and_then(Density::parse).unwrap_or(Density::Normal)
}

/// 导出用：只取途中提醒的事件，一行一条 JSON。**不含用户内容**（写入时已 redact，事件名以 `en_route.` 开头）。
pub fn en_route_jsonl(events: &[Event]) -> String {
    let mut out = String::new();
    for e in events.iter().filter(|e| e.name.starts_with(EVENT_PREFIX)) {
        let line = serde_json::json!({
            "at_ms": e.at_ms as u64,
            "name": e.name,
            "detail": e.detail,
        });
        out.push_str(&line.to_string());
        out.push('\n');
    }
    out
}

const EVENT_PREFIX: &str = "en_route.";

fn enabled_pref_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("en-route-reminders-pref"))
}
fn density_pref_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("en-route-density-pref"))
}
fn log_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("en-route-log.jsonl"))
}

/// 开关的**唯一落点**：置静态量 → 落盘 → 通知前端。两个入口（设置页、将来的语音）都走它。
pub fn apply_en_route_enabled(app: &AppHandle, enabled: bool) {
    EN_ROUTE_ENABLED.store(enabled, Ordering::Relaxed);
    if let Some(path) = enabled_pref_path(app) {
        if let Err(e) = std::fs::write(&path, if enabled { "on" } else { "off" }) {
            eprintln!("[en-route] 提醒开关持久化失败: {e}");
        }
    }
    if let Err(e) = app.emit(EVENT_ENABLED, enabled) {
        eprintln!("[en-route] {EVENT_ENABLED} 事件发送失败：{e}");
    }
}

/// 密度档的**唯一落点**（设置页 / 语音口令两个入口）。
pub fn apply_en_route_density(app: &AppHandle, density: Density) {
    EN_ROUTE_DENSITY.store(density as u8, Ordering::Relaxed);
    if let Some(path) = density_pref_path(app) {
        if let Err(e) = std::fs::write(&path, density.as_str()) {
            eprintln!("[en-route] 提醒密度持久化失败: {e}");
        }
    }
    if let Err(e) = app.emit(EVENT_DENSITY, density.as_str()) {
        eprintln!("[en-route] {EVENT_DENSITY} 事件发送失败：{e}");
    }
}

/// 启动时载入（跨重启保持）。
pub fn load_en_route_prefs(app: &AppHandle) {
    let enabled = enabled_from_pref(
        enabled_pref_path(app).and_then(|p| std::fs::read_to_string(p).ok()).as_deref(),
    );
    let density = density_from_pref(
        density_pref_path(app).and_then(|p| std::fs::read_to_string(p).ok()).as_deref(),
    );
    EN_ROUTE_ENABLED.store(enabled, Ordering::Relaxed);
    EN_ROUTE_DENSITY.store(density as u8, Ordering::Relaxed);
    eprintln!(
        "[en-route] 途中提醒：{}，密度 {}（设置页「途中提醒」）",
        if enabled { "开" } else { "关" },
        density.as_str()
    );
}

// ── 命令 ────────────────────────────────────────────────────────────────

/// 播一句途中提醒。返回是否真的播了（被开关 / 密度档 / 正文挡下时 false，前端当只卡片）。
/// `kind` 是 "stop" / "rest"：low 档只放 rest。
#[tauri::command]
pub fn speak_reminder(app: AppHandle, state: State<'_, Arc<TtsState>>, text: String, kind: String) -> bool {
    if !reminder_allowed(en_route_enabled(), current_density(), &kind) {
        eprintln!("[en-route] 提醒 kind={kind} 被开关 / 密度档挡下（只卡片）");
        return false;
    }
    let ok = crate::tts::speak_reminder(&app, &state, &text);
    eprintln!("[en-route] 提醒 kind={kind} spoken={ok} text={text:?}");
    ok
}

/// 最近一次途中提醒的原文（「再说一遍」用）。
#[tauri::command]
pub fn last_reminder_text(state: State<'_, Arc<TtsState>>) -> Option<String> {
    state.last_reminder_text()
}

#[tauri::command]
pub fn get_en_route_reminders() -> bool {
    en_route_enabled()
}

#[tauri::command]
pub fn set_en_route_reminders(app: AppHandle, enabled: bool) -> bool {
    apply_en_route_enabled(&app, enabled);
    enabled
}

#[tauri::command]
pub fn get_en_route_density() -> String {
    current_density().as_str().into()
}

/// 传错值回落到适中（见 `Density::parse`）。返回实际落下的档。
#[tauri::command]
pub fn set_en_route_density(app: AppHandle, mode: String) -> String {
    let d = Density::parse(&mode).unwrap_or(Density::Normal);
    apply_en_route_density(&app, d);
    d.as_str().into()
}

/// 端侧判定日志（F-62-14）：前端每次判定（speak / defer / card-only）、口令、用户回应处调一次。
/// 进有界缓冲，写入时脱敏；**不上报**。
#[tauri::command]
pub fn log_en_route_event(telemetry: State<'_, Arc<TelemetryBuffer>>, name: String, detail: String) {
    telemetry.record(Severity::Info, &format!("{EVENT_PREFIX}{name}"), &detail);
}

/// 「导出最近提醒记录」：把缓冲里的途中提醒事件落成 jsonl，返回路径。
#[tauri::command]
pub fn export_en_route_log(app: AppHandle, telemetry: State<'_, Arc<TelemetryBuffer>>) -> Result<String, String> {
    let path = log_path(&app).ok_or_else(|| "没有应用数据目录".to_string())?;
    let body = en_route_jsonl(&telemetry.snapshot());
    std::fs::write(&path, body).map_err(|e| format!("写入失败：{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reminder_allowed_矩阵() {
        for d in [Density::High, Density::Normal, Density::Low] {
            assert!(!reminder_allowed(false, d, "stop"), "关着一律不播");
            assert!(!reminder_allowed(false, d, "rest"));
        }
        assert!(!reminder_allowed(true, Density::Low, "stop"), "low 档停靠只卡片");
        assert!(reminder_allowed(true, Density::Low, "rest"), "low 档安全类仍出声");
        assert!(reminder_allowed(true, Density::Normal, "stop"));
        assert!(reminder_allowed(true, Density::High, "stop"));
        assert!(reminder_allowed(true, Density::High, "rest"));
    }

    #[test]
    fn 密度档_解析与拨档() {
        assert_eq!(Density::parse("low"), Some(Density::Low));
        assert_eq!(Density::parse(" high\n"), Some(Density::High));
        assert_eq!(Density::parse("loud"), None);
        assert_eq!(Density::Low.lower(), Density::Low, "到底不动");
        assert_eq!(Density::High.higher(), Density::High, "到顶不动");
        assert_eq!(Density::Normal.lower(), Density::Low);
        assert_eq!(Density::Normal.higher(), Density::High);
        assert_eq!(Density::from_u8(7), Density::Normal, "静态量被写坏也回适中");
    }

    #[test]
    fn 偏好文件_缺省与损坏回默认() {
        assert!(enabled_from_pref(None), "缺省开");
        assert!(!enabled_from_pref(Some("off\n")));
        assert!(enabled_from_pref(Some("garbage")), "损坏当缺省");
        assert_eq!(density_from_pref(None), Density::Normal);
        assert_eq!(density_from_pref(Some("low")), Density::Low);
        assert_eq!(density_from_pref(Some("\u{0}\u{0}")), Density::Normal, "损坏回适中");
    }

    #[test]
    fn 导出只取途中提醒事件_一行一条() {
        let buf = TelemetryBuffer::new(8);
        buf.record(Severity::Info, "hud.state_changed", "idle");
        buf.record(Severity::Info, "en_route.gate", r#"{"kind":"stop","gate":"speak"}"#);
        buf.record(Severity::Info, "en_route.hush", "");
        let out = en_route_jsonl(&buf.snapshot());
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains(r#""name":"en_route.gate""#));
        assert!(lines[0].contains("at_ms"));
        assert!(lines[1].contains(r#""name":"en_route.hush""#));
        assert!(!out.contains("hud.state_changed"));
    }
}
