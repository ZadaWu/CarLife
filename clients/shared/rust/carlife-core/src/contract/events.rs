//! SSE 会话事件契约 —— 语义对齐 ACP 五类事件（架构 §3）。
//!
//! M2 Sprint 只消费 `session` / `prompt` / `update` 三类；
//! `permission` / `tool_call` 现在就定型（FL-04 F-04-12 / FL-08 F-08-03），
//! 避免后续 HITL 与工具接入时破坏契约版本。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::messages::MessageSource;

/// 助手形象五态（§2.2 H1）。由 `update` 事件驱动，端上组件不得自行推断。
///
/// M1-03 曾在 `clients/shared/ui` 与 `contracts/src/domain/hud.ts` 各有一份
/// 字面量定义；自 M2-01 起以本定义为唯一来源，TS 侧均改为 re-export。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum AssistantState {
    Idle,
    Listening,
    Thinking,
    Speaking,
    Alert,
}

/// SSE 事件封套：每条下行事件的统一外壳。
///
/// `event_id` 单调递增（会话内），支撑 `Last-Event-ID` 断点续传（§3）。
/// `session_id` 贯穿全链路（§3），任何事件不得缺失。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EventEnvelope {
    pub event_id: String,
    pub session_id: String,
    /// Unix epoch 毫秒。
    #[ts(type = "number")]
    pub ts: i64,
    pub event: SessionEvent,
}

