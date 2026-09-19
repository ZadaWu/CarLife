//! 下行流 fan-out（施工单 A3，对齐 M2-04）。
//!
//! # 与 cockpit 的关系：**投影逻辑共享，Tauri 胶水各自写**
//!
//! 事件 → 桥接动作的投影在 `carlife_core::fanout::apply`，两端共用同一份
//! （§10「`clients/shared/rust/` 为 mobile 与 cockpit 复用」）。本文件只做 Tauri 侧的
//! emit 与后台 task 管理——这部分依赖 `AppHandle`，抽不进 crate。
//!
//! # 与 cockpit 的关系（二）：手机端**没有本地播报**
//!
//! F-02-12 的定调是「车机播报 / 手机静默」。M65-04 曾接过一版共享核 `carlife-tts`
//! （开关 + 音量），2026-09-17 按产品决定撤掉：手机常在公共场合，出声是打扰，
//! 而系统音量键又会连着音乐、通知一起动。所以本轮投影出的 `Idle` 直出，
//! 没有"等播完再回 idle"那一段；`Filler` 仍只透出事件不播。要再接播报，
//! 共享核还在 `clients/shared/rust/carlife-tts`，接线点是这里的 `handle_envelope`。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use carlife_core::cache::MessageCache;
use carlife_core::contract::samples::sample_envelopes;
use carlife_core::fanout::{
    apply, BridgeAction, TurnAccumulator, EVENT_ASSISTANT_STATE, EVENT_DIALOG_DELTA,
    EVENT_DIALOG_MESSAGE, EVENT_NET_CONNECTION,
};
use carlife_net::{SseClient, SseSignal, UserSseSignal};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionState {
    pub state: &'static str, // "online" | "reconnecting"
}

/// 下行流状态：当前至多一路活跃流 + 共享缓存 + 计数器。
pub struct StreamState {
    pub cache: Arc<MessageCache>,
    active_stop: Mutex<Option<Arc<AtomicBool>>>,
    /// 账号级事件流的停止位（ACR-033）。
    ///
    /// **与 `active_stop` 分开**：会话流每换一次会话就被替换，而这条流与登录态同寿。
    /// 共用一个的话，每次新建会话都会顺手把账号通道掐掉——现象是"同步时灵时不灵"。
    user_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub unknown_events: AtomicU64,
    pub cache_errors: AtomicU64,
}

impl StreamState {
    pub fn new(cache: MessageCache) -> Self {
        Self {
            cache: Arc::new(cache),
            active_stop: Mutex::new(None),
            user_stop: Mutex::new(None),
            unknown_events: AtomicU64::new(0),
            cache_errors: AtomicU64::new(0),
        }
    }

    /// 替换活跃流：停掉上一路，返回新的停止标志。
    ///
    /// **先停旧的再挂新的**，不是并存：两路流同时往同一个缓存写，
    /// 会把同一条消息按不同顺序落两次。
    pub fn replace_stream(&self) -> Arc<AtomicBool> {
        let stop = Arc::new(AtomicBool::new(false));
        let mut guard = self.active_stop.lock().expect("stream state poisoned");
        if let Some(prev) = guard.replace(Arc::clone(&stop)) {
            prev.store(true, Ordering::Relaxed);
        }
        stop
    }

    /// 换一条账号级事件流，旧的置停（ACR-033）。重复调用不会留下两条。
    pub fn replace_user_stream(&self) -> Arc<AtomicBool> {
        let stop = Arc::new(AtomicBool::new(false));
        let mut guard = self.user_stop.lock().expect("stream state poisoned");
        if let Some(prev) = guard.replace(Arc::clone(&stop)) {
            prev.store(true, Ordering::Relaxed);
        }
        stop
    }
}

