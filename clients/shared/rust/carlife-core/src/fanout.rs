//! fan-out 投影（施工单 M2-04，F-03-01 / F-01-08 的纯逻辑部分）。
//!
//! 架构 §2.2：同一路 `session/update` 事件 fan-out 给两个消费者——
//! 助手状态机 + 对话消息记录。本模块把"事件 → 桥接动作"的映射做成
//! **可单测的纯函数**；Tauri emit 与真实/mock 事件源的接线在
//! `clients/*/src-tauri/src/events.rs`（薄壳）。mobile 与 cockpit 复用本模块。
//!
//! 状态映射表（与 runtime `events` 模块的约定一致）：
//!  - `update/state`  → 助手状态（服务端驱动，AC-01-3）
//!  - `update/delta`  → 流式文本（对话层显示）+ 按 turn 聚合
//!  - `update/turn_end` → 助手消息落缓存 + 状态回落 `idle`
//!    （`speaking` 由端上 TTS 播报起止驱动，M2-05 约束 2，不在本映射内）
//!  - `prompt`（voice）→ 用户消息（ASR 原文）落缓存
//!  - `tool_call`   → 工具进展（对话层显示"正在查天气"，**不进历史**）
//!  - 其余（session / 文本 prompt）→ 忽略并计数

use crate::cache::{CacheError, MessageCache};
use crate::contract::{
    AssistantState, ChatMessage, ChatRole, EventEnvelope, SessionEvent, SessionUpdate, UpdateDelta,
};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// 桥接事件名（Rust emit ↔ TS listen 的契约字符串）。
// TS 侧镜像：`contracts/src/constants/`（改动必须两侧同步）。
// ---------------------------------------------------------------------------

/// 助手状态（payload: AssistantState 字面量）。
pub const EVENT_ASSISTANT_STATE: &str = "assistant:state";
/// 流式文本片段（payload: UpdateDelta）。
pub const EVENT_DIALOG_DELTA: &str = "dialog:delta";
/// 完整消息追加（payload: ChatMessage）。
pub const EVENT_DIALOG_MESSAGE: &str = "dialog:message";
/// 连接状态（payload: {"state": "online" | "reconnecting"}）。
pub const EVENT_NET_CONNECTION: &str = "net:connection";
/// 采集状态（payload: CaptureStatus，M2-03 已用）。
pub const EVENT_VOICE_CAPTURE: &str = "voice:capture";
/// 唤醒状态（payload: WakeStatus，M25-03）。
pub const EVENT_VOICE_WAKE: &str = "voice:wake";
/// 哨兵指示快照（payload: SentinelIndication，M25-04）。
pub const EVENT_VOICE_SENTINEL: &str = "voice:sentinel";
/// HITL 确认请求（payload: PermissionRequest，M13-05）。
pub const EVENT_DIALOG_PERMISSION: &str = "dialog:permission";
/// 等待期垫场话（payload: UpdateFiller，M18-01）。
pub const EVENT_DIALOG_FILLER: &str = "dialog:filler";
/// 工具调用进展（payload: ToolCallEvent，FL-08 F-08-05）。
pub const EVENT_DIALOG_TOOL_CALL: &str = "dialog:tool_call";
/// 会话标题已生成（payload: UpdateTitle，M28-01）。
pub const EVENT_DIALOG_TITLE: &str = "dialog:title";
/// 并行分支起止（payload: UpdateBranch，M37-01）。
/// 失败/超时要在端上出结构化标识，而不是藏在应答正文里。
pub const EVENT_DIALOG_BRANCH: &str = "dialog:branch";

