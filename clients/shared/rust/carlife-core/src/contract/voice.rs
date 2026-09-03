//! 语音会话契约（FL-02 F-02-13）。
//!
//! 采集/编码/上传全在 Rust 侧（§2.2 C4），桥接层只传状态不传音频；
//! 本文件定义的是**状态与元数据**，不含任何音频字节通道。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 采集模式（§2.2 C4 双模式）。M2 Sprint 先落 push-to-talk（M2-03），
/// 常驻 VAD 归 M2-06。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CaptureMode {
    PushToTalk,
    ContinuousVad,
}

/// 采集状态事件：Rust 侧 emit、前端订阅（驱动 listening 反馈与监听指示）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum CaptureStatus {
    Started(CaptureStarted),
    Stopped(CaptureStopped),
    Uploading,
    /// 上传完成；服务端受理后 turn_id 经 `prompt` 事件下发。
    Uploaded,
    Failed(CaptureFailed),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CaptureStarted {
    pub mode: CaptureMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CaptureStopped {
    pub duration_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CaptureFailed {
    /// 面向排障的原因码（如 permission_denied / device_busy / too_long）。
    pub reason: String,
}

/// 唤醒状态事件（施工单 M25-03，F-52-07）：Rust 侧 emit（`voice:wake`）、前端订阅。
///
/// **事件只描述状态事实，不携带任何转写文本**——未命中的文本连事件层都不进
/// （F-52-02 丢弃纪律的契约面）；命中的指令走既有消息上行成轮，不走事件。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum WakeStatus {
    /// 唤醒命中。`has_command`：同句是否带指令（带则已直接上行）。
    Woken { has_command: bool },
    /// 聆听窗口开/关（唤醒后等待指令，默认 10s）。
    ListeningWindow { open: bool },
    /// 追问窗口开/关（播报结束后免唤醒词，默认 5s）。
    FollowupWindow { open: bool },
    /// 语音「退下」已执行（服务端已软关闭；端上应走与按钮相同的收尾表现）。
    Dismissed,
    /// 唤醒指令因原会话过期改投新会话，前端应收编（切流、换 localStorage）。
    SessionAdopted { session_id: String },
    /// 哨兵转写链路不可用/恢复（M25-04 显式降级的状态面）。
    SentinelDegraded { degraded: bool },
    /// 车主用语音拨了**闲聊旁路**的开关（施工单 M33-04，F-45-08）。
    ///
    /// 端上偏好已经改完了才发这条；设置页据此同步显示。
    /// **不发这条的后果不是"少一个事件"**：设置页开着的时候用语音关掉旁路，
    /// 界面上那个开关还亮着——用户看到的是"我说了它没听"，
    /// 而实际上已经关了。界面与实际不一致是最难自查的一类。
    SidecarSwitched { on: bool },
}

/// 哨兵监听指示快照（施工单 M25-04，F-52-06）：Rust 侧 emit（`voice:sentinel`）、
/// HUD 的 `MicIndicator` 消费。
///
/// **状态由采集层真实状态推导**（listen.rs 纪律：宁可迟亮，不可假灭）——
/// 快照在哨兵循环内生成，UI 不得自己维护一份。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SentinelIndication {
    /// 麦克风总开关（F-02-08 第一顺位）。
    pub switch_on: bool,
    pub state: SentinelListenState,
    /// 转写链路降级中（ASR 故障，M25-04 显式降级）。
    pub degraded: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum SentinelListenState {
    /// 总开关关闭，无采集。
    Off,
    /// 哨兵在位，静音等待。
    Idle,
    /// 检出语音，正在收段。
    Listening,
    /// 段已收尾，转写中。
    Uploading,
    /// 采集暂停/丢帧（PTT 占用、TTS 播报、降级、流未建）。
    Suspended,
}

/// 语音上行元数据，随 multipart 一起提交给网关。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AudioMeta {
    pub duration_ms: u32,
    /// 编码格式标识，取值必须等于 `DEFAULT_AUDIO_FORMAT`。
    pub format: String,
    pub sample_rate_hz: u32,
    pub channels: u8,
}

// ---------------------------------------------------------------------------
// 音频格式常量。
//
// ⚠️ TODO(M2-02 ASR 拍板)：以下为开发期假定值（16kHz 单声道 PCM），
// ASR 提供方确定后在此更新，并同步 `contracts/src/constants/`
// 的镜像常量（TS 侧镜像带指回本文件的注释，两处必须一致）。
// ---------------------------------------------------------------------------

pub const DEFAULT_AUDIO_FORMAT: &str = "pcm_s16le";
pub const DEFAULT_AUDIO_SAMPLE_RATE_HZ: u32 = 16_000;
pub const DEFAULT_AUDIO_CHANNELS: u8 = 1;
/// 单条语音时长上限（FL-02 边界：60s 超时自动结束）。
pub const MAX_CAPTURE_DURATION_MS: u32 = 60_000;
