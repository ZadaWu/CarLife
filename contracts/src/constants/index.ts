/**
 * constants —— 全局常量（施工单 M2-01）。
 *
 * ⚠️ 音频常量为 Rust 契约的**镜像**，源头在
 * `clients/shared/rust/carlife-core/src/contract/voice.rs`（ts-rs 只生成类型不生成常量）。
 * 两处必须一致：Rust 侧 `contract_roundtrip.rs` 与 TS 侧
 * `scripts/check-contract-fixtures.ts` 均以 fixtures 中的 `audioMeta`
 * 对照各自常量，任一处改动不同步会在测试中暴露。
 *
 * TODO(M2-02 ASR 拍板)：当前为开发期假定值（16kHz 单声道 PCM），
 * ASR 提供方确定后与 Rust 侧同步更新。
 */

export const DEFAULT_AUDIO_FORMAT = "pcm_s16le";
export const DEFAULT_AUDIO_SAMPLE_RATE_HZ = 16000;
export const DEFAULT_AUDIO_CHANNELS = 1;
/** 单条语音时长上限（FL-02 边界：60s 超时自动结束）。 */
export const MAX_CAPTURE_DURATION_MS = 60000;

// ---------------------------------------------------------------------------
// LLM 默认模型
// ---------------------------------------------------------------------------

/**
 * DeepSeek 当前统一使用的非推理模型。
 * 各服务与旁路不得各自维护默认值。
 */
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

const DEPRECATED_DEEPSEEK_MODEL = "deepseek-chat";

/**
 * 解析 DeepSeek 模型配置。
 *
 * 旧值可能已经写进配置数据库或部署环境；在读取边界归一化，确保不会再把
 * 已弃用的模型名发给上游，同时保留通过自定义兼容端点指定其它模型的能力。
 */
export function resolveDeepSeekModel(value?: string | null): string {
  const candidate = value?.trim();
  if (!candidate || candidate === DEPRECATED_DEEPSEEK_MODEL) {
    return DEFAULT_DEEPSEEK_MODEL;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// 桥接事件名（Rust emit ↔ TS listen）。
// Rust 侧镜像：`clients/shared/rust/carlife-core/src/fanout.rs`（改动必须两侧同步）。
// ---------------------------------------------------------------------------

export const BRIDGE_EVENTS = {
  /** payload: AssistantState 字面量 */
  assistantState: "assistant:state",
  /** payload: UpdateDelta */
  dialogDelta: "dialog:delta",
  /** payload: ChatMessage */
  dialogMessage: "dialog:message",
  /** payload: { state: "online" | "reconnecting" } */
  netConnection: "net:connection",
  /** payload: CaptureStatus */
  voiceCapture: "voice:capture",
  /** payload: PermissionRequest（M13-05，HITL 确认弹窗） */
  dialogPermission: "dialog:permission",
  /** payload: UpdateFiller（M18-01，等待期垫场话） */
  dialogFiller: "dialog:filler",
  /** payload: ToolCallEvent（FL-08 F-08-05，工具进展；**不进历史**） */
  dialogToolCall: "dialog:tool_call",
  /** payload: WakeStatus（M25-03，唤醒状态；只有状态事实，不携带转写文本） */
  voiceWake: "voice:wake",
  /** payload: SentinelIndication（M25-04，哨兵指示快照；采集层真实状态推导） */
  voiceSentinel: "voice:sentinel",
  /** payload: UpdateTitle（M28-01，会话标题；**不进历史**，只更新左侧列表） */
  dialogTitle: "dialog:title",
  /** payload: UpdateBranch（M37-01，分支起止；failed/timeout 出"部分结果"标识，**不进历史**） */
  dialogBranch: "dialog:branch",
} as const;

/**
 * 会话已过期 / 已关闭时 `POST /v1/session/:id/messages` 的错误码（施工单 M22-01）。
 *
 * **不用 404**：404 的语义是"没有这个会话"，端上两种情况都会去建新的、行为碰巧一样，
 * 但排障时分不清"过期了"和"id 传错了"。
 *
 * 两个 TS 消费方（网关发、车机端认），所以常量放在这里防两处字面量漂移。
 * Rust 侧按字面量匹配，注释指回本常量——**不为一个字符串新开 ts-rs 结构体**。
 */
export const SESSION_EXPIRED = "session_expired";

/** 会话空闲多久算结束。默认 30 分钟，由 `CARLIFE_SESSION_IDLE_MIN` 覆盖。 */
export const DEFAULT_SESSION_IDLE_MIN = 30;
