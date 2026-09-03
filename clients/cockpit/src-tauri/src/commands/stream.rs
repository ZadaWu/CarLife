//! 下行流与历史命令（施工单 M2-04）。
//!
//! `start_session_stream`：真实 SSE 消费（同一时刻一路，重复调用替换旧流）；
//! `start_mock_stream`：标准样例序列（与真实流共用 fan-out 路径，开发模式）；
//! `refresh_history`：权威历史回源 → 整体替换本地缓存（差异修复入口）；
//! `read_cached_messages` / `clear_message_cache`：对话层 UI 与开发用。

use std::sync::Arc;

use carlife_core::contract::ChatMessage;
use carlife_net::GatewayClient;
use tauri::{AppHandle, State};

use crate::events::{run_mock_stream, spawn_session_stream, StreamState};

fn gateway_env() -> (String, String) {
    // 统一走设置层（ACR-004 第 3 步）：env → 端上持久化 → 默认。
    // iOS 没有环境变量，这里各自读 env 的话 iPad 上永远连 localhost。
    crate::settings::gateway()
}

#[tauri::command]
pub fn start_session_stream(
    app: AppHandle,
    state: State<'_, Arc<StreamState>>,
    session_id: String,
) {
    let (base_url, token) = gateway_env();
    spawn_session_stream(app, Arc::clone(&state), base_url, token, session_id);
}

#[tauri::command]
pub fn start_mock_stream(app: AppHandle, state: State<'_, Arc<StreamState>>) {
    run_mock_stream(&app, &state);
}

#[tauri::command]
pub async fn refresh_history(
    state: State<'_, Arc<StreamState>>,
    session_id: String,
) -> Result<Vec<ChatMessage>, String> {
    let (base_url, token) = gateway_env();
    let page = GatewayClient::new(base_url, token)
        .fetch_history(&session_id, 100)
        .await
        .map_err(|e| e.to_string())?;
    state
        .cache
        .replace_session(&session_id, &page.messages)
        .map_err(|e| e.to_string())?;
    Ok(page.messages)
}

