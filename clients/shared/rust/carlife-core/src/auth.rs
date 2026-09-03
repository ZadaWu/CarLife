//! 端上凭证持有（施工单 M48-02 / M49-02，FL-07 F-07-03，变更单 ACR-011）。
//!
//! # 凭证只走 Rust，不进 WebView
//!
//! access / refresh token 由本模块持有，**不进 WebView**。WebView 侧拿不到原始 token：
//! 它只能经 Tauri 命令问"登录了没""是谁"，真正带 `Authorization` 头的请求由 Rust 侧发
//! （§2.2 C2 网络在 Rust 侧）。这条断言不因换存储而松动。
//!
//! # 存哪：操作系统的凭证库，两个角色两条独立条目
//!
//! M48-02 时只有内存态（那时引依赖还没过 ACR），代价是**重启即掉登录**——
//! 车一断电，下次上车第一件事是在方向盘后面输密码，而 FL-07 F-07-02 设计的
//! 14 天 refresh 有效期在内存态下等于 0。ACR-011 通过后换成：
//!
//!  - 内存缓存（快）+ 操作系统凭证库（久），写入两处、读取先内存后凭证库；
//!  - **按 [`DeviceRole`] 分键**：`credentials.personal` / `credentials.cockpit`。
//!    与 [`crate::device`] 的"两个角色两个文件"同构，理由也一样：合成一条的话，
//!    "当前是哪个角色"就成了状态，而切换状态的那一刻另一个身份就没了。
//!    这正是设计裁决 R12 要的"pad 两种身份凭证完全隔离"。
//!
//! # 读取是懒的，不在启动时
//!
//! 首次真正取用（`access_token()` 等）时才去敲凭证库。这样两个 `src-tauri`
//! 零改动，也把可能的系统授权弹窗推到用户已经在等待的动作上，而不是冷启动那一刻。
//!
//! # 凭证库不可用时降级回内存，**不让 app 起不来**
//!
//! Linux 没有 Secret Service 会话、CI 里没有钥匙串、iOS 上没配数据保护——
//! 这些情况下所有读写都吞掉错误并退回今天的内存行为（最坏是要重新登录）。
//! 凭证存不下就拒绝启动是更差的交易。降级状态经 [`storage_degraded`] 透出给端上提示。
//!
//! # 平台装配：iOS 必须自己接，keyring 的兼容层不管它
//!
//! `keyring` 4.x 的 `v1` 兼容层只自动装配 macOS / Windows / 非 iOS 的 *nix，
//! 遇到 iOS 直接返回 `Error::Invalid("platform", …)`。而**车机跑的正是 iPad**（ACR-004）——
//! 照搬 `keyring::Entry` 的话，最需要"重启不掉登录"的那个端会**静默**永远走降级路径。
//! 所以这里按平台自己装配一次：macOS 用 `keychain`、iOS 用 `protected`（数据保护钥匙串），
//! 其余平台仍借 `v1` 那层的自动装配。见 [`init_store`]。

use std::sync::{Mutex, OnceLock};

use crate::device::DeviceRole;

/// 凭证库里的服务名。两个角色靠 account 区分，见 [`account_for`]。
const SERVICE: &str = "carlife";

/// 一次登录的产物。**没有 `Clone` 到处传的必要**——取用一律经 `access_token()`。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Credentials {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: String,
    pub display_name: Option<String>,
}

#[derive(Debug, Default)]
struct Slot {
    creds: Option<Credentials>,
    /// 已经去凭证库问过了（问到没有也算问过）——否则每次取用都敲一次系统调用。
    loaded: bool,
}

struct Inner {
    personal: Slot,
    cockpit: Slot,
    /// 凭证库不可用（本进程内一路降级为纯内存）。
    degraded: bool,
    /// 测试用：强制凭证库失败，验降级路径。
    #[cfg(test)]
    force_backend_failure: bool,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            personal: Slot::default(),
            cockpit: Slot::default(),
            degraded: false,
            #[cfg(test)]
            force_backend_failure: false,
        }
    }
}

static STATE: OnceLock<Mutex<Inner>> = OnceLock::new();

fn state() -> &'static Mutex<Inner> {
    STATE.get_or_init(|| Mutex::new(Inner::default()))
}

