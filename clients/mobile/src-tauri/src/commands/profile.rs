//! 端上本地偏好（施工单 A3）。
//!
//! 只放**跨重启要保持、且不值得走服务端**的开关。判据是：丢了不影响正确性，
//! 只影响手感。真正的用户档案（车辆、偏好记忆）在服务端，不在这里——
//! 端上存一份会立刻产生"改了手机上的、车机上没变"的两份真相。

use std::fs;
use std::path::PathBuf;

use std::sync::Arc;

use carlife_core::contract::AssistantState;
use carlife_core::fanout::EVENT_ASSISTANT_STATE;
use tauri::{AppHandle, Emitter, Manager, State};

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("prefs.json"))
}

/// 读一个布尔偏好；文件不存在、解析失败、键缺失都回落到 `default`。
///
/// **不区分这三种失败**是刻意的：对调用方来说结果一样（用默认值），
/// 而区分它们会诱使调用方去处理一个它无法补救的错误。
fn read_bool(app: &AppHandle, key: &str, default: bool) -> bool {
    let Some(path) = prefs_path(app) else { return default };
    let Ok(text) = fs::read_to_string(path) else { return default };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return default };
    json.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

fn write_bool(app: &AppHandle, key: &str, value: bool) -> bool {
    let Some(path) = prefs_path(app) else { return value };
    let mut json = fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    json[key] = serde_json::Value::Bool(value);
    // 写失败也返回请求值：开关在本次会话内已经生效，
    // 回滚成旧值会让用户看到"点了没反应"，比"重启后没保持住"更糟。
    let _ = fs::write(&path, json.to_string());
    value
}

/// 播报开关的持久化值。`setup::init` 用它给托管的 `TtsState` 定初值——之后真相源是那份状态。
pub(crate) fn broadcast_enabled_pref(app: &AppHandle) -> bool {
    read_bool(app, "broadcastEnabled", false)
}

/// 语音播报总开关（对齐 F-02-12）。手机端默认**关**——
/// 车机是免手场景所以默认开，手机常在公共场合，默认出声是打扰。
///
/// 真相源是托管的 `carlife_tts::TtsState`（M65-04）。此前这里只读写偏好文件，
/// 而全仓没有第二个读者——开关能拨、能存、永远无效；真机上用户拨开它暖暖照旧沉默。
#[tauri::command]
pub fn get_broadcast_enabled(state: State<'_, Arc<carlife_tts::TtsState>>) -> bool {
    !state.is_muted()
}

/// 设置播报开关；**立即生效**并持久化。关闭时停掉正在进行的播报并回 idle——
/// "关了还在说"是最刺耳的那种 bug（车机 prefs.rs 同一取向）。
#[tauri::command]
pub fn set_broadcast_enabled(
    app: AppHandle,
    state: State<'_, Arc<carlife_tts::TtsState>>,
    enabled: bool,
) -> bool {
    state.set_muted(!enabled);
    if !enabled && state.is_playing() {
        carlife_tts::stop(&state);
        let _ = app.emit(EVENT_ASSISTANT_STATE, AssistantState::Idle);
    }
    write_bool(&app, "broadcastEnabled", enabled)
}

// ── 哨兵监听（语音唤醒）总开关，M60-01 ─────────────────────────