/// 五类会话事件（ACP 语义投影，§3）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum SessionEvent {
    /// 会话建立 / 恢复。
    Session(SessionOpened),
    /// 请求已受理；语音请求在此回传识别原文（FL-02 F-02-10 的数据源）。
    Prompt(PromptAccepted),
    /// 流式更新：token 片段 / 助手状态提示 / 轮次结束。
    Update(SessionUpdate),
    /// HITL 权限确认请求（M2 Sprint 不消费，仅定型）。
    Permission(PermissionRequest),
    /// 工具调用进展（M2 Sprint 不消费，仅定型）。
    ToolCall(ToolCallEvent),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionOpened {
    pub status: SessionOpenStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionOpenStatus {
    Created,
    Resumed,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PromptAccepted {
    pub turn_id: String,
    pub source: MessageSource,
    /// 用户这句话的原文：语音是 ASR 识别结果，文字就是打的那句（2026-09-03 起两种来源都带）。
    /// 端上只靠它追加用户气泡；null 只可能来自旧服务端，端上忽略并靠回源。
    pub transcript: Option<String>,
}

/// `update` 事件的六种载荷。序列化形如
/// `{"type":"update","kind":"delta","turnId":"…","text":"…"}`。
///
/// 加新变体时 `carlife-core::fanout::project` 的 match 会编译失败——
/// 那是刻意的：**新事件类型必须被显式处置**，忽略也要写出来并说明理由。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SessionUpdate {
    /// token 流片段，端上按 turn 聚合。
    Delta(UpdateDelta),
    /// 助手状态提示 —— 状态机的唯一外部数据源（FL-01 AC-01-3）。
    State(UpdateState),
    /// 轮次结束：完整回复已生成，`message_id` 与权威历史对应。
    TurnEnd(UpdateTurnEnd),
    /// 并行分支的起止（F-13-07）。
    ///
    /// 出行主线里两条分支可能跑上一分钟，期间端上此前**一片空白**——
    /// 既看不到"在并行"，也不知道哪条已经出结果。等到汇聚才下发的设计
    /// 把最能体现"多 Agent 协作"的那一段藏起来了，而它恰恰是最该被看见的。
    Branch(UpdateBranch),
    /// 撤回本轮已流出的内容（F-26-06，施工单 TD-07）。
    ///
    /// # 为什么需要一个"撤回"而不是只发个拒绝
    ///
    /// 输出侧内容审核判"拦"的时候，前面的 token **已经推到端上了**——
    /// SSE 是单向下行，收回不了字节。端上此刻屏幕上摆着一段不该出现的文本，
    /// 只追加一句"这条我没法回答"会变成**两段自相矛盾的内容并排显示**，
    /// 比什么都不做更糟。
    ///
    /// 所以撤回是一条**明确的协议动作**：端上收到它就丢弃本轮已聚合的 delta，
    /// 用 `replacement` 整段替换。缓存侧同理——不撤的话，
    /// 用户下次翻历史又能看到它。
    Retract(UpdateRetract),
    /// 等待期的旁路语音填充（US-45 / F-45-06，施工单 M18-01）。
    ///
    /// # 为什么它不是 `delta` 的一种 flavor
    ///
    /// 复用 `delta` 看起来只是省一个变体，实际会同时打穿两条治理约定：
    ///
    /// 1. **聚合语义**：`project()` 里 `Delta` 会 `acc.push(...)`，`TurnEnd` 再
    ///    `acc.take()` 拼成一条 `ChatMessage` 落缓存——那是"进历史"的物理路径。
    ///    垫场话是等待期的瞬时填充，进了历史，用户翻上去看到的全是"我在查"。
    /// 2. **补发语义**：`delta` 要进网关的 `Last-Event-ID` 窗口（断线要能补回来），
    ///    而垫场话**必须被排除**——重连补发一句"我在翻你这车的手册"，
    ///    就是在一个早已结束的话题上重复寒暄。
    ///
    /// 所以它是独立变体，并在三处各自显式处置：本文件（契约）、
    /// `fanout::project`（不进 `acc`）、`gateway/stream/session-bus.ts`（不入窗口）。
    Filler(UpdateFiller),
    /// 会话标题已生成（M28-01）。
    ///
    /// # 为什么它是一条协议事件，而不是让端上自己去列表里刷
    ///
    /// 标题是**首轮结束之后**才由旁路算出来的，那时端上这一轮早已收口。
    /// 不推的话，车主在左侧列表里看到的是刚建的那条会话**没有名字**，
    /// 要等下次进页面重拉才补上——而"刚聊完的那段没名字、更早的都有"
    /// 看起来正是功能坏了的样子。
    ///
    /// # 它不进对话记录
    ///
    /// 与 `Filler` / `ToolCall` 同一条线：它不是助手说的话。
    /// `fanout::project` 里不碰 `acc`，缓存里也不留。
    Title(UpdateTitle),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateDelta {
    pub turn_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateState {
    pub state: AssistantState,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateTurnEnd {
    pub turn_id: String,
    pub message_id: String,
}

/// 会话标题（M28-01）。**一个会话只发一次**——生成是一次性的，
/// 重复发意味着标题在变，而车主刚认下的那个名字不该自己改。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateTitle {
    /// 已裁到 15 个字符以内、去掉了引号与结尾标点。端上直接显示，不再加工。
    pub title: String,
}

/// 并行分支的一次状态变化（F-13-07 / F-13-03）。
///
/// `agent` 是**分支会话身份**（如 `trip-task`），不是规范 Agent 名：
/// 端上要能区分"出行分支"与"用车分支"，而它们可能属于同一个 Agent。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateBranch {
    pub turn_id: String,
    pub agent: String,
    pub status: BranchStatus,
    /// 结束时的耗时（毫秒）；`started` 时为 null。
    pub duration_ms: Option<u32>,
    /// 一句话进展，供端上直接显示（"路线已规划好，正在评估续航"）。
    /// **不是完整结果**——完整结果等汇聚后由应答节点表述。
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateRetract {
    pub turn_id: String,
    /// 替换文本。**必填**——撤回后屏幕不能是空的，
    /// 用户会以为应用坏了而不是"这条被拦了"。
    pub replacement: String,
    /// 撤回原因，给端上展示用的一句话。
    ///
    /// **不带命中的具体标签**：那是审计里的东西，摆给用户看等于告诉他
    /// 换个说法就能绕过去。
    pub reason: String,
}

/// 一条垫场话（F-45-06）。**整句一次性下发，不流式**——
/// 它不是 token 流，端上收到就是完整的一句，可以直接交给 TTS。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateFiller {
    pub turn_id: String,
    /// 整句垫场话。
    pub text: String,
    /// 生成档位。`L0` = 轨迹模板（零 LLM），`L1` = 轻量模型生成。
    ///
    /// L1 尚未实现（架构 §13-15：先只做 L0），但字段**现在就进契约**：
    /// 加字段要动 Rust + ts-rs + 三处消费方，等 L1 落地时再补等于把 M18-01 重做一遍。
    pub source: FillerSource,
    /// 端上是否允许句中截断。L0 恒为 `true`。
    ///
    /// **不设默认值**：显式传，避免"忘了传"与"就是 false"混在一起——
    /// 后者意味着一句垫场话会把正文的音轨占住，而这正是本功能最不该出现的失败形态。
    pub interruptible: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FillerSource {
    L0,
    L1,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BranchStatus {
    Started,
    Ok,
    Failed,
    Timeout,
}

/// HITL 权限确认请求（FL-04 F-04-12：动作类型、明细项、影响范围、中断点 id）。
///
/// M2 Sprint 不下发此事件；类型对齐 §8.4 的"需确认"档裁决。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PermissionRequest {
    /// 中断点 id，resume 时回传关联。
    pub interrupt_id: String,
    /// 动作类别（如 calendar_write / appointment）。
    pub action: String,
    /// 弹窗标题级别的动作说明。
    pub title: String,
    /// 将要执行的具体明细 —— 不允许只显示动作名称（FL-04 AC-04-2）。
    pub details: Vec<PermissionDetail>,
    /// 影响范围（如写入哪个日历账号）。
    pub scope: Option<String>,
    /// 将提供给第三方的**个人信息项**（F-26-09 / AC-15-7）。
    ///
    /// # 为什么不塞进 `details`
    ///
    /// 混在一起，用户不会意识到这几行的性质和"门店地址"完全不同——
    /// 一个是"这次动作是什么"，一个是"我的哪些信息要发出去"。
    /// 端上必须把它渲染成独立一块，所以协议上也必须是独立一段。
    ///
    /// 空数组 = 本次动作不外发任何个人信息，与"没有这个字段"语义相同
    /// （`serde(default)` 让旧版本事件仍可反序列化）。
    /// 值在生成侧已掩码（`enterprise/backend/shared/tools` 的 `describeDisclosure`），
    /// **端上只渲染、不自己拼**：两处各拼一份时，用户看到的和实际发出去的会对不上。
    #[serde(default)]
    pub disclosure: Vec<PermissionDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PermissionDetail {
    pub label: String,
    pub value: String,
}

/// 工具调用进展（FL-08 F-08-05：`display_name` 为人话，不是函数名）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ToolCallEvent {
    pub tool_call_id: String,
    pub tool_name: String,
    pub display_name: String,
    pub status: ToolCallStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ToolCallStatus {
    Started,
    Succeeded,
    Failed,
}

#[cfg(test)]
mod permission_disclosure_tests {
    use super::*;

    /// 外发个人信息字段是**新增**的（M15-04）。
    ///
    /// 端上老版本发来的事件里没有这个字段，反序列化必须照样成功——
    /// 否则一次协议升级会让还没更新的车机整条 HITL 链路失效，
    /// 而现象只是"确认弹窗不出来了"。
    #[test]
    fn missing_disclosure_deserializes_as_empty() {
        let old = r#"{
            "interruptId": "itr-1",
            "action": "appointment",
            "title": "需要你确认",
            "details": [{"label": "动作", "value": "预约试驾"}],
            "scope": null
        }"#;
        let p: PermissionRequest = serde_json::from_str(old).expect("旧事件必须还能解析");
        assert!(p.disclosure.is_empty(), "缺字段与「本次不外发」语义相同");
    }

    /// 空数组与缺字段等价——两种写法在端上必须表现一致。
    #[test]
    fn empty_disclosure_equals_missing() {
        let with_empty = r#"{
            "interruptId": "itr-1",
            "action": "appointment",
            "title": "需要你确认",
            "details": [],
            "scope": null,
            "disclosure": []
        }"#;
        let p: PermissionRequest = serde_json::from_str(with_empty).unwrap();
        assert!(p.disclosure.is_empty());
    }

    /// 有外发项时逐条带过来，**值已在生成侧掩码**（端上只渲染，不自己拼）。
    #[test]
    fn disclosure_carries_masked_values() {
        let json = r#"{
            "interruptId": "itr-1",
            "action": "appointment",
            "title": "需要你确认",
            "details": [{"label": "动作", "value": "预约试驾 · 某某门店"}],
            "scope": "buying",
            "disclosure": [
                {"label": "称呼", "value": "林先生"},
                {"label": "手机号", "value": "138****8000"}
            ]
        }"#;
        let p: PermissionRequest = serde_json::from_str(json).unwrap();
        assert_eq!(p.disclosure.len(), 2);
        assert_eq!(p.disclosure[1].value, "138****8000");
        // 明文手机号出现在这里就说明有人绕过了 describeDisclosure。
        assert!(!p.disclosure[1].value.contains("13800138000"));
    }
}
