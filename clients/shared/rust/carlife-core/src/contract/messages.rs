//! 对话消息与历史查询契约（FL-03 F-03-12）。
//!
//! 消息的权威源是服务端 PostgreSQL（FL-03"存储分层对齐"）；
//! 端上 SQLite 只缓存同构数据。两侧共用本定义。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ChatRole {
    User,
    Assistant,
}

/// 消息输入来源；`voice` 时 `content` 为 ASR 识别原文。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MessageSource {
    Text,
    Voice,
}

/// 一条对话消息。用户与助手消息同构，靠 `role` 区分。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatMessage {
    pub message_id: String,
    pub session_id: String,
    /// 同一轮问答（用户消息 + 助手回复）共享 turn_id。
    pub turn_id: String,
    pub role: ChatRole,
    pub source: MessageSource,
    pub content: String,
    /// Unix epoch 毫秒。
    #[ts(type = "number")]
    pub ts: i64,
    /// 这条助手回复是被**打断**的半句（施工单 M33-01，F-08-08）。
    ///
    /// 取消的语义是"停止推进"而不是"抹掉"：AC-08-6 明写「已产生内容不丢失」，
    /// 用户已经听见/看见的那半句必须留在历史里，只是要标出来——
    /// 不标的话它读起来像是助手好端端地把话说了一半。
    ///
    /// `Option` 而不是 `bool`：老数据与老端上都没有这个字段，
    /// 缺省（`None`）与 `Some(false)` 一样都表示"正常收口"。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
}

/// 历史分页查询请求（游标向前翻页）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryQuery {
    pub session_id: String,
    /// 取该 message_id 之前的消息；null 表示从最新开始。
    pub before: Option<String>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HistoryPage {
    /// 按时间正序排列。
    pub messages: Vec<ChatMessage>,
    pub has_more: bool,
    /// 继续向前翻页的游标；无更多时为 null。
    pub next_before: Option<String>,
}

/// 附件引用占位（FL-03 F-03-12 / FL-09 引用句柄语义）。M2 Sprint 不消费。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AttachmentRef {
    pub attachment_id: String,
    pub kind: AttachmentKind,
    /// 对象存储引用句柄（不可枚举，§3）。
    pub handle: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AttachmentKind {
    Image,
    Audio,
    Pdf,
}

/// 思考步骤占位（FL-03 F-03-04 后续消费；对话层默认折叠展示）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThoughtStep {
    pub turn_id: String,
    /// 人话标签（如"正在查沿途天气"），非工具函数名（FL-08 F-08-05）。
    pub label: String,
    pub detail: Option<String>,
}
