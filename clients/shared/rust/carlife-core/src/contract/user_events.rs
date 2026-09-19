//! 账号级事件契约（ACR-031）—— 与 `events.rs` 的会话事件是**两条通道，别混**。
//!
//! 会话事件讲"这一段对话里发生了什么"：按会话订阅（`GET /v1/session/:id/stream`），
//! 带 `event_id` 与续传窗口，断线重连要把漏掉的那几条补回来。
//!
//! 本模块讲"这个账号的会话列表变了"：按账号订阅（`GET /v1/events`），
//! **没有 `event_id`、没有窗口、不支持 `Last-Event-ID`**。
//! 理由是事件语义只有一句"你该重拉一次列表"——补发一条过期的刷新信号毫无意义，
//! 而重连时端上本来就要整拉一次。两条通道因此刻意不共用封套：
//! `EventEnvelope` 的 `event_id` 与 `session_id` 是续传窗口的两根支柱，这里两根都不要。
//!
//! 为什么需要它：在此之前，"同一个人的另一个端做了什么"在协议里无法表达，
//! 于是手机端聊完的那段对话不会出现在车机端的会话列表里，直到车机自己
//! 因为别的原因重拉一次。车主分不出"没同步"与"丢了"，而后者是最不该给人的印象。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 账号级事件封套。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UserEventEnvelope {
    /// Unix epoch 毫秒。
    #[ts(type = "number")]
    pub ts: i64,
    pub event: UserEvent,
}

/// 账号级事件。
///
/// 目前只有一种，仍然按 `kind` 打标签（与 `SessionUpdate` 同一形态）：
/// 将来加「车辆档案变了」「有新提醒」时不必破契约。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum UserEvent {
    /// 这个账号的会话列表变了，端上该重拉一次 `GET /v1/sessions`。
    SessionsChanged(SessionsChanged),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionsChanged {
    /// 哪一段会话引起的；`connected` 那一条没有（它讲的是通道刚建立，不属于任何会话）。
    ///
    /// ⚠️ **端上不要据此做增量更新**——本通道的语义是"整拉"，不是"把这一条改掉"。
    /// 留这个字段只为排障时能把一次刷新对回到某一轮。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub reason: SessionsChangedReason,
}

/// 为什么会变。端上不按它分支，只用来记日志与排障。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SessionsChangedReason {
    /// 刚连上时服务端主动发的一次对齐。
    ///
    /// 放进通道而不是让每个端自己"连上先拉一次"：这样"重连即对齐"是通道自带的
    /// 语义，两个端不必各写一遍，将来第三个端接进来也不会漏。
    Connected,
    /// 有消息落库——会话的 `updatedAt` 变了，列表排序跟着变。
    Message,
    /// 标题生成并落库。
    Title,
    /// 会话被关闭。
    Closed,
}