/// 车主自己的会话列表（M28-01，车机端左侧历史）。原样 JSON，解析在 TS。
///
/// 懒加载：`limit` 缺省 20，`cursor` 传上一页的 `nextCursor`。
#[tauri::command]
pub async fn list_sessions(limit: Option<u32>, cursor: Option<String>) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_sessions(limit.unwrap_or(20), cursor.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// 当前已确认行程的原样 JSON（M13-04）。网络在 Rust 侧（§2.2 C2），
/// WebView 只 invoke；解析与 HUD 映射在 TS（shared 是契约真相源）。
#[tauri::command]
pub async fn fetch_trip_plan(refresh_pretrip: Option<bool>) -> Result<String, String> {
    // 参数**可选**：老的调用点（不传）行为一字不变；只有"打开 App"那一次传 true（M20-06）。
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_trip_plan_with(refresh_pretrip.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())
}

/// 景区导览简报（M36-03）。点击行程上的景点 → 这一跳。
///
/// 与 `fetch_trip_plan` 同一条纪律：入参出参都是原样 JSON（契约在 TS/shared 的
/// `GuideBriefResponse`），Rust 只搬运不解析。**慢是常态**：冷启三分支采集
/// 最坏 90s 量级（缓存命中毫秒级），net 层已按 110s 兜底，前端自带"采集中"占位。
#[tauri::command]
pub async fn get_guide_brief(body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_guide_brief(&body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 出发导航规划（M66-03）。点「开始行程」→ 这一跳，与动画并行。
///
/// 与 `get_guide_brief` 同一条纪律：入参出参原样 JSON（契约在 TS/shared 的
/// `NavPlanRequest` / `NavPlanResponse`），Rust 只搬运不解析。**慢是常态**：一条 nav-task
/// 分支真跑 8 s 量级、预算 60 s，net 层 65 s 兜底，前端自带「正在规划导航 N s…」占位与 60 s 硬顶。
/// 手机端不加镜像命令：出发卡只在车机 HUD 上。
#[tauri::command]
pub async fn plan_departure_nav(body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .post_nav_plan(&body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 导览采集任务状态（M40-02）。进度面板轮询它；快路径 10s 超时在 net 层。
#[tauri::command]
pub async fn get_guide_jobs() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_guide_jobs()
        .await
        .map_err(|e| e.to_string())
}

/// 手动「获取导览」（M40-02）。body 只带 spotName，行程上下文网关补齐。
#[tauri::command]
pub async fn trigger_guide_job(body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .trigger_guide_job(&body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 车辆档案列表的原样 JSON（M14-05）。与 `fetch_trip_plan` 同一条纪律：
/// Rust 只搬运不解析，契约真相源在 TS/shared。车机端档案**只读**——
/// 建档走手机端向导（FL-23：车机仅手动录入，本期未开）。
#[tauri::command]
pub async fn fetch_vehicles() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_vehicles()
        .await
        .map_err(|e| e.to_string())
}

/// 新增 / 修改常用人员（M29-06 加，M29-07 起也用于编辑）。
///
/// **带 `id` 即更新**（网关 `http/vehicle-member.ts` 同一路由）：漏传 id 会静默
/// 新建一个同名的人，名单里出现两个"妈妈"——那正是 M17-04 反复防的那类事故。
///
/// # M17-04 边界的两次修订（2026-08-27）
///
/// 原裁定是"车机驾驶态不适合填表"，先解禁"添加"（M29-06），再解禁"修改 + 删除"
/// （M29-07，与手机端对齐）。**删除禁令的原理由并没有失效**——它是不可逆级联，
/// 确认文案必须说清后果，而驾驶态读长文案本身不安全；这里是被产品决策覆盖。
/// 本可以用"仅驻车可删"来缓解，但 `vehicle_signal.rs` 至今是空壳、端上拿不到驻车态，
/// 所以补偿只有：确认文案照抄手机端 + 二次点击。驻车门控记在收口技术债里。
#[tauri::command]
pub async fn save_member(vin: String, body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .post_member(&vin, &body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 删除常用人员（M29-07）。**幂等**：删不到也返回 200 `{removed:false}`，
/// 端上按 `removed` 决定措辞，不把"已经删过了"当成错误（网关端点同一条纪律）。
#[tauri::command]
pub async fn delete_member(vin: String, id: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .delete_member(&vin, &id)
        .await
        .map_err(|e| e.to_string())
}

/// 档案变更记录（M29-05）。原样 JSON，Rust 只搬运。
#[tauri::command]
pub async fn fetch_vehicle_changes(vin: String, cursor: Option<String>) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_vehicle_changes(&vin, cursor.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// 占位 VIN → 真 VIN 补录（M29-04）。入参与返回都是原样 JSON，Rust 只搬运。
#[tauri::command]
pub async fn backfill_vin(vin: String, body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .backfill_vin(&vin, &body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 手动记一笔保养（M29-03）。入参与返回都是原样 JSON，Rust 只搬运。
#[tauri::command]
pub async fn append_maintenance(vin: String, body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .append_maintenance(&vin, &body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 剩余电量 / 剩余油量（M27）。仿真读数，`provenance:"simulated"` 在响应体里。
#[tauri::command]
pub async fn fetch_vehicle_energy(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_vehicle_energy(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 车机绑定状态（M24-05）。三态在响应体里，Rust 只搬运。
#[tauri::command]
pub async fn fetch_cabin(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_cabin(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 触发车机绑定（M24-05，幂等）。
#[tauri::command]
pub async fn bind_cabin(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .post_cabin_bind(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 车型目录 + 车型↔知识库关联关系（M14-08）。建档向导用它决定
/// "这一款有没有对应的知识库"，拿不到时 TS 侧说"读不到"而不是"没有资料"。
#[tauri::command]
pub async fn fetch_vehicle_catalog() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_vehicle_catalog()
        .await
        .map_err(|e| e.to_string())
}

/// 这辆车的⑥用车画像（M14-09）。503 也带体回来——"未接入"与"没有数据"
/// 在端上是两句不同的话，判定与措辞都在 TS 侧。
#[tauri::command]
pub async fn fetch_vehicle_usage(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_vehicle_usage(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 常用人员名单（M14-10）。契约同手机端，M17-04 的端点一个字不改。
#[tauri::command]
pub async fn fetch_members(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_members(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 某位成员的画像（M14-10）。常驾/常乘两种口径由服务端选，端上只渲染。
#[tauri::command]
pub async fn fetch_member_usage(vin: String, member_id: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_member_usage(&vin, &member_id)
        .await
        .map_err(|e| e.to_string())
}

/// ③偏好（M14-10，"我希望助手记住"）。车机端只读。
#[tauri::command]
pub async fn fetch_preferences() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_preferences()
        .await
        .map_err(|e| e.to_string())
}

/// 删除一条③偏好（车机端"我希望助手记住"那一栏的删除按钮）。
#[tauri::command]
pub async fn delete_preference(id: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .delete_preference(&id)
        .await
        .map_err(|e| e.to_string())
}

/// 车机端手动建档（M14-06，FL-23："车机和 Web 仅支持手动录入"）。
///
/// 与手机端同一个端点、同一份请求体形状——建档逻辑（目录、校验）在
/// `@carlife/ui` 共享，两端各写一份必然让同一辆车建出两条不同车型名的档案。
#[tauri::command]
pub async fn create_vehicle(body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .post_vehicle(&body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 设默认车（M14-06）。默认车决定检索侧的车型限定，车机端也要能切。
#[tauri::command]
pub async fn set_default_vehicle(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .post_vehicle_default(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// HITL 确认/拒绝（M13-05）。返回 true=网关受理（含 duplicate），false=中断已过期——
/// 两者对 UI 都是"收起弹窗"，**都不重试**。
#[tauri::command]
pub async fn resume_interrupt(
    session_id: String,
    interrupt_id: String,
    approved: bool,
) -> Result<bool, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .post_resume(&session_id, &interrupt_id, approved)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_cached_messages(
    state: State<'_, Arc<StreamState>>,
    session_id: String,
    before: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ChatMessage>, String> {
    state
        .cache
        .recent_page(&session_id, before.as_deref(), limit.unwrap_or(50) as usize)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_message_cache(
    state: State<'_, Arc<StreamState>>,
    session_id: String,
) -> Result<(), String> {
    state.cache.clear_session(&session_id).map_err(|e| e.to_string())
}
