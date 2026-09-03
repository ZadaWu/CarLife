//! 会话、下行流与历史命令（施工单 A3，对齐 M2-04/M2-05）。
//!
//! # 网络在 Rust 侧，WebView 只 invoke
//!
//! §2.2 C2：鉴权与网络都在 Rust。WebView 不直接访问网关——否则 token 会进
//! WebView 的可达范围，端侧兜底（capability 白名单）就形同虚设。
//!
//! # 三个命令的分工
//!
//!  - `start_session_stream` —— 真实 SSE 消费，同一时刻一路，重复调用替换旧流；
//!  - `refresh_history` —— 权威历史回源，**整体替换**本地缓存（差异修复入口）；
//!  - `read_cached_messages` —— 离线/首帧读缓存，它**不是权威源**。

use std::sync::Arc;

use carlife_core::contract::ChatMessage;
use carlife_net::GatewayClient;
use tauri::{AppHandle, State};

use crate::events::{run_mock_stream, spawn_session_stream, StreamState};

/// 网关地址与令牌。
///
/// 缺省值指向本地网关：手机端开发时常常没配 env，回落到能连上的地址
/// 比抛错更有用——抛错会让人以为是代码坏了。
pub(crate) fn gateway_env() -> (String, String) {
    // env → 端上持久化 → 默认（`crate::settings` 文件头写了为什么是这个顺序）。
    // 以前这里直接读 env 并回落 8787——那个端口从来就是错的，只是桌面恒有 .env
    // 兜着，直到装上手机（env 缺席的常态）才暴露成"怎么都登录不上"。
    crate::settings::gateway()
}

#[tauri::command]
pub async fn create_session() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .create_session()
        .await
        .map(|c| c.session_id)
        .map_err(|e| e.to_string())
}

/// 发文字消息。
///
/// **不做本地乐观插入**：用户消息与助手回复都由 SSE 回流。
/// 乐观插入会造出"本地已显示、服务端却失败"的两份真相，
/// 而用户看到的是那条永远不会有回复的消息。
#[tauri::command]
pub async fn send_text_message(session_id: String, content: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .send_text(&session_id, &content, carlife_core::contract::MessageSource::Text)
        .await
        .map(|t| t.turn_id)
        .map_err(|e| e.to_string())
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
    // 整体替换而不是合并：合并要解决"本地有服务端没有"的冲突，
    // 而权威源就是服务端，合并等于给本地脏数据续命。
    state
        .cache
        .replace_session(&session_id, &page.messages)
        .map_err(|e| e.to_string())?;
    Ok(page.messages)
}

#[tauri::command]
pub fn read_cached_messages(
    state: State<'_, Arc<StreamState>>,
    session_id: String,
) -> Result<Vec<ChatMessage>, String> {
    state
        .cache
        .recent_page(&session_id, None, 200)
        .map_err(|e| e.to_string())
}

/// HITL 确认 / 拒绝的上行（M65-02，F-04-08）：`POST /v1/session/:id/resume`。
///
/// 返回值是服务端的 `resumed`——**false 不是错误，是"服务端已不在等这条确认"**
/// （超时或重启，挂起随进程消失）。端上拿到 false 必须把弹层改成告知态，
/// 不能收起：收起就是车机 M13-12 踩过的"点了确认、窗关了、其实什么都没发生"。
/// 网络失败走 `Err`，同样不能表现得像成功。幂等在网关 HitlRelay（F-04-11），这里不重试。
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

/// 软关闭当前会话（M22-01 语义；M65-02 手机端补上）。**历史不删**，列表里那条变成「已结束」。
/// 两个入口共用（HUD 的「退下」按钮、语音口令退下），端上先收尾再调它——关不上不挡收尾。
#[tauri::command]
pub async fn close_session(session_id: String) -> Result<(), String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .close_session(&session_id)
        .await
        .map_err(|e| e.to_string())
}

/// 会话历史列表（M28-01，`GET /v1/sessions`；M65-02 手机端补上）。
/// 返回原样 JSON 文本：分页与标题字段的契约在 TS 侧，Rust 只搬运不解析。
#[tauri::command]
pub async fn list_sessions(limit: Option<u32>, cursor: Option<String>) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_sessions(limit.unwrap_or(20), cursor.as_deref())
        .await
        .map_err(|e| e.to_string())
}