fn account_for(role: DeviceRole) -> &'static str {
    match role {
        DeviceRole::Personal => "credentials.personal",
        DeviceRole::Cockpit => "credentials.cockpit",
    }
}

// ── 凭证库后端 ─────────────────────────────────────────────

/// 一次性装配默认凭证库。返回 `false` 表示这台机器上没有可用的凭证库。
///
/// # 用例装的是内存实现，不碰开发者机器上那一份
///
/// 装真钥匙串会让用例与**这台机器的其它进程共用一条条目**（`carlife` /
/// `credentials.cockpit`）。开发栈里的车机客户端正好也在用它——`lib.rs` 的
/// `keep_fresh` 每 10 分钟刷一次 token、重启时也写。于是用例 `clear()` 完再读，
/// 读回来的是客户端刚填进去的那一枚：
///
/// ```text
/// assertion `left == right` failed
///   left: Some("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…")   ← 客户端的车辆 token
///  right: None
/// ```
///
/// 同一条根因还有第二个触发者：两个并发的 `check:all` 争同一条条目（那个更难认，
/// 表现是**挂住**而不是失败，见 `内部文档` 的 TD-08）。
/// 两者都不是"重跑一下就好"，而是用例的判据取自一份不归它管的状态。
///
/// **这里换掉的是"这台机器的钥匙串好不好使"这一层覆盖，换来的是判据只属于本进程。**
/// 那一层本来也不是单测覆盖得住的：CI 容器里没有钥匙串，走的是 `announce_if_skipping`
/// 那条静默降级；真正验它的是客户端跑起来（M54-08 那个"钥匙串 ACL 不再信任重编后的
/// 二进制"就是跑出来的，不是测出来的）。序列化 / 存 / 读 / 删这四步照旧走
/// `backend_*` 的真实代码，一步没绕。
fn init_store() -> bool {
    static READY: OnceLock<bool> = OnceLock::new();
    *READY.get_or_init(|| {
        #[cfg(test)]
        {
            match keyring_core::mock::Store::new() {
                Ok(store) => {
                    keyring_core::set_default_store(store);
                    true
                }
                Err(_) => false,
            }
        }
        #[cfg(all(not(test), target_os = "macos"))]
        {
            match apple_native_keyring_store::keychain::Store::new() {
                Ok(store) => {
                    keyring_core::set_default_store(store);
                    true
                }
                Err(_) => false,
            }
        }
        #[cfg(all(not(test), target_os = "ios"))]
        {
            // iOS 只有数据保护钥匙串这一条路（`keychain` 模块在 iOS 上根本不编译）。
            match apple_native_keyring_store::protected::Store::new() {
                Ok(store) => {
                    keyring_core::set_default_store(store);
                    true
                }
                Err(_) => false,
            }
        }
        #[cfg(all(not(test), not(any(target_os = "macos", target_os = "ios"))))]
        {
            // Windows / *nix：借 keyring 的 v1 兼容层装配，它内部调的也是
            // `keyring_core::set_default_store`，所以下面照样用 keyring_core::Entry。
            keyring::Entry::store_status().is_ok()
        }
    })
}

fn entry(role: DeviceRole) -> Option<keyring_core::Entry> {
    if !init_store() {
        return None;
    }
    keyring_core::Entry::new(SERVICE, account_for(role)).ok()
}

/// 从凭证库读一份。任何失败（含"没有这条"）都返回 `None`；
/// **只有真正的后端故障**才把 `degraded` 置起来——"没存过"不是故障。
fn backend_load(inner: &mut Inner, role: DeviceRole) -> Option<Credentials> {
    #[cfg(test)]
    if inner.force_backend_failure {
        inner.degraded = true;
        return None;
    }
    let Some(e) = entry(role) else {
        inner.degraded = true;
        eprintln!("[auth] 凭证库不可用（装配失败），本进程退化为纯内存——重启要重新登录");
        return None;
    };
    match e.get_password() {
        Ok(raw) => {
            // 反序列化失败当作"没有凭证"，不 panic——库里的内容可能来自旧版本。
            serde_json::from_str(&raw).ok()
        }
        Err(keyring_core::Error::NoEntry) => None,
        Err(err) => {
            inner.degraded = true;
            /*
             * 这里必须把原因打出来（M54-08）。2026-09-01 之前它一声不吭，
             * 而它吞掉的正是"debug 二进制重编后钥匙串 ACL 不再信任它"——
             * 外部症状只是"每次重启都要重新配对"，与根因隔了三层。
             */
            eprintln!("[auth] 读取已存凭证被拒（{err}）——若是 macOS 弹了钥匙串授权框，点「始终允许」；反复出现则多半是二进制签名不稳定（dev.sh 已内置重签）");
            None
        }
    }
}