fn emit_action(app: &AppHandle, action: &BridgeAction, unknown: &AtomicU64) {
    let result = match action {
        BridgeAction::AssistantState(state) => app.emit(EVENT_ASSISTANT_STATE, state),
        BridgeAction::Delta(delta) => app.emit(EVENT_DIALOG_DELTA, delta),
        BridgeAction::MessageAppended(msg) => app.emit(EVENT_DIALOG_MESSAGE, msg),
        // M13-05 契约跟进：投影层不再忽略 permission。手机端确认 UI（演示壳）仍未接线，
        // 这里只把事件透出去，接线归后续工单——桥接层不该替 UI 决定丢事件。
        BridgeAction::PermissionRequested(p) => {
            app.emit(carlife_core::fanout::EVENT_DIALOG_PERMISSION, p)
        }
        // 等待期垫场话（M18-01）：手机端**没有 TTS 模块**（播报只在车机端，§2.3），
        // 所以这里不播、只透出事件——与上面 permission 同一取向：
        // 桥接层不该替 UI 决定丢事件。手机端要不要用它归后续工单。
        BridgeAction::Filler(f) => app.emit(carlife_core::fanout::EVENT_DIALOG_FILLER, f),
        // 工具进展（F-08-05）：透传给对话层显示"正在查天气"。
        // **不播报**——它是给眼睛看的，念出来会把等待期变得更吵，
        // 而填等待的声音那一路已经有垫场话了。
        BridgeAction::ToolCall(t) => app.emit(carlife_core::fanout::EVENT_DIALOG_TOOL_CALL, t),
        // 会话标题（M28-01）：透传给 WebView 更新左侧历史列表。
        // **不播报**——它是给眼睛看的一个名字，念出来只会在收口后多一句废话。
        BridgeAction::SessionTitle(t) => app.emit(carlife_core::fanout::EVENT_DIALOG_TITLE, t),
        // 分支起止（M37-01）：手机端 UI 尚未接线，只透出事件——
        // 与 permission/filler 同一取向：桥接层不该替 UI 决定丢事件。
        BridgeAction::Branch(b) => app.emit(carlife_core::fanout::EVENT_DIALOG_BRANCH, b),
        BridgeAction::Ignored(kind) => {
            // 映射不到的事件：忽略并计数，**不抛错**（FL-01 F-01-08 边界）——
            // 服务端加了新事件类型不该让端上崩溃。
            unknown.fetch_add(1, Ordering::Relaxed);
            let _ = kind;
            Ok(())
        }
    };
    if let Err(e) = result {
        eprintln!("[mobile] emit bridge action failed: {e}");
    }
}

/// 处理一个封套：投影 + 双写 + emit。真实 SSE 与 mock 共用同一条路径。
///
/// 缓存写失败**不阻塞 emit**：界面该更新还是要更新，差异由回源
/// （`refresh_history`）修复。反过来会让一次写盘抖动变成界面卡死。
pub fn handle_envelope(
    app: &AppHandle,
    state: &StreamState,
    env: &carlife_core::contract::EventEnvelope,
    acc: &mut TurnAccumulator,
) {
    let (actions, errors) = apply(env, &state.cache, acc);
    for err in &errors {
        state.cache_errors.fetch_add(1, Ordering::Relaxed);
        eprintln!("[mobile] message cache write failed (回源可修复): {err}");
    }

    for action in &actions {
        emit_action(app, action, &state.unknown_events);
    }
}

/// 启动真实 SSE 消费循环（后台 task；替换旧流）。
/// 账号级事件推给 WebView 的事件名（ACR-033）。
///
/// **与 `contracts` 的 `ACCOUNT_EVENTS.sessionsChanged`、以及车机端那份是同一个字面量**
/// （`clients/mobile/test/account-events.test.ts` 钉住）。它不在 `BRIDGE_EVENTS` 里——
/// 那一组是对话桥，本事件来自另一条流，理由见常量旁的注释。
pub const EVENT_SESSIONS_CHANGED: &str = "session:list-changed";

#[derive(Debug, Clone, Serialize)]
pub struct SessionsChangedPayload {
    pub reason: String,
}

