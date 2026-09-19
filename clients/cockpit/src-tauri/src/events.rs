//! emit 流式事件到前端（fan-out: 助手状态机 + 对话记录）——施工单 M2-04。
//!
//! 架构 §2.2 B2 的落点：单一入口消费事件流（真实 SSE 或 mock 样例，
//! **两者走同一条 `fanout::apply` 路径**），投影为桥接事件 emit 给 WebView，
//! 同时把消息双写进 carlife-core 的 SQLite 缓存。
//!
//! 一致性策略（M2-04 约束 1）：缓存写失败不阻塞 emit，错误计数上抛，
//! 差异由回源（`refresh_history`）修复。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use carlife_core::cache::MessageCache;
use carlife_core::contract::samples::sample_envelopes;
use carlife_core::fanout::{
    apply, BridgeAction, TurnAccumulator, EVENT_ASSISTANT_STATE, EVENT_DIALOG_DELTA,
    EVENT_DIALOG_FILLER,
    EVENT_DIALOG_MESSAGE, EVENT_DIALOG_PERMISSION, EVENT_NET_CONNECTION,
};
use carlife_net::{SseClient, SseSignal, UserSseSignal};
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
    /// 垫场播报被正文抢占的次数（M18-05，F-45-15）。
    ///
    /// **被抢占率是这个功能真正的效果指标**：抢得越早说明静默阈值定得越激进；
    /// 一次都没被抢占过，说明阈值太保守、垫场只在极长等待时才出现。
    pub filler_preempted: AtomicU64,
    /**
     * 此刻在跑的那一轮 `(sessionId, turnId)`（施工单 M33-02）。
     *
     * 打断要发 `POST /v1/session/:id/cancel`，而端上此前**根本不记得自己在哪一轮**：
     * `TurnAccumulator` 按 turnId 攒文本，但它不告诉外面"当前是哪个"。
     * 由 `handle_envelope` 在 prompt / delta 上写，在 turn_end / retract 上清。
     */
    current: Mutex<Option<(String, String)>>,
    /**
     * 已经被本端打断的轮（施工单 M33-02）。
     *
     * **按 turnId 判，不按时间判**：SSE 断线重连会补发，"时间上更晚"的旧事件
     * 照样会到。有界保留最近 `CANCELLED_KEEP` 条——补发窗口不会更长，
     * 无界的话它就是一个只增不减的集合。
     */
    /// 账号级事件流的停止位（ACR-032）。
    ///
    /// **与 `active_stop` 分开**：会话流每换一次会话就被替换，而这条流与"谁在用车"
    /// 同寿。共用一个停止位的话，每次新建会话都会顺手把账号通道也掐掉，
    /// 而现象是"同步时灵时不灵"——最难查的那一种。
    user_stop: Mutex<Option<Arc<AtomicBool>>>,
    cancelled_turns: Mutex<VecDeque<String>>,
    /// 因为属于已打断的轮而被整条丢弃的事件数。取消到收口之间总会漏进来几条，
    /// 这个数不为 0 是正常的；**恒为 0 才说明过滤压根没生效**。
    pub dropped_cancelled: AtomicU64,
}

/// 打断记录保留几条。取消之后到达的旧轮事件都在很短的窗口里，8 条绰绰有余。
const CANCELLED_KEEP: usize = 8;

impl StreamState {
    pub fn new(cache: MessageCache) -> Self {
        Self {
            cache: Arc::new(cache),
            active_stop: Mutex::new(None),
            unknown_events: AtomicU64::new(0),
            cache_errors: AtomicU64::new(0),
            filler_preempted: AtomicU64::new(0),
            current: Mutex::new(None),
            user_stop: Mutex::new(None),
            cancelled_turns: Mutex::new(VecDeque::new()),
            dropped_cancelled: AtomicU64::new(0),
        }
    }

    /// 此刻在跑的那一轮。没有则 None（空闲、或上一轮已收口）。
    pub fn current_turn(&self) -> Option<(String, String)> {
        self.current.lock().expect("stream state poisoned").clone()
    }

