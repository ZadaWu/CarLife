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
    /// 这条**用户**消息随轮带上的附件（施工单 M80-01，F-03-08 / F-09-09）。
    ///
    /// 只有引用，没有字节：端上拿 `handle` 经 Rust 侧 `GET /v1/attachments/:handle` 取原件
    /// （WebView 里没有令牌，`<img src>` 加不了 Authorization 头）。
    /// 助手消息恒无此字段；老数据与老端上没有这个字段，缺省与空数组同义。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<AttachmentRef>>,
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

/// 附件引用（FL-03 F-03-12 / FL-09 引用句柄语义）。M80-01 起随 `ChatMessage` 与 `PromptAccepted` 下发。
///
/// `attachment_id` 与 `handle` 目前是同一个值（网关的附件主键就是句柄）；两个字段都保留，
/// 是给"句柄可轮换而 id 不变"留位。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AttachmentRef {
    pub attachment_id: String,
    pub kind: AttachmentKind,
    /// 对象存储引用句柄（不可枚举，§3）。
    pub handle: String,
    /// MIME（如 `image/jpeg`、`video/mp4`）；端上据此决定用 `<img>` 还是 `<video>`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// 原件字节数；端上用来决定要不要先问一句再拉 40 MB 的视频。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub bytes: Option<i64>,
    /// 端上给的原始文件名，只用于展示。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    /// 视频时长（毫秒），网关在解析视频后回填；照片没有。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AttachmentKind {
    Image,
    Audio,
    Pdf,
    /// M80-01 起可上传（≤ 1 分钟；更长的只分析前 60 秒）。
    Video,
}

/// 端上检测出的一枚框（ACR-046；服务端消费见 ACR-045）。
///
/// `bbox` 是**按 EXIF 转正后**那张图的 0–1000 归一化 `[x0, y0, x1, y1]`（整数、单调），与服务端 `BBox` 同形——
/// 端上 `carlife-vision` 与服务端裁图（`uprightByExif` 之后）都在转正后的坐标系里，中间不换算。
/// `name` 是检测器的类别名：服务端只把它当 `symbolHint`（手册目录对上以目录为准，没对上说「疑似」）。
/// 服务端的 zod 校验（`ClientDetectionsSchema`）：名字 1–64 字、置信 0–1、每张 ≤ 24 条。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClientDetection {
    pub bbox: [u16; 4],
    pub name: String,
    pub conf: f32,
}

/// 一张照片的端上检测结果（ACR-046），随 `/messages` 体的 `detections`（按附件句柄索引）上行。
///
/// `items` 为空也要发：端上跑过、没框到，服务端据此说「未识别到指示灯」并给补拍提示，
/// **不回落云端定位**（ACR-044 产品决定）。检测没跑完的照片不带——服务端自己框。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClientDetections {
    /// 转正后的像素尺寸（只作留痕与自检，框已归一化）。
    pub width: u32,
    pub height: u32,
    pub items: Vec<ClientDetection>,
    /// 端上推理耗时（毫秒），进服务端 trace。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub infer_ms: Option<u64>,
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