fn backend_store(inner: &mut Inner, role: DeviceRole, creds: &Credentials) {
    #[cfg(test)]
    if inner.force_backend_failure {
        inner.degraded = true;
        return;
    }
    let Some(e) = entry(role) else {
        inner.degraded = true;
        return;
    };
    let Ok(raw) = serde_json::to_string(creds) else {
        return;
    };
    if let Err(err) = e.set_password(&raw) {
        inner.degraded = true;
        eprintln!("[auth] 凭证写入失败（{err}）——本次登录只活到进程退出");
    }
}

fn backend_delete(inner: &mut Inner, role: DeviceRole) {
    #[cfg(test)]
    if inner.force_backend_failure {
        return;
    }
    let Some(e) = entry(role) else {
        return;
    };
    // 已经没有这条时也算删干净了，不算故障。
    match e.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => {}
        Err(_) => inner.degraded = true,
    }
}

// ── 当前角色 ───────────────────────────────────────────────

fn slot_mut(inner: &mut Inner, role: DeviceRole) -> &mut Slot {
    match role {
        DeviceRole::Personal => &mut inner.personal,
        DeviceRole::Cockpit => &mut inner.cockpit,
    }
}

/// 取当前角色的凭证（必要时先从凭证库加载一次）。
fn with_current<T>(f: impl FnOnce(Option<&Credentials>) -> T) -> T {
    let role = crate::device::role();
    let mut inner = state().lock().expect("credentials poisoned");
    if !slot_mut(&mut inner, role).loaded {
        let loaded = backend_load(&mut inner, role);
        let slot = slot_mut(&mut inner, role);
        slot.creds = loaded;
        slot.loaded = true;
    }
    f(slot_mut(&mut inner, role).creds.as_ref())
}

// ── 公开接口（签名与 M48-02 逐字一致，调用方零改动） ─────────

/// 登录成功后写入。覆盖式：同一角色下换账号就是覆盖，不做多账号并存。
pub fn set(creds: Credentials) {
    let role = crate::device::role();
    let mut inner = state().lock().expect("credentials poisoned");
    backend_store(&mut inner, role, &creds);
    let slot = slot_mut(&mut inner, role);
    slot.creds = Some(creds);
    slot.loaded = true;
}

/// 刷新后只换 access，refresh 不动（服务端也没换发）。
///
/// **同步落盘**：不落的话重启后拿到的是上一次的 access，白白吃一轮 401。
pub fn set_access_token(token: String) {
    set_access_token_with_vin(token, None);
}

/// 刷新后换 access，并按服务端下发的 vin **纠正绑定标记**。
///
/// # 为什么 vin 不能只在配对时记一次
///
/// `user_id` 里的 `vehicle:<vin>` 是配对当天写下的快照，而绑定关系在服务端
/// 还会变：无 VIN 建档拿的是 `PEND-xxx` 占位主键，车主补录真 VIN 之后，
/// 服务端整条链都换成了新 VIN，端上这份快照却没有任何机制被更新。
///
/// 后果不是显示错一个尾号——`bound_vin()` 是上车声明列成员用的键，
/// 它指着一个服务端已经不认识的 VIN，于是 `GET /v1/vehicles/:vin/members`
/// 恒回 404，车机"已绑定"却永远选不了"现在是谁在用车"。而那道门给出的提示
/// 是"网关地址还指着旧的那台电脑"，把人引向网络设置——重连、重装都不会好。
///
/// 所以刷新这一步顺带纠偏：服务端每次刷新都重新读 `devices.vehicleVin`，
/// 那是绑定的当前真相，比端上任何缓存都新。
///
/// `vin` 为 `None`（人的凭证，或老网关不回这个字段）时行为与从前完全一致。
pub fn set_access_token_with_vin(token: String, vin: Option<&str>) {
    let role = crate::device::role();
    let mut inner = state().lock().expect("credentials poisoned");
    if !slot_mut(&mut inner, role).loaded {
        let loaded = backend_load(&mut inner, role);
        let slot = slot_mut(&mut inner, role);
        slot.creds = loaded;
        slot.loaded = true;
    }
    let updated = {
        let slot = slot_mut(&mut inner, role);
        match slot.creds.as_mut() {
            Some(c) => {
                c.access_token = token;
                // 只纠正车辆级凭证。人的凭证里 `user_id` 是真的用户 id，
                // 任何时候都不该被一个 vin 覆盖掉。
                if let Some(vin) = vin {
                    if c.user_id.starts_with("vehicle:") {
                        c.user_id = format!("vehicle:{vin}");
                    }
                }
                Some(c.clone())
            }
            None => None,
        }
    };
    if let Some(c) = updated {
        backend_store(&mut inner, role, &c);
    }
}