/// 账号级事件流（ACR-033）：连上 `/v1/events`，收到就让前端整拉会话列表。
///
/// 与车机端同形。手机是个人设备、token 自带身份，所以不需要 `x-carlife-session`，
/// 也没有"换人要重起"这一处——共享层里那段取不到会话时不带头，对这边无影响。
pub fn spawn_user_events_stream(app: AppHandle, state: Arc<StreamState>, base_url: String) {
    let stop = state.replace_user_stream();
    tauri::async_runtime::spawn(async move {
        // token 现取（M54-09）：这条流比 access token 活得久。
        let client = SseClient::new_with_token_source(base_url, || crate::settings::gateway().1);
        client
            .run_user_events(&stop, |signal| match signal {
                UserSseSignal::Envelope(env) => {
                    let carlife_core::contract::UserEvent::SessionsChanged(changed) = env.event;
                    let _ = app.emit(
                        EVENT_SESSIONS_CHANGED,
                        SessionsChangedPayload { reason: format!("{:?}", changed.reason) },
                    );
                }
                UserSseSignal::Unauthorized => {
                    // 不动 EVENT_NET_CONNECTION：那条说的是**对话**通不通，
                    // 而这条断了只是列表不自动刷新，对话一切照常。
                    eprintln!("[sse] 账号事件流被网关拒绝（凭证过期或失效），已停止重连");
                }
                UserSseSignal::NoActiveUser => {
                    // 手机端理论上不会走到这里（token 自带身份）；真走到了说明登录态不对。
                    eprintln!("[sse] 账号事件流：服务端说没有活跃用户，按长间隔重试");
                }
                UserSseSignal::Disabled => {
                    eprintln!("[sse] 账号事件流被服务端关闭（ACCOUNT_EVENTS_ENABLED=false），按长间隔重试");
                }
                UserSseSignal::Connected | UserSseSignal::Disconnected { .. } => {}
                UserSseSignal::Unparseable => {
                    state.unknown_events.fetch_add(1, Ordering::Relaxed);
                }
            })
            .await;
    });
}

pub fn spawn_session_stream(
    app: AppHandle,
    state: Arc<StreamState>,
    base_url: String,
    token: String,
    session_id: String,
) {
    let stop = state.replace_stream();
    tauri::async_runtime::spawn(async move {
        /*
         * token 现取（M54-09）：这个流以进程同寿，而 access token 只活 15 分钟。
         * 传快照的话，过期后每秒一次 401 重连、永远连不回来——保鲜循环换的
         * 新 token 它拿不到。`token` 入参保留是为了不动上游签名（多处调用），
         * 但只作"此刻已登录"的证据，连接用的恒是现取值。
         */
        let _ = token;
        let client = SseClient::new_with_token_source(base_url, || crate::settings::gateway().1);
        let mut acc = TurnAccumulator::default();
        client
            .run(&session_id, &stop, |signal| match signal {
                SseSignal::Connected => {
                    let _ = app.emit(EVENT_NET_CONNECTION, ConnectionState { state: "online" });
                }
                SseSignal::Disconnected { .. } => {
                    let _ =
                        app.emit(EVENT_NET_CONNECTION, ConnectionState { state: "reconnecting" });
                }
                SseSignal::Unauthorized => {
                    // 凭证被拒，流已自行停止。报 offline 让界面如实显示；
                    // 端上重建会话（发消息/重新声明）会 spawn 新流替换本条。
                    eprintln!("[sse] 会话流被网关拒绝（凭证过期或失效），已停止重连");
                    let _ = app.emit(EVENT_NET_CONNECTION, ConnectionState { state: "offline" });
                }
                SseSignal::Envelope(env) => handle_envelope(&app, &state, &env, &mut acc),
                SseSignal::Unparseable => {
                    state.unknown_events.fetch_add(1, Ordering::Relaxed);
                }
            })
            .await;
    });
}

/// mock 事件驱动器（开发模式）：标准样例序列走**同一条** fan-out 路径。
///
/// 走同一条路径是刻意的：mock 与真实流分两套实现时，mock 下调通的界面
/// 在真流上照样会坏，而那时已经没人记得两套哪里不一样。
pub fn run_mock_stream(app: &AppHandle, state: &StreamState) {
    let mut acc = TurnAccumulator::default();
    for env in sample_envelopes() {
        handle_envelope(app, state, &env, &mut acc);
    }
}