    fn set_current_turn(&self, session_id: &str, turn_id: &str) {
        let mut cur = self.current.lock().expect("stream state poisoned");
        // 同一轮反复写没有意义（delta 一秒几十条），只在换轮时动。
        if cur.as_ref().map(|(_, t)| t.as_str()) != Some(turn_id) {
            *cur = Some((session_id.to_string(), turn_id.to_string()));
        }
    }

    fn clear_current_turn(&self, turn_id: &str) {
        let mut cur = self.current.lock().expect("stream state poisoned");
        // 只清自己那一轮：下一轮可能已经开始了（受理很快）。
        if cur.as_ref().map(|(_, t)| t.as_str()) == Some(turn_id) {
            *cur = None;
        }
    }

    /// 记下"这一轮被我打断了"。之后到达的它的事件一律丢弃。
    pub fn mark_cancelled(&self, turn_id: &str) {
        let mut q = self.cancelled_turns.lock().expect("stream state poisoned");
        if q.iter().any(|t| t == turn_id) {
            return;
        }
        q.push_back(turn_id.to_string());
        while q.len() > CANCELLED_KEEP {
            q.pop_front();
        }
    }

    pub fn is_cancelled(&self, turn_id: &str) -> bool {
        self.cancelled_turns
            .lock()
            .expect("stream state poisoned")
            .iter()
            .any(|t| t == turn_id)
    }

    /// 替换活跃流：停掉上一路，返回新的停止标志。
    pub fn replace_stream(&self) -> Arc<AtomicBool> {
        let stop = Arc::new(AtomicBool::new(false));
        let mut guard = self.active_stop.lock().expect("stream state poisoned");
        if let Some(prev) = guard.replace(Arc::clone(&stop)) {
            prev.store(true, Ordering::Relaxed);
        }
        stop
    }

    /// 换一条账号级事件流，旧的置停（ACR-032）。
    ///
    /// 上车声明换了人就要换这条流：它订阅的键是**人**，而服务端按连接建立时的
    /// 那个人订阅。不换的话，换人之后收到的还是上一个人的会话变动。
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
        // HITL 确认请求（M13-05）：透传给 WebView 弹确认层。
        BridgeAction::PermissionRequested(p) => app.emit(EVENT_DIALOG_PERMISSION, p),
        // 等待期垫场话（M18-01 定形，M18-05 接播报）。
        BridgeAction::Filler(f) => {
            if let Some(tts) = app.try_state::<std::sync::Arc<crate::tts::TtsState>>() {
                crate::tts::speak_filler(app, &tts, &f.text, f.interruptible);
            }
            app.emit(EVENT_DIALOG_FILLER, f)
        }
        // 工具进展（F-08-05）：透传给对话层显示"正在查天气"。
        // **不播报**——它是给眼睛看的，念出来会把等待期变得更吵，
        // 而填等待的声音那一路已经有垫场话了。
        BridgeAction::ToolCall(t) => app.emit(carlife_core::fanout::EVENT_DIALOG_TOOL_CALL, t),
        // 会话标题（M28-01）：透传给 WebView 更新左侧历史列表。
        // **不播报**——它是给眼睛看的一个名字，念出来只会在收口后多一句废话。
        BridgeAction::SessionTitle(t) => app.emit(carlife_core::fanout::EVENT_DIALOG_TITLE, t),
        // 分支起止（M37-01）：透传给对话层出"部分结果"标识。
        // **不播报、不进历史**——failed/timeout 的告知话术由应答正文承担（M37-02），
        // 这里只负责让结构化标识可见。
        BridgeAction::Branch(b) => app.emit(carlife_core::fanout::EVENT_DIALOG_BRANCH, b),
        BridgeAction::Ignored(kind) => {
            // 映射不到的事件：忽略并计数，不抛错（FL-01 F-01-08 边界）
            unknown.fetch_add(1, Ordering::Relaxed);
            let _ = kind;
            Ok(())
        }
    };
    if let Err(e) = result {
        eprintln!("[cockpit] emit bridge action failed: {e}");
    }
}

/**
 * 这条事件属于哪一轮（施工单 M33-02）。
 *
 * `session` 不属于任何一轮，返回 None——它是会话级的。
 * 其余五类都带 turnId，**新增事件类型时这里的 match 会编译失败**，
 * 那是刻意的：一个不知道自己属于哪一轮的事件，打断时就过滤不掉。
 */
