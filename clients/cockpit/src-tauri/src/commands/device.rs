//! 设备与车机绑定的 Tauri 命令（施工单 M48-04，F-56-01/03/04）。
//!
//! # 车机这一侧只做两件事
//!
//! 展示自己的 deviceId（给车主扫），以及把车主念回来的配对码换成车辆级凭证。
//! **车机上不输入任何账号口令**（FL-07 F-07-04 的"免密"就是这个意思）。
//!
//! # 角色切换（F-56-04）
//!
//! `switch_device_role` 只切"当前用哪个 id 文件"，不动文件本身——
//! 所以"退出车机模式"之后私人身份原样还在，不用重新登录（设计裁决 R12）。

use carlife_core::device::{self, DeviceRole};

/// 当前设备 id（车机未绑定时把它渲染成二维码给车主扫）。
#[tauri::command]
pub fn device_id() -> Result<String, String> {
    device::current_id()
}

/// 当前角色："personal" / "cockpit"。端上据此决定显示哪套界面。
#[tauri::command]
pub fn device_role() -> &'static str {
    match device::role() {
        DeviceRole::Cockpit => "cockpit",
        DeviceRole::Personal => "personal",
    }
}

/// 本机能不能安全保存登录状态（M49-04 接 M49-02 / ACR-011）。
///
/// 为真表示凭证库不可用、本进程退回纯内存——**重启就要重新登录**。
/// 端上要如实告诉用户，而不是等他下次上车发现要输密码。
/// 这里只透出一个布尔，**不透出任何凭证内容**（§2.2 C3）。
#[tauri::command]
pub fn credential_storage_degraded() -> bool {
    carlife_core::auth::storage_degraded()
}

/// 切换角色（"用作车机" / "退出车机模式"）。
#[tauri::command]
pub fn switch_device_role(role: String) -> Result<String, String> {
    let next = match role.as_str() {
        "cockpit" => DeviceRole::Cockpit,
        "personal" => DeviceRole::Personal,
        other => return Err(format!("未知角色：{other}")),
    };
    device::set_role(next);
    /*
     * **不清声明**（M54-11 撤销 M54-05 的那次清空）。
     *
     * 原理由是"换角色 = 换这台设备是谁的"，听起来成立，但它与 R12 冲突：
     * R12 要的就是"切回来不用重新来过"。实际后果是 2026-09-01 走查里的第二条
     * ——重启后角色退回 personal（M54-11 另修），用户点「用作车机」想回到车机，
     * 这一行当场把他上次选的使用人擦掉，于是**每次都要重选身份**。
     *
     * 声明只在两个时刻作废：用户显式点「更换使用人」（boarding_reset），
     * 或续用被服务端拒（那个人已不在成员名单里，BoardingGate 自己清）。
     */
    device::current_id()
}

/// 输入配对码完成绑定，换到车辆级凭证。返回绑定到的 VIN。
#[tauri::command]
pub async fn confirm_pairing(code: String, model_name: String) -> Result<String, String> {
    // 绑定用的恒是**车机身份**的 id：当前角色可能还停在 personal
    // （用户刚点"用作车机"、界面还没切过去）。
    let id = device::id_for(DeviceRole::Cockpit)?;
    let (base_url, _) = crate::settings::gateway();
    let vin = carlife_net::confirm_pairing(&base_url, &id, &code, &model_name)
        .await
        .map_err(|e| e.to_string())?;
    device::set_role(DeviceRole::Cockpit);
    Ok(vin)
}

// ── 上车声明（M48-05，F-56-05/06） ────────────────────────────

/// 本次上车声明的「谁在用车」（M54-06，读 M54-05 存的声明）。
///
/// 返回 JSON：`{"declared": false}` / `{"declared": true, "activeUserId": "u-1" | null}`。
/// `activeUserId: null` 是**访客**——它与「没声明」是两个状态，前者能建会话、
/// 后者该回声明屏，压成一层正是 boarding.rs 文件头警告的那个错误。
#[tauri::command]
pub fn boarding_declared() -> String {
    match crate::boarding::declared() {
        None => r#"{"declared":false}"#.into(),
        Some(who) => serde_json::json!({ "declared": true, "activeUserId": who }).to_string(),
    }
}

/// 清掉已保存的「谁在用车」，回到声明屏（M54-10 设置页「更换使用人」）。
/// 只清声明不动角色也不动车辆凭证——换人不等于换设备身份。
#[tauri::command]
pub fn boarding_reset() {
    crate::boarding::clear();
    carlife_core::acting::clear();
}

/// 本机当前绑定到哪辆车（车辆级凭证在手时）。未绑定返回空串。
///
/// 空串而不是 `Option`：端上判"有没有绑"只需要一个真假，
/// 而 `null` 与 `""` 在 JS 侧都是假值——统一成一种形状少一类分支。
#[tauri::command]
pub fn bound_vin() -> String {
    carlife_core::auth::bound_vin().unwrap_or_default()
}