/// 退出登录：**当场清空**内存与凭证库。不做"标记失效"——
/// 留在磁盘上的字节就是能被读到的字节。
pub fn clear() {
    let role = crate::device::role();
    /*
     * **说出是谁清的**（M54-11）。2026-09-01：Mac 上的车辆凭证从钥匙串里
     * 消失了，而两条已知触发路径（退出登录、refresh 被拒）在日志里都对不上
     * ——查不出凶手，因为这个函数一声不吭。清凭证是不可逆动作，
     * 代价是用户要重新配对，不该没有痕迹。
     */
    eprintln!("[auth] 清空 {role:?} 槽位的凭证（退出登录，或 refresh 被服务端拒绝）");
    let mut inner = state().lock().expect("credentials poisoned");
    backend_delete(&mut inner, role);
    let slot = slot_mut(&mut inner, role);
    slot.creds = None;
    // 标成"问过了、没有"，省掉紧接着的一次无谓后端调用。
    slot.loaded = true;
}

/// 当前 access token。未登录返回 `None`——调用方据此走未登录分支，
/// **不要**用空串代替：空串会被拼成 `Bearer `，服务端回 401，
/// 而"401"与"还没登录"在排障时是两件事。
pub fn access_token() -> Option<String> {
    with_current(|c| c.map(|c| c.access_token.clone()))
}

pub fn refresh_token() -> Option<String> {
    with_current(|c| c.map(|c| c.refresh_token.clone()))
}

/// 当前身份（给设置页/HUD 显示"现在是谁"）。**不含 token**。
pub fn current_user() -> Option<(String, Option<String>)> {
    with_current(|c| c.map(|c| (c.user_id.clone(), c.display_name.clone())))
}

pub fn is_authenticated() -> bool {
    with_current(|c| c.is_some())
}

/// 车辆级凭证绑定的 VIN（M48-05）。人的凭证返回 `None`。
///
/// 判据是 `user_id` 的 `vehicle:` 前缀——车辆级凭证**不代表任何人**
/// （设计裁决 R4），那个位置存的是"绑到哪辆车"的标记，不是某个人。
/// 上车声明要靠它知道该列哪辆车的成员。
pub fn bound_vin() -> Option<String> {
    with_current(|c| {
        c.and_then(|c| c.user_id.strip_prefix("vehicle:").map(str::to_string))
    })
}