/// 投影出的桥接动作（events.rs 逐条 emit 给 WebView）。
#[derive(Debug, Clone)]
pub enum BridgeAction {
    /// 驱动助手状态机（唯一外部数据入口，AC-01-3）。
    AssistantState(AssistantState),
    /// 流式文本片段（对话层实时渲染）。
    Delta(UpdateDelta),
    /// 一条完整消息已产生（用户 ASR 原文 / 助手全文），已尝试写入缓存。
    MessageAppended(ChatMessage),
    /// HITL 确认请求（M13-05）：端上必须弹窗——忽略它的话权限门会一直挂到超时，
    /// 现象是"助手不说话了"，排查方向完全不指向这里（M5-03 服务端链早已在发）。
    PermissionRequested(crate::contract::PermissionRequest),
    /// 等待期垫场话（M18-01，F-45-06）：交给端上播报，**不进对话记录**。
    Filler(crate::contract::UpdateFiller),
    /// 工具进展（FL-08 F-08-05）：对话层显示"正在查天气"，**不进对话记录**。
    ToolCall(crate::contract::ToolCallEvent),
    /// 会话标题已生成（M28-01）：更新左侧历史列表里这条会话的名字，**不进对话记录**。
    SessionTitle(crate::contract::UpdateTitle),
    /// 并行分支起止（M37-01，F-13-07/F-13-03）：failed/timeout 由 UI 层出
    /// "部分结果"标识，**不进对话记录、不改助手状态机**（分支完 ≠ 本轮完）。
    Branch(crate::contract::UpdateBranch),
    /// 未映射事件：忽略并计数上报，不抛错（FL-01 F-01-08 边界）。
    Ignored(&'static str),
}

/// 按 turn 聚合 delta，`turn_end` 时取出全文。
#[derive(Default)]
pub struct TurnAccumulator {
    buf: HashMap<String, String>,
}

impl TurnAccumulator {
    pub fn push(&mut self, turn_id: &str, text: &str) {
        self.buf
            .entry(turn_id.to_string())
            .or_default()
            .push_str(text);
    }
    pub fn take(&mut self, turn_id: &str) -> String {
        self.buf.remove(turn_id).unwrap_or_default()
    }
}

/// 纯投影：事件 → 动作序列（不含 IO）。
pub fn project(env: &EventEnvelope, acc: &mut TurnAccumulator) -> Vec<BridgeAction> {
    match &env.event {
        SessionEvent::Session(_) => vec![BridgeAction::Ignored("session")],
        SessionEvent::Prompt(p) => match &p.transcript {
            // 语音：ASR 原文即用户消息。
            // NOTE(耦合)：message_id 镜像网关约定 `msg-{turnId}-u`（M2-02
            // turn-service）；契约演进时应在 prompt 事件里显式带 messageId。
            Some(text) => vec![BridgeAction::MessageAppended(ChatMessage {
                message_id: format!("msg-{}-u", p.turn_id),
                session_id: env.session_id.clone(),
                turn_id: p.turn_id.clone(),
                role: ChatRole::User,
                source: p.source,
                content: text.clone(),
                ts: env.ts,
                // 用户消息不会被"打断"（M33-01）：打断针对的是助手那半句。
                cancelled: None,
            })],
            // 文本：内容由发送方（对话层 UI）乐观追加，回源校正兜底。
            None => vec![BridgeAction::Ignored("prompt_text")],
        },
        SessionEvent::Update(update) => match update {
            SessionUpdate::State(s) => vec![BridgeAction::AssistantState(s.state)],
            SessionUpdate::Delta(d) => {
                acc.push(&d.turn_id, &d.text);
                vec![BridgeAction::Delta(d.clone())]
            }
            SessionUpdate::TurnEnd(end) => {
                let full = acc.take(&end.turn_id);
                /*
                 * 累积为空时**只回 Idle，不追加消息**。
                 *
                 * 撤回（Retract）会清掉本轮累积，而 turn_end 仍会照常到来——
                 * 不判这一下就会在撤回后再追加一条**空的助手消息**，
                 * 端上表现为撤回文案下面挂了个空气泡，还会被双写进缓存。
                 *
                 * 顺带覆盖另一种情况：这一轮压根没产生任何 delta。
                 * 那时追加空消息同样没有意义。
                 */
                if full.is_empty() {
                    return vec![BridgeAction::AssistantState(AssistantState::Idle)];
                }
                vec![
                    BridgeAction::MessageAppended(ChatMessage {
                        message_id: end.message_id.clone(),
                        session_id: env.session_id.clone(),
                        turn_id: end.turn_id.clone(),
                        role: ChatRole::Assistant,
                        source: crate::contract::MessageSource::Text,
                        content: full,
                        ts: env.ts,
                        /*
                         * 端上这条是**从 SSE 投影出来的**，而 `turn_end` 事件里没有
                         * "这一轮被取消了"这个事实——它只有网关那侧知道（是它受理的取消）。
                         * 所以这里恒为 None，被打断的标注由端上自己按打断记录补
                         * （M33-02），回源读历史时以网关落库的那份为准。
                         */
                        cancelled: None,
                    }),
                    BridgeAction::AssistantState(AssistantState::Idle),
                ]
            }
            // 分支进展（F-13-07 / M37-01）：投影给 UI 层，桥接层仍不改助手状态机——
            // 分支跑完不等于这一轮结束，把它映射成 Idle 会让 HUD 提前收起。
            // failed/timeout 是端上"部分结果"标识的唯一结构化来源（不再只靠正文）。
            SessionUpdate::Branch(b) => vec![BridgeAction::Branch(b.clone())],
            /*
             * 撤回（F-26-06）：**必须投影，不能忽略**。
             *
             * 忽略它意味着端上继续显示那段被拦下的文本，而服务端以为已经撤掉了——
             * 这正是"看起来没事、实际泄露"的形态。
             *
             * 投影成一条 assistant 消息 + Idle：
             *  - 消息用 `replacement` 整段替换，**同时双写进缓存**，
             *    否则下次翻历史又能看到原文；
             *  - Idle 是因为撤回即本轮终结，助手不该停在 speaking。
             * 端上还要据此清掉本轮已聚合的 delta 气泡——那部分在 UI 层做，
             * 桥接层只负责把"这一轮的最终内容是这个"讲清楚。
             */
            SessionUpdate::Retract(r) => {
                // 丢掉累积的 delta：撤回后它不再是这一轮的内容
                let _ = acc.take(&r.turn_id);
                vec![
                    BridgeAction::MessageAppended(ChatMessage {
                        message_id: format!("msg-{}-retracted", r.turn_id),
                        session_id: env.session_id.clone(),
                        turn_id: r.turn_id.clone(),
                        role: ChatRole::Assistant,
                        source: crate::contract::MessageSource::Text,
                        content: r.replacement.clone(),
                        ts: env.ts,
                        // 撤回与打断是两回事：撤回是审核拦下的，不标 cancelled。
                        cancelled: None,
                    }),
                    BridgeAction::AssistantState(AssistantState::Idle),
                ]
            }
            /*
             * 垫场话（M18-01，F-45-06）：投影成一个动作，**绝不碰 `acc`**。
             *
             * `acc` 是"进历史"的唯一入口——`Delta` 往里 push、`TurnEnd` 取出来
             * 拼成一条 `ChatMessage` 落缓存。垫场话一旦进去，用户翻历史看到的
             * 就是一串"我在查你这车的手册"，而那句话在当时只是等待期的填充，
             * 事后没有任何意义。
             *
             * 也**不产出 `AssistantState`**：`thinking` 与 `speaking` 同时成立的
             * 状态在 §2.3 的状态机里没有定义（架构 §13-16 未决）。垫场期保持
             * `thinking` 不变，把这个决定留给 §13-16，不在这里擅自造一个新态。
             */
            SessionUpdate::Filler(f) => vec![BridgeAction::Filler(f.clone())],
            /*
             * 会话标题（M28-01）：**绝不碰 `acc`**——与垫场话、工具进展同一条纪律。
             * 它不是助手说的话，进了累积就会被 `turn_end` 拼进那条 ChatMessage，
             * 用户翻历史会看到回答末尾莫名多出一个标题。
             *
             * 也不产出 `AssistantState`：标题是首轮收口**之后**才到的，
             * 那时端上已经回到 idle（或正在播报），在这里改状态会把播报打断。
             */
            SessionUpdate::Title(t) => vec![BridgeAction::SessionTitle(t.clone())],
        },
        // 确认弹窗（M13-05）：原样透传给 UI。**不改助手状态机**——挂起的是工具调用，
        // 本轮的 delta/turn_end 仍会照常到来，状态由它们驱动。
        SessionEvent::Permission(p) => vec![BridgeAction::PermissionRequested(p.clone())],
        /*
         * 工具进展（F-08-05）：投影成一个动作，**绝不碰 `acc`**——与垫场话同一条纪律。
         *
         * `acc` 是"进历史"的唯一入口。"正在查天气"进去之后，用户翻历史看到的
         * 就是一串工具旁白，而那几句在当时只是填等待用的，事后没有任何意义。
         *
         * 也**不产出 `AssistantState`**：本轮仍然是 thinking，工具在跑不是一个新状态。
         * 端上把它显示在思考区（默认折叠，FL-03 F-03-04），不占对话气泡。
         */
        SessionEvent::ToolCall(t) => vec![BridgeAction::ToolCall(t.clone())],
    }
}

/// 投影 + 缓存双写。
///
/// 一致性策略（M2-04 约束 1）：**缓存写失败不阻塞状态机与消息呈现**——
/// 动作照常返回（emit 照常），错误收集上抛由调用方计数/告警，
/// 差异靠下一次回源（`replace_session`）修复。
pub fn apply(
    env: &EventEnvelope,
    cache: &MessageCache,
    acc: &mut TurnAccumulator,
) -> (Vec<BridgeAction>, Vec<CacheError>) {
    let actions = project(env, acc);
    let mut errors = Vec::new();
    for action in &actions {
        if let BridgeAction::MessageAppended(msg) = action {
            if let Err(e) = cache.upsert_message(msg) {
                errors.push(e);
            }
        }
    }
    (actions, errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::samples::sample_envelopes;

    /// 标准样例序列（session→prompt→state→delta→**branch**→turn_end→permission→tool_call）
    /// 走完整 fan-out：断言动作序列与缓存内容。
    ///
    /// 断言里 `Ignored` **带上原因**而不是统一记成 `"ignored"`：
    /// F-13-07 加 `update/branch` 时，样例序列多了一条被忽略的事件，
    /// 而当时的断言只能报出"数组长度 9 != 8"，看不出多的是哪一条。
    /// 带上原因后，下次再加一类事件，失败信息会直接说出它是谁。
    #[test]
    fn sample_sequence_projects_and_double_writes() {
        let cache = MessageCache::open_in_memory().unwrap();
        let mut acc = TurnAccumulator::default();
        let mut all = Vec::new();
        let mut errors = Vec::new();

        for env in sample_envelopes() {
            let (actions, errs) = apply(&env, &cache, &mut acc);
            all.extend(actions);
            errors.extend(errs);
        }
        assert!(errors.is_empty());

        let kinds: Vec<String> = all
            .iter()
            .map(|a| match a {
                BridgeAction::AssistantState(_) => "state".to_string(),
                BridgeAction::Delta(_) => "delta".to_string(),
                BridgeAction::MessageAppended(m) => if matches!(m.role, ChatRole::User) {
                    "user_msg"
                } else {
                    "assistant_msg"
                }
                .to_string(),
                BridgeAction::PermissionRequested(_) => "permission".to_string(),
                BridgeAction::Filler(_) => "filler".to_string(),
                BridgeAction::ToolCall(_) => "tool_call".to_string(),
                BridgeAction::SessionTitle(_) => "title".to_string(),
                BridgeAction::Branch(_) => "branch".to_string(),
                // 带上原因：多/少一条被忽略的事件时，失败信息要说得出是哪一条
                BridgeAction::Ignored(why) => format!("ignored:{why}"),
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                "ignored:session",
                "user_msg", // prompt(voice) → ASR 原文
                "state",    // thinking
                // 垫场话（M18-01）：夹在 thinking 与首个 delta 之间——
                // 它**必须**出现在这里且**不得**改变后面的 assistant_msg 内容。
                "filler",
                "delta",
                // 分支进展自 M37-01 起投影（此前刻意忽略）：failed/timeout 的
                // "部分结果"标识需要它。仍不改助手状态机——分支完 ≠ 本轮完。
                // 两条：5b（ok）与 5c（timeout，M37-01 新增的失败样本）。
                "branch",
                "branch",
                "assistant_msg", // turn_end → 全文
                "state",         // idle 回落
                "permission",    // M13-05 起投影成弹窗请求，不再忽略
                // 工具进展（F-08-05）：起初被忽略，而端上那十几秒空白正是它要填的。
                // 与垫场话同一条纪律——投影出去，但不进 `acc`（见 project 的说明）。
                "tool_call",
            ]
        );

        // 双写结果：user 原文 + assistant 聚合全文。
        // **工具进展与垫场话都不在里面**——它们投影成动作，但不碰 `acc`，
        // 所以进不了这张缓存。少了这条断言，"正在查天气"哪天混进历史也没人会发现。
        let page = cache.recent_page("sess-demo-001", None, 10).unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].content, "明天要跑一趟长途");
        assert_eq!(page[1].content, "好的，");
        assert_eq!(page[1].message_id, "msg-assistant-1");
    }