/// 向服务端问一次"这台设备现在绑的是哪辆车"，返回纠偏后的 VIN。
///
/// # 为什么需要主动问，而不是等 401
///
/// `bound_vin()` 读的是钥匙串里那份配对当天的快照，而绑定在服务端还会变
/// （无 VIN 建档的 `PEND-xxx` 被车主补录成真 VIN）。快照过期后列成员恒回
/// **404**——不是 401，`with_refresh` 那条自愈路径根本不会被触发，
/// 车机就永久卡在"已绑定却选不了使用人"。
///
/// 刷新是唯一能拿到当前绑定的渠道：服务端每次刷新都重读 `devices.vehicleVin`。
/// 刷不动（没登录过 / refresh 也失效）就返回本地那份，让调用方照旧报错——
/// 这里不负责判断"该不该重新配对"。
#[tauri::command]
pub async fn resync_bound_vin() -> String {
    let (base_url, _) = crate::settings::gateway();
    let _ = carlife_net::refresh(&base_url).await;
    carlife_core::auth::bound_vin().unwrap_or_default()
}

/// 这辆车当前有哪些成员（车机绑定后才有意义）。
///
/// 原样透传服务端 JSON：里面只有账号**自设**的 displayName，
/// **没有**车主给家人起的称呼（那是他人 PII，FL-46 F-46-13）。
#[tauri::command]
pub async fn vehicle_members(vin: String) -> Result<String, String> {
    /*
     * 走 `with_refresh`（M54-03）：access token 只活 15 分钟，而这道门恰好是
     * **隔夜之后第一个被调用的网络路径**——车机放一晚上再开，点「用作车机」
     * 走到这里必然是过期的那枚。此前不重试，服务端回 401，端上什么都列不出来。
     *
     * 闭包里重新取一次 `gateway()`：刷新后 token 变了，捕获快照等于白刷。
     */
    let (base_url, _) = crate::settings::gateway();
    carlife_net::with_refresh(&base_url, || async {
        let (base_url, token) = crate::settings::gateway();
        carlife_net::GatewayClient::new(base_url, token)
            .fetch_vehicle_grants(&vin)
            .await
    })
    .await
    .map_err(|e| e.to_string())
}

/// 建会话并声明"现在是谁在用"。
///
/// `active_user_id`：`None` = 访客模式（显式的，不是"忘了传"）。
/// 服务端会校验声明的这个人在不在成员名单里——集合外一律 400，
/// 车辆级凭证换不成任意人的身份。
#[tauri::command]
pub async fn create_session_as(active_user_id: Option<String>) -> Result<String, String> {
    // 同 `vehicle_members`：紧接在它后面发生，同样可能带着过期的 token。
    let (base_url, _) = crate::settings::gateway();
    let created = carlife_net::with_refresh(&base_url, || async {
        let (base_url, token) = crate::settings::gateway();
        carlife_net::GatewayClient::new(base_url, token)
            .create_session_as(Some(active_user_id.clone()))
            .await
    })
    .await
    .map_err(|e| e.to_string())?;
    /*
     * 把声明记下来（M54-05）。此前它只用在这一个会话上就丢了，
     * 于是同一次上车里「新建对话」与唤醒词各自去建会话时都拿不到它，
     * 双双拿到 400 active_user_required——现象是"点了没反应""喊了不理"。
     */
    crate::boarding::set(active_user_id);
    // 后续请求靠它告诉服务端"这台车机此刻代表谁"（M54-13）。
    carlife_core::acting::set_session(&created.session_id);
    serde_json::to_string(&serde_json::json!({
        "sessionId": created.session_id,
        "guest": created.guest,
    }))
    .map_err(|e| e.to_string())
}

/// 播报一句降级话术（M49-04，F-56-06）。
///
/// 只给"访客模式"这类**必须让人知道**的降级用，不是通用 TTS 出口——
/// 通用播报由 turn 事件驱动（`events.rs`），端上不该有第二条随便说话的路。
///
/// 走 `tts::speak` 而不是自己造一条：播报开关、打断、状态机都在那条链上，
/// 另起一条的话"关了播报却还是说了"迟早发生。
#[tauri::command]
pub fn announce_downgrade(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<crate::tts::TtsState>>,
    text: String,
) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    /*
     * 三条**各自说出为什么没响**（M54-01）。
     *
     * 2026-08-31 走查 W10：访客标记出现了、话没说出来，而日志里一行都没有——
     * 于是分不清是没被调到、被静音吞了、还是引擎不可用。三种的处置完全不同
     * （前两个不是缺陷、第三个是），而"没声音"这一个现象把它们压成了同一句话。
     *
     * 播报本身是 fire-and-forget（`speak` 内部起线程），所以只能在**入口**记。
     */
    let muted = state.is_muted();
    let engine_on = crate::tts::enabled();
    eprintln!(
        "[tts] 降级播报：{} 字，播报开关={}，引擎={}",
        trimmed.chars().count(),
        if muted { "关（不会出声）" } else { "开" },
        if engine_on { "可用" } else { "off（不会出声）" },
    );
    crate::tts::speak(&app, &state, trimmed);
}