fn turn_id_of(event: &carlife_core::contract::SessionEvent) -> Option<&str> {
    use carlife_core::contract::{SessionEvent, SessionUpdate};
    match event {
        SessionEvent::Session(_) => None,
        SessionEvent::Prompt(p) => Some(&p.turn_id),
        /*
         * 权限确认与工具进展的载荷里**没有 turnId**（契约如此）。
         * 返回 None = 不被打断过滤掉，这是对的那一边：
         * 权限门的挂起即使跨在打断上也必须让用户看见——它是有后果动作的
         * 最后一道闸门，宁可多弹一次也不能吞掉一次。
         */
        SessionEvent::Permission(_) => None,
        SessionEvent::ToolCall(_) => None,
        SessionEvent::Update(u) => match u {
            SessionUpdate::Delta(d) => Some(&d.turn_id),
            SessionUpdate::TurnEnd(e) => Some(&e.turn_id),
            SessionUpdate::Branch(b) => Some(&b.turn_id),
            SessionUpdate::Retract(r) => Some(&r.turn_id),
            SessionUpdate::Filler(f) => Some(&f.turn_id),
            // 状态与标题不带轮次：前者是助手状态机的信号（打断本身就要发它），
            // 后者是会话级的名字。两者都不该被打断过滤掉。
            SessionUpdate::State(_) => None,
            SessionUpdate::Title(_) => None,
        },
    }
}

/// 这条事件是不是"这一轮到此为止"（M33-02）。收口与撤回都算。
fn end_of_turn(event: &carlife_core::contract::SessionEvent) -> Option<&str> {
    use carlife_core::contract::{SessionEvent, SessionUpdate};
    match event {
        SessionEvent::Update(SessionUpdate::TurnEnd(e)) => Some(&e.turn_id),
        SessionEvent::Update(SessionUpdate::Retract(r)) => Some(&r.turn_id),
        _ => None,
    }
}

/// 这条事件是不是撤回（F-26-06）。
///
/// 抽成函数是为了能单测：真正的判据写在 `handle_envelope` 里时，
/// 验它就得造一个 `AppHandle`，于是实际上没人验。
fn is_retract(event: &carlife_core::contract::SessionEvent) -> bool {
    use carlife_core::contract::{SessionEvent, SessionUpdate};
    matches!(event, SessionEvent::Update(SessionUpdate::Retract(_)))
}