/// 读取「哨兵监听」开关（true = 常驻监听开着，能听见「暖暖你好」）。
///
/// 真相源是 [`crate::voice::sentinel::SENTINEL_ENABLED`]，不是偏好文件——
/// 文件只在启动时读一次，之后设置页改的都是这个静态量。
#[tauri::command]
pub fn get_sentinel_enabled() -> bool {
    crate::voice::sentinel::SENTINEL_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// 设置「哨兵监听」开关；立即生效并持久化。
///
/// # 打开时先要到麦克风授权，**要不到就不打开**
///
/// 不挡这一道的话，开关会停在"开"而麦克风从来没打开过——用户对着手机
/// 喊「暖暖」毫无反应，而设置页上白纸黑字写着已开启。一个开着却不工作的
/// 开关比一个关着的开关坏得多。要不到授权时返回 `permission_denied`，
/// 由界面回滚那个开关并说清原因（系统已拒过的话 `acquire_mic_permission`
/// 会把用户送到系统设置页）。
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
/// 抽成函数是因为有两个入口（设置页的 `set_sentinel_enabled` 与
/// `voice::sentinel_set_switch`），而它们必须做**同样的三件事**。少做一件的
/// 症状各不相同且都离根因很远：不置静态量 → 重启后循环读到旧值；
/// 不拨哨兵 → 界面已经变了但麦克风还开着；不落盘 → 关掉重启又自己开。
pub fn apply_sentinel_enabled(app: &AppHandle, enabled: bool) {
    crate::voice::sentinel::SENTINEL_ENABLED
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
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
    write_bool(app, "sentinelEnabled", enabled);
}

/// 启动时载入（跨重启保持）。**缺省 = 关**，理由见
/// [`crate::voice::sentinel::SENTINEL_ENABLED`] 的文档。
pub fn load_sentinel_pref(app: &AppHandle) {
    let enabled = read_bool(app, "sentinelEnabled", false);
    crate::voice::sentinel::SENTINEL_ENABLED
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
    eprintln!("[sentinel] 监听开关：{}（设置页「语音唤醒」）", if enabled { "开" } else { "关" });
}

// ── ④车辆档案（施工单 M14-04/M14-05）────────────────────────────────
//
// 档案数据在服务端（文件头说明的"两份真相"问题），这里只是网络搬运：
// WebView 不直接访问网关（§2.2 C2，token 不进 WebView 可达范围），
// JSON 原样透传——契约真相源在 TS/shared，Rust 不解析。

/// 景区导览简报（M36-04）。与车机端 `get_guide_brief` 同名同形：
/// 原样 JSON 往返（契约在 TS/shared 的 `GuideBriefResponse`），Rust 只搬运不解析。
/// 慢是常态（冷启三分支采集 90s 量级，net 层 110s 兜底），前端自带"采集中"占位。
#[tauri::command]
pub async fn get_guide_brief(body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_guide_brief(&body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 出发导航规划（M66-03 车机；2026-09-02 手机端接上出发卡）。点「开始行程」→ 这一跳。
///
/// 与 `get_guide_brief` 同一条纪律：入参出参原样 JSON（契约在 TS/shared 的
/// `NavPlanRequest` / `NavPlanResponse`），Rust 只搬运不解析。**慢是常态**：一条 nav-task
/// 分支真跑 8 s 量级、预算 60 s，net 层 65 s 兜底，前端自带「正在规划导航 N s…」占位与 60 s 硬顶。
/// 与车机端 `plan_departure_nav` 同名同形（carlife-net 共享方法）。
#[tauri::command]
pub async fn plan_departure_nav(body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .post_nav_plan(&body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 导览采集任务状态（M40-03）。与车机端同名同形（carlife-net 共享方法）。
#[tauri::command]
pub async fn get_guide_jobs() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_guide_jobs()
        .await
        .map_err(|e| e.to_string())
}

/// 手动「获取导览」（M40-03）。body 只带 spotName，行程上下文网关补齐。
#[tauri::command]
pub async fn trigger_guide_job(body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .trigger_guide_job(&body_json)
        .await
        .map_err(|e| e.to_string())
}

fn gateway_env() -> (String, String) {
    // env → 端上持久化 → 默认（`crate::settings` 文件头写了为什么是这个顺序）。
    // 以前这里直接读 env 并回落 8787——那个端口从来就是错的，只是桌面恒有 .env
    // 兜着，直到装上手机（env 缺席的常态）才暴露成"怎么都登录不上"。
    crate::settings::gateway()
}

/// 车辆列表（`GET /v1/vehicles` 原样 JSON：`{"vehicles":[...]}`）。
#[tauri::command]
pub async fn list_vehicles() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_vehicles()
        .await
        .map_err(|e| e.to_string())
}

/// 车型目录 + 车型↔知识库关联关系（M14-08，`GET /v1/vehicle-catalog`）。
#[tauri::command]
pub async fn fetch_vehicle_catalog() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_vehicle_catalog()
        .await
        .map_err(|e| e.to_string())
}

/// 这辆车的⑥用车画像（M14-11，`GET /v1/vehicles/:vin/usage`）。
/// 503 也带体回来——"未接入"与"没有数据"在端上是两句不同的话。
#[tauri::command]
pub async fn fetch_vehicle_usage(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_vehicle_usage(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 某位成员的画像（M14-12）。常驾/常乘两种口径由服务端选，端上只渲染。
#[tauri::command]
pub async fn fetch_member_usage(vin: String, member_id: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_member_usage(&vin, &member_id)
        .await
        .map_err(|e| e.to_string())
}

/// ③偏好（M14-12，"我希望助手记住"）。
#[tauri::command]
pub async fn fetch_preferences() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_preferences()
        .await
        .map_err(|e| e.to_string())
}

/// 建档 / 编辑（`POST /v1/vehicles`）。`body_json` 由端上按契约组装。
#[tauri::command]
pub async fn create_vehicle(body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .post_vehicle(&body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 设默认车（`POST /v1/vehicles/:vin/default`）。
#[tauri::command]
pub async fn set_default_vehicle(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .post_vehicle_default(&vin)
        .await
        .map_err(|e| e.to_string())
}

// ── 常用人员（施工单 M17-04）────────────────────────────────────────
//
// 与档案同一形态：网络在 Rust 侧（§2.2 C2），JSON 原样透传，Rust 不解析业务字段。

/// 写座舱偏好（M24-09）。
#[tauri::command]
pub async fn save_member_preference(vin: String, id: String, body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .put_member_preference(&vin, &id, &body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 组合列表（M24-09）。
#[tauri::command]
pub async fn list_combinations(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_combinations(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 建/改组合（M24-09）。
#[tauri::command]
pub async fn save_combination(vin: String, body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .post_combination(&vin, &body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 删组合（M24-09，幂等）。
#[tauri::command]
pub async fn delete_combination(vin: String, id: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .delete_combination(&vin, &id)
        .await
        .map_err(|e| e.to_string())
}

/// 车机绑定状态（M24-05，`GET /v1/vehicles/:vin/cabin`）。
#[tauri::command]
pub async fn fetch_cabin(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_cabin(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 触发车机绑定（M24-05，幂等）。
#[tauri::command]
pub async fn bind_cabin(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .post_cabin_bind(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 常用人员名单（`GET /v1/vehicles/:vin/members`）。
#[tauri::command]
pub async fn list_members(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_members(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 新增 / 更新常用人员（`POST /v1/vehicles/:vin/members`）。
#[tauri::command]
pub async fn save_member(vin: String, body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .post_member(&vin, &body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 删除常用人员（`DELETE /v1/vehicles/:vin/members/:id`）。
#[tauri::command]
pub async fn delete_member(vin: String, id: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .delete_member(&vin, &id)
        .await
        .map_err(|e| e.to_string())
}

// ── 购车候选与成本（施工单 M15-05）──────────────────────────────────
//
// 与档案同一形态：网络在 Rust 侧，JSON 原样透传。
// 页面读的是结构化候选，**不是解析回答文本**——后者模型换个措辞就少一列。

/// 购车候选与成本（`GET /v1/session/:id/buying`）。
#[tauri::command]
pub async fn fetch_buying(session_id: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_buying(&session_id)
        .await
        .map_err(|e| e.to_string())
}

/// 车辆成员授权名单（M48-03，`GET /v1/vehicles/:vin/grants`）。
///
/// 与 `list_members`（影子成员档案）是两条独立的路：那边是"车上常有谁"，
/// 这边是"谁能登录用这辆车"。生命周期独立（AC-55-6），端上两块 UI。
#[tauri::command]
pub async fn list_vehicle_grants(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_vehicle_grants(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 添加成员授权（M48-03）。仅车主可调；非车主会拿到与"车不存在"同一响应。
#[tauri::command]
pub async fn add_vehicle_grant(vin: String, body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .post_vehicle_grant(&vin, &body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 移除成员授权（M48-03）。软删，被移除者的**下一次请求**即失效。
#[tauri::command]
pub async fn remove_vehicle_grant(vin: String, user_id: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .delete_vehicle_grant(&vin, &user_id)
        .await
        .map_err(|e| e.to_string())
}

// ── 设备与车机绑定（M48-04，F-56-01/02/03/04） ─────────────────

/// 当前设备的注册实例 id（按当前角色）。
#[tauri::command]
pub fn device_id() -> Result<String, String> {
    carlife_core::device::current_id()
}

/// 向服务端注册本设备。登录后调一次；幂等。
#[tauri::command]
pub async fn register_device(model_name: String) -> Result<(), String> {
    let id = carlife_core::device::current_id()?;
    let kind = match carlife_core::device::role() {
        carlife_core::device::DeviceRole::Cockpit => "cockpit",
        carlife_core::device::DeviceRole::Personal => "mobile",
    };
    let (base_url, _) = gateway_env();
    carlife_net::register_device(&base_url, &id, kind, &model_name)
        .await
        .map_err(|e| e.to_string())
}

/// 车主扫码后要一枚配对码（手机端，F-56-03）。
///
/// `device_id` 是**车机**的 id（从二维码里扫出来的），不是本机的——
/// 传错的话会把手机自己绑成车机，而那看起来"绑定成功了"。
#[tauri::command]
pub async fn request_pairing_code(
    cockpit_device_id: String,
    vin: String,
) -> Result<String, String> {
    let (base_url, _) = gateway_env();
    let code = carlife_net::request_pairing_code(&base_url, &cockpit_device_id, &vin)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&serde_json::json!({
        "code": code.code,
        "expiresInSec": code.expires_in_sec,
        "vinSuffix": code.vin_suffix,
    }))
    .map_err(|e| e.to_string())
}

/// 当前已确认行程（M13-04，`GET /v1/trip-plan/current`；M65-01 手机端补上）。
/// 参数**可选**：只有"打开 App / 切回前台"那一次传 true，要求网关按最新天气重算行前物品（M20-06）。
/// 返回原样 JSON 文本：行程契约的真相源在 TS（`TripPlanSnapshot`），Rust 只搬运不解析。
#[tauri::command]
pub async fn fetch_trip_plan(refresh_pretrip: Option<bool>) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_trip_plan_with(refresh_pretrip.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())
}

/// 剩余电量 / 剩余油量（M27，`GET /v1/vehicles/:vin/energy`；M65-01 手机端补上）。
/// 车机离线不是错误，是一种读数：网关回 502 + `{state:"offline"}`，`carlife-net` 把响应体带回来，
/// TS 侧先解析 state 再谈异常——所以这里不把 502 变成 Err。
#[tauri::command]
pub async fn fetch_vehicle_energy(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    carlife_net::GatewayClient::new(base_url, token)
        .fetch_vehicle_energy(&vin)
        .await
        .map_err(|e| e.to_string())
}