    /// 撤回（F-26-06）：**必须投影，不能忽略**。
    ///
    /// 忽略它意味着端上继续显示那段被拦下的文本，而服务端以为撤掉了——
    /// 这正是"看起来没事、实际泄露"的形态。
    #[test]
    fn retract_replaces_turn_and_drops_accumulated_delta() {
        use crate::contract::{
            EventEnvelope, SessionEvent, SessionUpdate, UpdateDelta, UpdateRetract, UpdateTurnEnd,
        };

        let cache = MessageCache::open_in_memory().unwrap();
        let mut acc = TurnAccumulator::default();
        let env = |event: SessionEvent| EventEnvelope {
            event_id: "e-r".into(),
            session_id: "sess-r".into(),
            ts: 1,
            event,
        };

        // 先流出两片
        for text in ["这段内容", "不该出现"] {
            let _ = apply(
                &env(SessionEvent::Update(SessionUpdate::Delta(UpdateDelta {
                    turn_id: "t-r".into(),
                    text: text.into(),
                }))),
                &cache,
                &mut acc,
            );
        }

        // 撤回
        let (actions, errs) = apply(
            &env(SessionEvent::Update(SessionUpdate::Retract(
                UpdateRetract {
                    turn_id: "t-r".into(),
                    replacement: "这条回答我收回了".into(),
                    reason: "输出内容未通过安全检查".into(),
                },
            ))),
            &cache,
            &mut acc,
        );
        assert!(errs.is_empty());

        let msg = actions
            .iter()
            .find_map(|a| match a {
                BridgeAction::MessageAppended(m) => Some(m),
                _ => None,
            })
            .expect("撤回必须投影成一条消息，忽略它端上就还显示着原文");
        assert_eq!(msg.content, "这条回答我收回了");
        assert!(
            actions
                .iter()
                .any(|a| matches!(a, BridgeAction::AssistantState(AssistantState::Idle))),
            "撤回即本轮终结，助手不该停在 speaking"
        );

        // 随后的 turn_end **不得再追加一条空消息**
        let (after, _) = apply(
            &env(SessionEvent::Update(SessionUpdate::TurnEnd(
                UpdateTurnEnd {
                    turn_id: "t-r".into(),
                    message_id: "msg-t-r".into(),
                },
            ))),
            &cache,
            &mut acc,
        );
        assert!(
            !after
                .iter()
                .any(|a| matches!(a, BridgeAction::MessageAppended(_))),
            "撤回后累积已清空，turn_end 再追加就是个空气泡"
        );

        // 缓存里只应有撤回后的那一条
        let page = cache.recent_page("sess-r", None, 10).unwrap();
        assert_eq!(page.len(), 1, "不撤缓存的话，用户下次翻历史又能看到原文");
        assert_eq!(page[0].content, "这条回答我收回了");
    }

