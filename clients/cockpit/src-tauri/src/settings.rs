//! 网关连接设置（ACR-004 第 3 步）。
//!
//! # 为什么要有这一层
//!
//! 桌面开发机上网关地址来自环境变量（`.env` 经 `dev_env` 载入），而 **iOS 没有
//! 环境变量**——App 由 Swift 壳拉起，`.env` 不存在，`localhost` 指向 iPad 自己。
//! 不给运行时配置，iPad 版就永远连不上 Mac Studio 上的网关，且症状只是
//! "所有数据都是空的"，离根因很远。
//!
//! # 取值顺序：端上持久化 → env → 默认值
//!
//! **端上设置页最优先：用户在这台车机上配了什么，这台车机就走什么。**
//! 2026-09-01 之前排的是反过来的（env 压住端上设置），理由是"开发机改了 `.env`
//! 不该被三个月前存的端上配置压住"。那条理由在真实使用里换来了更坏的一种：
//! 设置页把生产网关填进去、点了「保存并重新连接」，**流量却仍然走 `.env` 里的
//! localhost:8790**——对话出现在本地控制台而不是生产控制台，而设置页上明明
//! 写着刚存的地址。一个能填、能存、能回显却不生效的输入框，比没有这个框更坏。
//!
//! 原来那条顾虑改用**启动横幅**兜住（见 [`init`]）：端上配置压住 env 时，
//! 启动日志上直说"环境变量没生效、以端上为准、清空那一栏可回到环境变量"。
//! 想回到 `.env` 的语义，把设置页的地址栏清空即可（存 `None` = 没配过）。
//!
//! # 与 M3-02 配置注册表的分界
//!
//! 注册表放的是"后台管理员改的运维项"，经网关下发——而**本设置就是
//! "网关在哪"**，它逻辑上必须先于一切网关通信存在，不可能从网关下发。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// 默认网关。**8790 是网关的真实端口**（`dev:status` 的 gateway 行）——
/// 此前各调用点写的 8787 是个从没被踩到的错默认值：桌面恒有 `.env` 兜着，
/// 它只在"env 缺席"时暴露，而那正是 iOS 的常态。本次一并修正。
const DEFAULT_GATEWAY: &str = "http://localhost:8790";

/// 环境变量名（只此一处，`env_url` 与启动横幅共用）。
const ENV_KEY: &str = "CARLIFE_GATEWAY_URL";

/// 端上持久化的那一份（JSON，`None` = 用户没改过、走默认）。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct StoredGateway {
    pub gateway_url: Option<String>,
    pub demo_token: Option<String>,
}

/// 生效地址的来源。设置页要如实显示"你配的到底有没有在用"——
/// 这是上一版那个"存了但不生效"故障唯一说得清的地方。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UrlSource {
    /// 端上设置页存的那一份（优先级最高）。
    Stored,
    /// 环境变量 `CARLIFE_GATEWAY_URL`（开发机 `.env`）。
    Env,
    /// 内置默认值。
    Default,
}

struct Inner {
    path: Option<PathBuf>,
    stored: StoredGateway,
}

static STATE: OnceLock<Mutex<Inner>> = OnceLock::new();

fn state() -> &'static Mutex<Inner> {
    STATE.get_or_init(|| Mutex::new(Inner { path: None, stored: StoredGateway::default() }))
}

/// 启动时绑定持久化路径并载入（`lib.rs` 的 setup 里调，与 TTS 偏好同一时机）。
/// 文件损坏按"没配过"处理——设置页还能救，启动崩溃就什么都救不了。
pub fn init(path: PathBuf) {
    let stored = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    {
        let mut guard = state().lock().expect("settings poisoned");
        guard.path = Some(path);
        guard.stored = stored;
    }
    /*
     * 启动横幅：地址来自哪里，一行说清。
     *
     * 它替代的是旧的"env 优先"——那条规则本是为了防"改了 `.env` 不生效"，
     * 代价却是"设置页存了不生效"。现在端上优先，同一类困惑改由这行日志兜：
     * 端上压住 env 时明说环境变量没生效，以及怎么回到它。
     */
    let (url, source) = effective_url();
    eprintln!("[gateway] 生效地址 {url}（来源：{}）", source_label(source));
    if source == UrlSource::Stored {
        if let Some(env) = env_url() {
            if env != url {
                eprintln!(
                    "[gateway] ⚠️ 环境变量 {ENV_KEY}={env} 未生效——端上设置页配的是 {url}，\
                     以端上为准；要回到环境变量，请把设置页的「网关地址」清空后保存"
                );
            }
        }
    }
}

fn source_label(source: UrlSource) -> &'static str {
    match source {
        UrlSource::Stored => "端上设置页",
        UrlSource::Env => "环境变量 CARLIFE_GATEWAY_URL",
        UrlSource::Default => "内置默认",
    }
}

