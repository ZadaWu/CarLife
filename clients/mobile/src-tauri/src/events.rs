//! 下行流 fan-out（施工单 A3，对齐 M2-04）。
//!
//! # 与 cockpit 的关系：**投影逻辑共享，Tauri 胶水各自写**
//!
//! 事件 → 桥接动作的投影在 `carlife_core::fanout::apply`，两端共用同一份
//! （§10「`clients/shared/rust/` 为 mobile 与 cockpit 复用」）。本文件只做 Tauri 侧的
//! emit 与后台 task 管理——这部分依赖 `AppHandle`，抽不进 crate。
//!
//! # 与 cockpit 的关系（二）：播报与 idle 抑制（M65-04 起对齐）
//!
//! 有正文且未静音时，本轮投影出的 `Idle` **不直出**，交给播放结束驱动——否则
//! turn_end 那一下先把助手打回 idle，下一帧起播又变 speaking，肉眼就是一次闪烁。
//! 判定抽成 [`speech_plan`]（纯函数，可单测）；播报核在共享 crate `carlife_tts`
//! （清洗 / 端点缓存 / 代际 / rodio），这里只提供网关地址、设备 JWT 和状态发射器。
//! 与车机的差别：不播垫场话（`Filler` 仍只透出事件）、无 ducking / AEC / say。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use carlife_core::cache::MessageCache;
use carlife_core::contract::{AssistantState, ChatRole};
use carlife_core::contract::samples::sample_envelopes;
use carlife_core::fanout::{
    apply, BridgeAction, TurnAccumulator, EVENT_ASSISTANT_STATE, EVENT_DIALOG_DELTA,
    EVENT_DIALOG_MESSAGE, EVENT_NET_CONNECTION,
};
use carlife_net::{SseClient, SseSignal};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionState {
    pub state: &'static str, // "online" | "reconnecting"
}

/// 下行流状态：当前至多一路活跃流 + 共享缓存 + 计数器。
pub struct StreamState {
    pub cache: Arc<MessageCache>,
    active_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub unknown_events: AtomicU64,
    pub cache_errors: AtomicU64,
}

impl StreamState {
    pub fn new(cache: MessageCache) -> Self {
        Self {
            cache: Arc::new(cache),
            active_stop: Mutex::new(None),
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

    let tts = app.try_state::<Arc<carlife_tts::TtsState>>();
    let muted = tts.as_ref().map_or(true, |t| t.is_muted());
    let plan = speech_plan(&actions, muted);

    for action in &actions {
        if plan.suppress_idle && matches!(action, BridgeAction::AssistantState(AssistantState::Idle)) {
            continue; // 抑制：由播放结束驱动 idle
        }
        emit_action(app, action, &state.unknown_events);
    }

    if let (Some(text), Some(tts)) = (plan.speak, tts) {
        let (base_url, token) = crate::settings::gateway();
        let emitter = app.clone();
        let ctx = carlife_tts::SpeakCtx {
            base_url,
            token,
            on_state: Arc::new(move |st| {
                if let Err(e) = emitter.emit(EVENT_ASSISTANT_STATE, st) {
                    eprintln!("[tts] emit state failed: {e}");
                }
            }),
        };
        carlife_tts::speak(&ctx, &tts, &text);
    }
}

/// 这一批 action 要不要播、播什么、要不要压掉 idle。
///
/// 纯函数：`handle_envelope` 里能单测的就这一段，播放本身在共享 crate 里另有用例。
/// 正文取本批里**第一条**助手消息（`MessageAppended` 且 role=Assistant）——
/// turn_end 一批里正常只有一条；有多条时播第一条，与车机 `events.rs` 同一取法。
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SpeechPlan {
    /// 要播的正文；`None` = 本批没有助手正文或已静音。
    pub speak: Option<String>,
    /// 是否压掉本批投影出的 `Idle`——**只在真的要播时**为真，否则助手会卡在上一状态。
    pub suppress_idle: bool,
}

pub(crate) fn speech_plan(actions: &[BridgeAction], muted: bool) -> SpeechPlan {
    let reply = actions.iter().find_map(|a| match a {
        BridgeAction::MessageAppended(m) if matches!(m.role, ChatRole::Assistant) => Some(m.content.clone()),
        _ => None,
    });
    match (reply, muted) {
        (Some(text), false) => SpeechPlan { speak: Some(text), suppress_idle: true },
        _ => SpeechPlan { speak: None, suppress_idle: false },
    }
}

/// 启动真实 SSE 消费循环（后台 task；替换旧流）。
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

#[cfg(test)]
mod speech_plan_tests {
    use super::{speech_plan, SpeechPlan};
    use carlife_core::contract::{AssistantState, ChatMessage, ChatRole, MessageSource};
    use carlife_core::fanout::BridgeAction;

    fn msg(role: ChatRole, content: &str) -> BridgeAction {
        BridgeAction::MessageAppended(ChatMessage {
            message_id: "m1".into(),
            session_id: "s1".into(),
            turn_id: "t1".into(),
            role,
            source: MessageSource::Text,
            content: content.into(),
            ts: 0,
            cancelled: None,
        })
    }
    fn idle() -> BridgeAction {
        BridgeAction::AssistantState(AssistantState::Idle)
    }

    /// 有正文且未静音：播它，并压掉本批的 idle——否则 turn_end 先打回 idle、起播再变 speaking，一次闪烁。
    #[test]
    fn 未静音且有正文_播且压idle() {
        let plan = speech_plan(&[msg(ChatRole::Assistant, "前方拥堵"), idle()], false);
        assert_eq!(plan, SpeechPlan { speak: Some("前方拥堵".into()), suppress_idle: true });
    }

    /// 静音：什么都不播，idle **照常直出**——压了的话助手会卡在上一状态，永远回不到 idle。
    #[test]
    fn 静音_不播且不压idle() {
        let plan = speech_plan(&[msg(ChatRole::Assistant, "前方拥堵"), idle()], true);
        assert_eq!(plan, SpeechPlan { speak: None, suppress_idle: false });
    }

    /// 本批没有助手正文（只有用户的 ASR 原文或纯状态）：不播、不压。
    #[test]
    fn 无助手正文_不播不压() {
        assert_eq!(speech_plan(&[msg(ChatRole::User, "去广州塔"), idle()], false), SpeechPlan { speak: None, suppress_idle: false });
        assert_eq!(speech_plan(&[idle()], false), SpeechPlan { speak: None, suppress_idle: false });
    }
}
