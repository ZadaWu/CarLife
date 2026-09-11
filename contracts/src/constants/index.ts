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

/**
 * DeepSeek 的视觉档（M80-02，ACR-027）。
 *
 * 只在**这一次请求里带了图片**时用它；纯文字的请求仍走 `DEFAULT_DEEPSEEK_MODEL`。选档在
 * `agent-runtime/src/llm` 按每次请求判，不是按会话钉死：车主前几轮打字、中途发一张照片、再追问两句——
 * 同一会话里两档交替是常态。
 *
 * 2026-09-10 起两档落在**同一个模型**上：DeepSeek 把 V4.1 Flash 以 `deepseek-flash` 之名正式放出，
 * 旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` / 预览档 `deepseek-v4.1-flash-expires-on-0910`
 * 全部被服务端别名到它（同一张图四个名字的 prompt token 与 system_fingerprint 完全相同）。
 * 这里直接写正式名，不靠别名——别名迟早撤。两档的区分保留着，是给将来它们再分开时用的。
 */
export const DEFAULT_DEEPSEEK_VISION_MODEL = "deepseek-flash";

export function resolveDeepSeekVisionModel(value?: string | null): string {
  const candidate = value?.trim();
  return candidate ? candidate : DEFAULT_DEEPSEEK_VISION_MODEL;
}

// ---------------------------------------------------------------------------
// 每轮附件上限（M80-01）。端上预检与网关校验共用同一份数字，别各抄一份。
// ---------------------------------------------------------------------------

/**
 * 数字的来源（2026-09-09 读 api-docs.deepseek.com/guides/vision）：
 * DeepSeek 视觉档单次请求最多 600 张图、请求体 48 MiB、单图 32 MiB、每图折算 ≤ 384 token。
 * 真正卡住我们的不是 600，而是请求体与可读性：
 * - 9 张照片 + 1 段视频（最多 6 张帧序图）= 15 张图，恰好卡在 DeepSeek「≥ 15 张时单边 ≤ 4096 px」的门内
 *   （帧序图宽 2400 px，照片端上压到 ≤ 8 MB 且长边通常 ≤ 4096）；
 * - 视频只收 1 段、只分析前 60 秒：一分钟以内的异响/抖动/仪表闪烁足够看清，再长的是"两件事"，
 *   合在一次请求里模型会把两段的观察混着说。
 */
export const TURN_ATTACHMENT_LIMITS = {
  /** 单轮最多几张照片。 */
  maxImages: 9,
  /** 单轮最多几段视频。 */
  maxVideos: 1,
  /** 单轮附件总数（照片 + 视频）。 */
  maxTotal: 10,
  /** 视频只分析前这么多毫秒；更长的**不拒绝**，截断并在上下文里如实说明。 */
  videoAnalyzedMs: 60_000,
  /** 视频原件上限（字节）。iOS 相册经 WebView 文件选择器导出的 60 秒 720p 约 15–40 MB。 */
  videoMaxBytes: 64 * 1024 * 1024,
  /** 照片原件上限（字节），与网关 `upload/policy.ts` 的 image 白名单一致。 */
  imageMaxBytes: 8 * 1024 * 1024,
} as const;

/** 视频抽帧参数（M80-01）：每张帧序图覆盖 10 秒、每 2 秒一帧 → 1 行 5 列；60 秒 → 6 张。 */
export const VIDEO_SHEET_PARAMS = {
  segmentMs: 10_000,
  frameIntervalMs: 2_000,
  /** 单帧缩放后的宽（像素）；5 帧并排 2400 px，DeepSeek 会再按 ~800×800 等效像素缩放（每图 ≤ 384 token）。 */
  frameWidth: 480,
} as const;

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

// 途中提醒的文案表（M77-05，F-62-06）：两端一份，槽位缺省整句去掉，不出现疲劳判断。
// 附件 MIME 归一化（M80-04）：端上预检 / 上传请求头 / 网关白名单同一份判断。
export * from "./media";
export * from "./en-route";