    /// 垫场话**不进本轮助手全文**（M18-01，F-45-06 / AC-45-7）。
    ///
    /// 这是本单唯一真正要守住的东西。`acc` 是"进历史"的物理路径，
    /// 而复用 `delta` 是最省事也最容易犯的错——犯了以后，
    /// 用户翻历史看到的是一串"我在查你这车的手册"。
    ///
    /// ⚠️ 本断言只有 **lib 单测**能覆盖：`test:contract` 只跑
    /// `--test contract_roundtrip` 那个集成目标，碰不到这里（内部开发指引 记着
    /// `carlife-core` 的 lib 单测曾因此静默失效一整天）。验收必须跑 `test:rust`。
    #[test]
    fn filler_not_accumulated_into_turn_text() {
        use crate::contract::{
            EventEnvelope, FillerSource, SessionEvent, SessionUpdate, UpdateDelta, UpdateFiller,
            UpdateTurnEnd,
        };

        let cache = MessageCache::open_in_memory().unwrap();
        let mut acc = TurnAccumulator::default();
        let env = |event: SessionEvent| EventEnvelope {
            event_id: "e-f".into(),
            session_id: "sess-f".into(),
            ts: 1,
            event,
        };

        let delta = |text: &str| {
            SessionEvent::Update(SessionUpdate::Delta(UpdateDelta {
                turn_id: "t-f".into(),
                text: text.into(),
            }))
        };

        let _ = apply(&env(delta("A")), &cache, &mut acc);
        let (filler_actions, _) = apply(
            &env(SessionEvent::Update(SessionUpdate::Filler(UpdateFiller {
                turn_id: "t-f".into(),
                text: "我在翻你这车的手册".into(),
                source: FillerSource::L0,
                interruptible: true,
            }))),
            &cache,
            &mut acc,
        );
        let _ = apply(&env(delta("B")), &cache, &mut acc);

        // 投影成恰好一个 Filler 动作，且**不带任何状态变化**
        assert_eq!(filler_actions.len(), 1, "垫场话应投影成恰好一个动作");
        let text = match &filler_actions[0] {
            BridgeAction::Filler(f) => f.text.clone(),
            other => panic!("期望 Filler，得到 {other:?}"),
        };
        assert_eq!(text, "我在翻你这车的手册");
        assert!(
            !filler_actions
                .iter()
                .any(|a| matches!(a, BridgeAction::AssistantState(_))),
            "垫场期保持 thinking，不擅自造新态（架构 §13-16 未决）"
        );

        // 收口：全文只有两片 delta，一个垫场字都不在里面
        let (end_actions, _) = apply(
            &env(SessionEvent::Update(SessionUpdate::TurnEnd(
                UpdateTurnEnd {
                    turn_id: "t-f".into(),
                    message_id: "msg-t-f".into(),
                },
            ))),
            &cache,
            &mut acc,
        );
        let msg = end_actions
            .iter()
            .find_map(|a| match a {
                BridgeAction::MessageAppended(m) => Some(m),
                _ => None,
            })
            .expect("turn_end 应产出助手消息");
        assert_eq!(
            msg.content, "AB",
            "垫场话混进了本轮全文——'不入历史'已经破了"
        );

        // 缓存侧同样干净（双写路径）
        let page = cache.recent_page("sess-f", None, 10).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].content, "AB");
    }

    /// 投影层**不做时序裁剪**：`turn_end` 之后到的垫场话照样投影，
    /// 该不该丢由端上决定（端上按 turn_end 收口）。
    ///
    /// 在这里做裁剪的话，桥接层就要维护"哪一轮已经结束"的状态，
    /// 而它现在是纯函数——为一个端上本就会处理的边角情况引入状态不划算。
    #[test]
    fn filler_after_turn_end_still_projects() {
        use crate::contract::{
            EventEnvelope, FillerSource, SessionEvent, SessionUpdate, UpdateFiller,
        };

        let mut acc = TurnAccumulator::default();
        let actions = project(
            &EventEnvelope {
                event_id: "e-f2".into(),
                session_id: "sess-f2".into(),
                ts: 1,
                event: SessionEvent::Update(SessionUpdate::Filler(UpdateFiller {
                    turn_id: "t-gone".into(),
                    text: "迟到的一句".into(),
                    source: FillerSource::L0,
                    interruptible: true,
                })),
            },
            &mut acc,
        );
        assert!(matches!(actions.as_slice(), [BridgeAction::Filler(_)]));
    }

    /// 确认请求必须原样透传（M13-05）：interruptId 是 resume 的关联键，
    /// details 是用户批的具体内容（F-04-02）——丢字段的弹窗等于让用户盲批。
    #[test]
    fn permission_projects_payload_intact() {
        use crate::contract::{PermissionDetail, PermissionRequest};

        let mut acc = TurnAccumulator::default();
        let env = EventEnvelope {
            event_id: "e-p".into(),
            session_id: "sess-p".into(),
            ts: 1,
            event: SessionEvent::Permission(PermissionRequest {
                interrupt_id: "itr-1".into(),
                action: "trip_plan_commit".into(),
                title: "需要你确认：trip_plan_commit".into(),
                details: vec![PermissionDetail {
                    label: "明细".into(),
                    value: "第1天 亲子：长隆；住 长隆酒店".into(),
                }],
                scope: Some("trip".into()),
                // 行程确认不外发个人信息给第三方——空数组是它的正常形态（M15-04）。
                disclosure: vec![],
            }),
        };
        let actions = project(&env, &mut acc);
        assert_eq!(actions.len(), 1);
        match &actions[0] {
            BridgeAction::PermissionRequested(p) => {
                assert_eq!(p.interrupt_id, "itr-1");
                assert_eq!(p.details[0].value, "第1天 亲子：长隆；住 长隆酒店");
            }
            other => panic!("permission 必须投影成弹窗请求，得到 {other:?}"),
        }
    }

    #[test]
    fn delta_aggregation_spans_multiple_chunks() {
        let mut acc = TurnAccumulator::default();
        acc.push("t1", "你好");
        acc.push("t1", "，世界");
        acc.push("t2", "另一轮");
        assert_eq!(acc.take("t1"), "你好，世界");
        assert_eq!(acc.take("t1"), "", "取出后清空");
        assert_eq!(acc.take("t2"), "另一轮");
    }

    /// 故障注入（M2-04 约束 1）：缓存写失败时动作照常返回、错误被收集。
    #[test]
    fn cache_failure_does_not_block_actions() {
        let cache = MessageCache::open_in_memory().unwrap();
        // 人为破坏底层表结构制造写失败
        {
            // 通过公开 API 无法破坏，直接用一个新的只读语义模拟：
            // 用已 drop 表的连接。
        }
        let broken = broken_cache();
        let mut acc = TurnAccumulator::default();
        let envs = sample_envelopes();
        let prompt_env = &envs[1]; // prompt(voice)

        let (actions, errors) = apply(prompt_env, &broken, &mut acc);
        assert_eq!(actions.len(), 1, "动作不因写失败而丢");
        assert!(matches!(actions[0], BridgeAction::MessageAppended(_)));
        assert_eq!(errors.len(), 1, "写失败被收集上抛");

        // 正常缓存不受影响（对照）
        let (_, ok_errors) = apply(prompt_env, &cache, &mut acc);
        assert!(ok_errors.is_empty());
    }

    fn broken_cache() -> MessageCache {
        let cache = MessageCache::open_in_memory().unwrap();
        cache.__test_break();
        cache
    }
}