/// env 里那一份（空串按"没配"处理）。
fn env_url() -> Option<String> {
    std::env::var(ENV_KEY).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// 取值顺序的**全部逻辑**。纯函数：不读全局 state、不读 env，
/// 于是能被并行的单测直接钉住——顺序错了的症状（"配了不生效"）离根因太远，
/// 不能只靠跑一遍 App 来发现。
fn resolve_url(stored: Option<String>, env: Option<String>) -> (String, UrlSource) {
    let clean = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(url) = clean(stored) {
        return (url, UrlSource::Stored);
    }
    if let Some(url) = clean(env) {
        return (url, UrlSource::Env);
    }
    (DEFAULT_GATEWAY.to_string(), UrlSource::Default)
}

/// 此刻生效的地址与它的来源。
pub fn effective_url() -> (String, UrlSource) {
    let stored = state().lock().expect("settings poisoned").stored.gateway_url.clone();
    resolve_url(stored, env_url())
}

/// 生效的 (网关地址, token)。所有要连网关的调用点都从这里拿，
/// **不再各自读 env**——取值顺序见文件头。
pub fn gateway() -> (String, String) {
    let (url, _) = effective_url();
    /*
     * M48-02：token 不再来自 env / 持久化的固定值（那是 demo-token 时代），
     * 而是**登录后由 `carlife_core::auth` 持有的 access token**。
     * 未登录时给空串：请求会被网关 401，端上据此进登录流程——
     * 这里不能塞一个假 token 蒙混，那只会把"没登录"伪装成"服务端有问题"。
     *
     * `stored.demo_token` 字段保留但不再参与取值：老版本存过的值留在文件里无害，
     * 删字段要动持久化结构（读旧文件会失败），不值当。
     */
    let token = carlife_core::auth::access_token().unwrap_or_default();
    (url, token)
}

/// 端上存的那份原样（设置页回显用——回显生效值会把 env 的值当成"用户改过的"存回去）。
pub fn stored() -> StoredGateway {
    state().lock().expect("settings poisoned").stored.clone()
}

/// 写入并持久化。`None` = 清除该项（回到 env / 默认）。
pub fn set(gateway_url: Option<String>, demo_token: Option<String>) -> Result<(), String> {
    let norm = |v: Option<String>| v.map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty());
    let mut guard = state().lock().expect("settings poisoned");
    guard.stored = StoredGateway { gateway_url: norm(gateway_url), demo_token: norm(demo_token) };
    let Some(path) = guard.path.clone() else {
        return Err("设置尚未初始化（无持久化路径）".into());
    };
    let json = serde_json::to_string_pretty(&guard.stored).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("写入设置失败: {e}"))
}

// ── Tauri 命令（设置页的读写口） ─────────────────────────────

/// 设置页视图。token **只回显"配没配过"**，不回显值——
/// 它会出现在 WebView 的 JS 堆里，正式软件不把凭证摆在那。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySettingsView {
    /// 此刻生效的网关地址（端上持久化 / env / 默认的合成结果）。
    pub effective_url: String,
    /// 端上存的那份（没存过 = None）。
    pub stored_url: Option<String>,
    pub stored_token_set: bool,
    /// 生效地址来自哪一层。设置页据此告诉用户"你配的正在生效 / 你没配过"。
    pub source: UrlSource,
    /// env 里那份（有没有、是什么）。端上配置压住它时要如实说出被压住的是谁，
    /// 否则开发机上"改了 .env 没反应"又会变成一次无从下手的排查。
    pub env_url: Option<String>,
    /// "ios" / "macos"——前端靠它决定首启要不要弹引导（iOS 默认 localhost 必错）。
    pub platform: &'static str,
}

fn view() -> GatewaySettingsView {
    let (effective_url, source) = effective_url();
    let stored = stored();
    GatewaySettingsView {
        effective_url,
        stored_url: stored.gateway_url,
        stored_token_set: stored.demo_token.is_some(),
        source,
        env_url: env_url(),
        platform: std::env::consts::OS,
    }
}

#[tauri::command]
pub fn get_gateway_settings() -> GatewaySettingsView {
    view()
}

/// 保存网关设置。**token 传 None = 保持现状**（设置页不回显值，自然也不该
/// 因为"输入框是空的"就把存过的 token 清掉）；要清空传空串。
#[tauri::command]
pub fn set_gateway_settings(
    gateway_url: Option<String>,
    demo_token: Option<String>,
) -> Result<GatewaySettingsView, String> {
    let keep_token = stored().demo_token;
    let token = match demo_token {
        None => keep_token,
        Some(t) if t.trim().is_empty() => None,
        Some(t) => Some(t),
    };
    set(gateway_url, token)?;
    Ok(view())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 取值顺序是本模块的全部契约；顺序错了的症状（"配了不生效"）离根因很远。
    #[test]
    fn 默认值是网关真实端口() {
        // 不动全局 state 也不碰 env：只验常量——8787 那个错默认值不许回来。
        assert_eq!(DEFAULT_GATEWAY, "http://localhost:8790");
    }

    /// 本次修复的核心断言：**端上配了就走端上的**，哪怕 env 也在。
    /// 反过来那版的故障形态是"设置页存了生产地址、流量仍打 .env 的 localhost"。
    #[test]
    fn 端上配置压过环境变量() {
        let (url, src) = resolve_url(
            Some("https://gw.example.com".into()),
            Some("http://localhost:8790".into()),
        );
        assert_eq!(url, "https://gw.example.com");
        assert_eq!(src, UrlSource::Stored);
    }

    #[test]
    fn 没配过才回落环境变量再回落默认() {
        let (url, src) = resolve_url(None, Some("http://localhost:8790".into()));
        assert_eq!((url.as_str(), src), ("http://localhost:8790", UrlSource::Env));

        // 空串 / 纯空白都算"没配"——它们只可能来自误操作，不该变成一个连不上的地址。
        let (url, src) = resolve_url(Some("  ".into()), Some("  ".into()));
        assert_eq!((url.as_str(), src), (DEFAULT_GATEWAY, UrlSource::Default));
    }

    #[test]
    fn 规范化剥掉尾斜杠与空白() {
        let path = std::env::temp_dir().join(format!("carlife-settings-test-{}.json", std::process::id()));
        init(path.clone());
        set(Some("  http://192.168.50.67:8790/  ".into()), None).unwrap();
        assert_eq!(stored().gateway_url.as_deref(), Some("http://192.168.50.67:8790"));
        // 空串 = 清除，不是存一个空地址
        set(Some("   ".into()), None).unwrap();
        assert_eq!(stored().gateway_url, None);
        let _ = std::fs::remove_file(path);
    }
}