/// 本进程有没有退化成纯内存（凭证库不可用）。
///
/// 给端上显示"本机无法安全保存登录状态，重启需重新登录"。
/// **它不是错误**：降级是设计的一部分，只是用户有权知道。
pub fn storage_degraded() -> bool {
    state().lock().expect("credentials poisoned").degraded
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 清掉内存缓存，模拟"进程重启"——下一次取用会重新去凭证库读。
    fn drop_memory_cache() {
        let mut inner = state().lock().expect("credentials poisoned");
        inner.personal = Slot::default();
        inner.cockpit = Slot::default();
    }

    fn set_force_failure(on: bool) {
        state().lock().expect("credentials poisoned").force_backend_failure = on;
    }

    fn reset_degraded() {
        state().lock().expect("credentials poisoned").degraded = false;
    }

    fn creds(access: &str, user: &str) -> Credentials {
        Credentials {
            access_token: access.into(),
            refresh_token: "r".into(),
            user_id: user.into(),
            display_name: Some("叶琳".into()),
        }
    }

    /// 全部断言合成**一条**用例按顺序跑，三段各是一个私有函数。
    ///
    /// 凭证是进程级单例（三段还共享同一份凭证库后端），
    /// 而 `cargo test` 默认多线程并行——写成三个 `#[test]` 的话，
    /// 一段的 `clear()` 会打断另一段的中间状态。这不是测试写得糙，
    /// 是被测对象本来就只有一份：那就老老实实按顺序验它的状态机。
    /// （M48-02 第一版真的拆成了两条，`cargo test -p carlife-core auth` 当场红。）
    ///
    /// 那份后端**是内存实现**，不是这台机器的钥匙串——理由与代价写在 `init_store` 的
    /// 文档注释里。所以下面的「落盘往返」验的是序列化/存/读/删这条链，
    /// 而不是"这台机器的钥匙串好不好使"。
    /// 跳过分支仍留着：内存实现万一建不起来，宁可出声也不要静默少验。
    /// 跳过时**必须出声**：一个静默跳过的断言与没有断言等价，
    /// 而"单测全绿掩盖了实际没接上"正是本仓踩过五次的那类根因（ADR-002）。
    /// 跑 `cargo test -p carlife-core -- --nocapture` 能看到这行。
    fn announce_if_skipping(what: &str) {
        eprintln!("⚠ [test] 凭证库不可用，跳过「{what}」——本次运行没有验到落盘往返");
    }

    #[test]
    fn credential_state_machine() {
        lifecycle_and_role_isolation();
        refresh_corrects_stale_bound_vin();
        degrades_to_memory_when_backend_unavailable();
        corrupt_payload_reads_as_absent();
    }

    /// 刷新要能纠正过期的绑定标记。
    ///
    /// `user_id` 里的 vin 是配对当天的快照。服务端把 `PEND-` 占位主键补录成
    /// 真 VIN 之后，这份快照就指着一个服务端已经不认识的值，而 `bound_vin()`
    /// 正是上车声明列成员用的键——列不出来的表现是 404，不是 401，
    /// 于是 `with_refresh` 那条自愈路径压根不会被触发，车机自己好不了。
    fn refresh_corrects_stale_bound_vin() {
        crate::device::set_role(DeviceRole::Cockpit);
        clear();
        set(creds("v1", "vehicle:PEND-ABCDEF123456"));
        assert_eq!(bound_vin().as_deref(), Some("PEND-ABCDEF123456"));

        // 不带 vin 的刷新（老网关 / 人的凭证）：绑定标记原样不动。
        set_access_token("v2".into());
        assert_eq!(
            bound_vin().as_deref(),
            Some("PEND-ABCDEF123456"),
            "没给 vin 就不该自作主张改绑定",
        );

        set_access_token_with_vin("v3".into(), Some("LSJREAL0000000001"));
        assert_eq!(access_token().as_deref(), Some("v3"));
        assert_eq!(
            bound_vin().as_deref(),
            Some("LSJREAL0000000001"),
            "服务端下发的当前绑定要盖掉端上那份快照",
        );
        assert_eq!(refresh_token().as_deref(), Some("r"), "refresh 仍然不动");

        if !storage_degraded() {
            drop_memory_cache();
            assert_eq!(
                bound_vin().as_deref(),
                Some("LSJREAL0000000001"),
                "纠偏必须落盘——只改内存的话下次开机又是旧的那个",
            );
        }

        // 人的凭证：`user_id` 是真的用户 id，任何 vin 都不许覆盖它。
        crate::device::set_role(DeviceRole::Personal);
        clear();
        set(creds("a1", "u-1"));
        set_access_token_with_vin("a2".into(), Some("LSJREAL0000000001"));
        assert_eq!(current_user().unwrap().0, "u-1", "人的身份不能被一个 vin 顶掉");
        assert_eq!(bound_vin(), None);

        clear();
        crate::device::set_role(DeviceRole::Cockpit);
        clear();
        crate::device::set_role(DeviceRole::Personal);
    }

    fn lifecycle_and_role_isolation() {
        crate::device::set_role(DeviceRole::Personal);
        clear();
        assert!(!is_authenticated(), "初始未登录");
        assert_eq!(access_token(), None, "未登录时是 None 而不是空串");

        // 未登录时刷新不该凭空造出一份凭证。
        set_access_token("ghost".into());
        assert!(!is_authenticated(), "没登录过就没有可刷新的东西");

        set(creds("a1", "u-1"));
        assert!(is_authenticated());
        assert_eq!(access_token().as_deref(), Some("a1"));
        assert_eq!(current_user().unwrap().0, "u-1");

        set_access_token("a2".into());
        assert_eq!(access_token().as_deref(), Some("a2"), "刷新只换 access");
        assert_eq!(refresh_token().as_deref(), Some("r"), "refresh 不动");

        // ── 本单的核心断言：落盘往返 = "重启后仍是登录态" ──
        if storage_degraded() {
            announce_if_skipping("落盘往返 / 两条条目各自落盘");
        } else {
            drop_memory_cache();
            assert_eq!(
                access_token().as_deref(),
                Some("a2"),
                "清掉内存缓存后仍读得回来——这就是重启不掉登录",
            );
            assert_eq!(refresh_token().as_deref(), Some("r"), "refresh 也在盘上");
            assert_eq!(current_user().unwrap().0, "u-1");
        }

        // ── 角色隔离（设计裁决 R12） ──
        crate::device::set_role(DeviceRole::Cockpit);
        clear();
        assert!(!is_authenticated(), "车机身份是另一份，本来就没登录");
        set(creds("v1", "vehicle:LSJA24U91NE2E0001"));
        assert_eq!(
            bound_vin().as_deref(),
            Some("LSJA24U91NE2E0001"),
            "车辆级凭证认的是车不是人",
        );

        crate::device::set_role(DeviceRole::Personal);
        assert_eq!(access_token().as_deref(), Some("a2"), "切回私人，那份原样还在");
        assert_eq!(bound_vin(), None, "人的凭证没有 vin");

        crate::device::set_role(DeviceRole::Cockpit);
        assert_eq!(access_token().as_deref(), Some("v1"), "车机那份也原样还在");

        if !storage_degraded() {
            drop_memory_cache();
            crate::device::set_role(DeviceRole::Personal);
            assert_eq!(access_token().as_deref(), Some("a2"), "两条条目各自落盘");
            crate::device::set_role(DeviceRole::Cockpit);
            assert_eq!(access_token().as_deref(), Some("v1"));
            eprintln!("✓ [test] 落盘往返与角色隔离都验到了（凭证库可用）");
        }

        // ── 清空要连凭证库一起清 ──
        clear();
        crate::device::set_role(DeviceRole::Personal);
        clear();
        drop_memory_cache();
        assert_eq!(access_token(), None, "退出登录后重启也读不回来");
        assert_eq!(current_user(), None);

        crate::device::set_role(DeviceRole::Cockpit);
        assert_eq!(access_token(), None);
        crate::device::set_role(DeviceRole::Personal);
    }

    /// 凭证库不可用时：不 panic、不丢功能，只是退回内存态。
    fn degrades_to_memory_when_backend_unavailable() {
        crate::device::set_role(DeviceRole::Personal);
        clear();
        drop_memory_cache();
        set_force_failure(true);
        reset_degraded();

        set(creds("mem-only", "u-9"));
        assert!(storage_degraded(), "端上要能显示'本机存不住登录状态'");
        assert_eq!(
            access_token().as_deref(),
            Some("mem-only"),
            "降级不等于不能用——同一进程内照常工作",
        );

        drop_memory_cache();
        assert_eq!(access_token(), None, "降级下重启就是要重新登录，这是已知代价");

        set_force_failure(false);
        reset_degraded();
        clear();
        drop_memory_cache();
    }

    /// 凭证库里塞一段非 JSON：当作"没有凭证"，不 panic。
    fn corrupt_payload_reads_as_absent() {
        crate::device::set_role(DeviceRole::Personal);
        clear();
        if !init_store() {
            return; // 这台机器没凭证库，本条无从验起
        }
        let Some(e) = entry(DeviceRole::Personal) else {
            return;
        };
        if e.set_password("{ 这不是 JSON").is_err() {
            return;
        }
        drop_memory_cache();
        assert_eq!(access_token(), None, "读不懂的内容当没有，不是崩溃");
        clear();
        drop_memory_cache();
    }
}