/// 处理一个封套：投影 + 双写 + emit。真实 SSE 与 mock 共用（M2-04 约束 3）。
///
/// TTS 收口（M2-05）：助手消息产生且播报可用时，`turn_end` 投影出的
/// `idle` 被抑制——状态交给播放起止驱动（speaking → 播完 idle），
/// 避免 idle→speaking 闪烁；播报不可用时按原映射回落 idle。
pub fn handle_envelope(
    app: &AppHandle,
    state: &StreamState,
    env: &carlife_core::contract::EventEnvelope,
    acc: &mut TurnAccumulator,
) {
    /*
     * 打断过的轮：整条丢弃（施工单 M33-02）。
     *
     * **在 `apply` 之前**——进了它就已经写缓存、已经推进 `TurnAccumulator` 了，
     * 之后再丢只是没 emit，历史里那半句还是会多出一截。
     *
     * 按 turnId 判而不是按时间判：SSE 重连补发会让"时间上更晚"的旧事件到达
     * （M18-04 把 filler 排除出补发窗口，但 delta 在窗口里）。
     */
    if let Some(turn_id) = turn_id_of(&env.event) {
        if state.is_cancelled(turn_id) {
            state.dropped_cancelled.fetch_add(1, Ordering::Relaxed);
            return;
        }
        // 记下"此刻在哪一轮"，供打断时发取消用（`prompt` 是这一轮最早的事件）。
        state.set_current_turn(&env.session_id, turn_id);
    }

    let (actions, errors) = apply(env, &state.cache, acc);
    /*
     * 轮次收口就把"当前轮"清掉（M33-02）。
     *
     * 不清的话，车主在**空闲时**点一下暖暖会给一个早已结束的 turnId 发取消——
     * 服务端那边回 `turnId: null`（无害），但端上会把它记进 `cancelled_turns`，
     * 于是那一轮的**补发事件**在重连后被静默丢弃，历史看起来缺一截。
     */
    if let Some(turn_id) = end_of_turn(&env.event) {
        state.clear_current_turn(turn_id);
    }
    for err in &errors {
        state.cache_errors.fetch_add(1, Ordering::Relaxed);
        eprintln!("[cockpit] message cache write failed (回源可修复): {err}");
    }

    /*
     * 这一条是不是撤回（F-26-06）。
     *
     * 撤回撤的是**内容本身**，不是"屏幕上的那段字"。边收边播接上之后
     * （M77 走查追修第二步），正文在撤回到达时多半已经有几句进了播放队列，
     * 而那条路上没有任何一步会因为撤回停下来：`stream_finish` 只"补差额"，
     * 替换文案比正文短、又不是它的前缀，于是一个字都不补——队列照播，
     * **被审核拦下的原文被完整念完**，屏幕上却写着"这条回答我收回了"。
     * 2026-09-19 车机端实测就是这个样子（用户：语音回答是另外一个）。
     */
    let is_retract = is_retract(&env.event);

    let assistant_reply = actions.iter().find_map(|a| match a {
        BridgeAction::MessageAppended(m)
            if matches!(m.role, carlife_core::contract::ChatRole::Assistant) =>
        {
            Some(m.content.clone())
        }
        _ => None,
    });
    let will_speak = assistant_reply.is_some()
        && crate::tts::enabled()
        && app
            .try_state::<std::sync::Arc<crate::tts::TtsState>>()
            .is_some_and(|s| !s.is_muted());

    /*
     * 正文一到就抢占垫场播报（M18-05，F-45-07 / AC-45-3）。
     *
     * **在遍历之前先停**：放进循环里就要等这一批 action 处理完才停，
     * 又多出几十毫秒的声画重叠。
     *
     * 判决在端上而不是服务端：网络抖动会让"服务端先发停止指令再发正文"失序，
     * 而端上拿到第一个 Delta 那一刻是确定的。
     */
    if actions.iter().any(|a| matches!(a, BridgeAction::Delta(_))) {
        if let Some(tts) = app.try_state::<std::sync::Arc<crate::tts::TtsState>>() {
            /*
             * 掐不掐要两个条件同时成立（M18-06 约束 1）：
             *  - `mode == Immediate`：**用户偏好**，默认是 `AfterSentence`（衔接）；
             *  - `interruptible`：**内容属性**，这句话本身能不能被打断。
             * 将来出现告警类垫场时后者会是 false，与用户选了什么无关。
             *
             * 衔接模式下这里什么都不做，改由 `speak()` 在播正文前等它说完。
             */
            if crate::tts::should_preempt(tts.preempt_mode(), tts.filler_interruptible())
                && crate::tts::stop_if_filler(&tts)
            {
                state.filler_preempted.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /*
     * 边收边播（M77 走查追修第二步，2026-09-12）。**后台开关关着时这一段整个不执行**，
     * 老路径一行没变。
     *
     * 每条 delta 一到就喂进流式队列，成句即送去合成——首声于是约等于
     * "模型说完第一句"，而不是"说完整段再花 14 秒合成"。
     *
     * 敢拿 delta 去播，是因为它**已经是脱敏后的文本**（runtime 那侧
     * `createStreamRedactor()` 逐片 push），且网关把 delta 累加成 assistantText
     * 落库——播出去的与存下来的一字不差。
     */
    if crate::tts::endpoint::stream_speech_cached() {
        if let (Some(turn), Some(tts)) = (
            turn_id_of(&env.event),
            app.try_state::<std::sync::Arc<crate::tts::TtsState>>(),
        ) {
            for action in &actions {
                if let BridgeAction::Delta(d) = action {
                    // 幂等：一轮只起一个消费任务（内部抢闸）。
                    crate::tts::stream_begin(app, &tts, turn);
                    crate::tts::stream_push(&tts, turn, &d.text);
                }
            }
        }
    }

    for action in &actions {
        if will_speak {
            if let BridgeAction::AssistantState(carlife_core::contract::AssistantState::Idle) =
                action
            {
                continue; // 抑制：由播放结束驱动 idle
            }
        }
        emit_action(app, action, &state.unknown_events);
    }

    if let Some(text) = assistant_reply {
        if let Some(tts) = app.try_state::<std::sync::Arc<crate::tts::TtsState>>() {
            let turn = turn_id_of(&env.event);
            /*
             * 撤回先掐声再说话。
             *
             * `stop()` 一次做完三件事：推代际让在播的那段自己退出、`stream.abandon()`
             * 清掉队列与半句尾巴、halt 当前播放。**无条件调**——播报开关关着、
             * 静音着的时候它也没有副作用，而漏掉的那条路径恰恰是最坏的那条。
             *
             * 停完才播替换文案：不播的话，车主听到正文被从中间掐断、然后一片安静，
             * 只有低头看屏幕才知道发生了什么——而他在开车。
             */
            if is_retract {
                let _ = crate::tts::stop(&tts);
                if will_speak {
                    crate::tts::speak(app, &tts, &text);
                }
                return;
            }
            /*
             * 这一轮是不是已经在流式播了（M77 走查追修第二步）。
             *
             * **按 turnId 判，不按"消费任务还在不在"判**：回答短的时候，
             * 消费任务可能在 turn_end 之前就播完退出了，那时若按 running 判，
             * 这里会再整段播一遍，车主听到两遍。
             *
             * 判完**不清归属**：下一轮的 turnId 本来就不同，`owns` 自然为假，
             * 而 `begin` 会覆盖它。清了反而多一个险处——同一轮若有迟到的 delta，
             * 会被当成新一轮，把正在播的自己 stop 掉。
             */
            match turn {
                Some(t) if tts.stream.owns(t) => {
                    // 把最后那半句送出去并收尾。**不再调 speak**——那会是第二遍。
                    crate::tts::stream_finish(&tts, t, Some(&text));
                }
                _ if will_speak => crate::tts::speak(app, &tts, &text),
                _ => {}
            }
        }
    }
}

/// 启动真实 SSE 消费循环（后台 task；替换旧流）。
/// 账号级事件推给 WebView 的事件名（ACR-032）。
///
/// **与 `contracts` 的 `ACCOUNT_EVENTS.sessionsChanged` 是同一个字面量**，
/// 改一处必须改另一处（`clients/cockpit/test/account-events.test.ts` 钉住）。
/// 它**不在 `BRIDGE_EVENTS`** 里——那一组是对话桥，这条来自另一条流，理由见常量旁的注释。
///
/// 载荷刻意只有 `reason`：通道的语义是「整拉」，端上拿到它只做一件事——
/// 重新 `GET /v1/sessions`。带上会话摘要会诱导前端去做增量合并，
/// 而那正是乱序与漏更新的来源。
pub const EVENT_SESSIONS_CHANGED: &str = "session:list-changed";

#[derive(Debug, Clone, Serialize)]
pub struct SessionsChangedPayload {
    pub reason: String,
}

/// 账号级事件流（ACR-032）：连上 `/v1/events`，收到就让前端重拉会话列表。
///
/// 与 `spawn_session_stream` 各跑各的、各有各的停止位——会话流每换一次会话被替换，
/// 这条与"谁在用车"同寿。
pub fn spawn_user_events_stream(app: AppHandle, state: Arc<StreamState>, base_url: String) {
    let stop = state.replace_user_stream();
    tauri::async_runtime::spawn(async move {
        // token 现取，理由同会话流（M54-09）：这条流比 access token 活得久。
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
                    // 不动 EVENT_NET_CONNECTION：那条指示的是**对话**通不通，
                    // 而账号通道断了只是列表不会自动刷新，对话一切照常。
                    // 混在一起会让界面在对话好好的时候显示"离线"。
                    eprintln!("[sse] 账号事件流被网关拒绝（凭证过期或失效），已停止重连");
                }
                UserSseSignal::NoActiveUser => {
                    // 正常态：车机开机、还没人上车。上车声明落地后前端会重起这条流。
                    eprintln!("[sse] 账号事件流：还没人声明在用车，等上车声明（长间隔重试）");
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

/// mock 事件驱动器（开发模式）：标准样例序列走同一条 fan-out 路径。
pub fn run_mock_stream(app: &AppHandle, state: &StreamState) {
    let mut acc = TurnAccumulator::default();
    for env in sample_envelopes() {
        handle_envelope(app, state, &env, &mut acc);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use carlife_core::cache::MessageCache;
    use carlife_core::contract::{
        PromptAccepted, SessionEvent, SessionUpdate, UpdateDelta, UpdateState, UpdateTurnEnd,
    };

    fn state() -> StreamState {
        // 内存库：这一组测的全是 StreamState 自己的表，不碰缓存内容。
        StreamState::new(MessageCache::open_in_memory().expect("in-memory cache"))
    }

    fn delta(turn: &str) -> SessionEvent {
        SessionEvent::Update(SessionUpdate::Delta(UpdateDelta {
            turn_id: turn.into(),
            text: "x".into(),
        }))
    }

    #[test]
    fn 打断记录有界_只留最近八条() {
        let s = state();
        for i in 0..10 {
            s.mark_cancelled(&format!("t{i}"));
        }
        assert!(!s.is_cancelled("t0"), "最旧的两条被挤出去");
        assert!(!s.is_cancelled("t1"));
        for i in 2..10 {
            assert!(s.is_cancelled(&format!("t{i}")), "最近八条都还在");
        }
    }

    #[test]
    fn 重复标记同一轮不占额外名额() {
        let s = state();
        for _ in 0..20 {
            s.mark_cancelled("t1");
        }
        s.mark_cancelled("t2");
        assert!(s.is_cancelled("t1"), "被自己刷掉就说明去重没做");
        assert!(s.is_cancelled("t2"));
    }

    #[test]
    fn 当前轮由事件推出来_收口即清() {
        let s = state();
        assert_eq!(s.current_turn(), None, "空闲时没有当前轮——此时打断不发空取消");

        s.set_current_turn("sess-1", "t1");
        assert_eq!(s.current_turn(), Some(("sess-1".into(), "t1".into())));

        s.clear_current_turn("t1");
        assert_eq!(s.current_turn(), None);
    }

    #[test]
    fn 收口只清自己那一轮_下一轮可能已经开始() {
        let s = state();
        s.set_current_turn("sess-1", "t2");
        // 上一轮的 turn_end 姗姗来迟
        s.clear_current_turn("t1");
        assert_eq!(
            s.current_turn(),
            Some(("sess-1".into(), "t2".into())),
            "清错的话，紧接着的打断会退化成只停播"
        );
    }

    #[test]
    fn 只有撤回才掐声_收口与增量不掐() {
        use carlife_core::contract::UpdateRetract;
        let retract = SessionEvent::Update(SessionUpdate::Retract(UpdateRetract {
            turn_id: "t1".into(),
            replacement: "这条回答我先收回了".into(),
            reason: "审核不可用".into(),
        }));
        assert!(is_retract(&retract));
        // turn_end 走的是"补差额"那条路：它掐声的话，每一轮正常回答
        // 都会在收口那一刻被截断——最后半句永远听不到。
        assert!(!is_retract(&SessionEvent::Update(SessionUpdate::TurnEnd(
            UpdateTurnEnd {
                turn_id: "t1".into(),
                message_id: "m1".into(),
            }
        ))));
        assert!(!is_retract(&delta("t1")));
    }

    #[test]
    fn turn_id_of_五类带轮次_状态与会话不带() {
        let prompt = SessionEvent::Prompt(PromptAccepted {
            turn_id: "t1".into(),
            source: carlife_core::contract::MessageSource::Text,
            transcript: None,
            attachments: None,
        });
        assert_eq!(turn_id_of(&prompt), Some("t1"));
        assert_eq!(turn_id_of(&delta("t1")), Some("t1"));

        let end = SessionEvent::Update(SessionUpdate::TurnEnd(UpdateTurnEnd {
            turn_id: "t1".into(),
            message_id: "m1".into(),
        }));
        assert_eq!(turn_id_of(&end), Some("t1"));
        assert_eq!(end_of_turn(&end), Some("t1"));

        // 状态不带轮次：打断本身就要发 idle，被自己过滤掉就永远回不了位
        let idle = SessionEvent::Update(SessionUpdate::State(UpdateState {
            state: carlife_core::contract::AssistantState::Idle,
        }));
        assert_eq!(turn_id_of(&idle), None);
        assert_eq!(end_of_turn(&idle), None);
    }
}
