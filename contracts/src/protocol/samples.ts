/**
 * 契约类型化样例（施工单 M2-01）。
 *
 * 双重职责：
 * 1. **编译期契约校验**：本文件的字面量以契约类型标注，Rust 侧契约改动
 *    经重新生成后若与样例形状不符，`typecheck` 立即报错；
 * 2. **运行时跨语言校验**：`scripts/check-contract-fixtures.ts` 断言本文件
 *    与 `fixtures/contract-events.json` 逐值相等，而同一份 fixtures 又被
 *    Rust 测试（`contract_roundtrip.rs`）做 serde 往返 —— 三方一致即契约成立。
 *
 * 另可作为 M2-04 mock 事件源、M2-05 UI 开发模式的标准样例数据。
 * 改动本文件必须同步 fixtures JSON，反之亦然。
 */

import type {
  AudioMeta,
  CaptureStatus,
  ChatMessage,
  EventEnvelope,
  HistoryPage,
} from "../generated";

/** 覆盖五类事件的一次典型语音对话事件序列（与 M2-00 Demo 脚本第 1-2 步对应）。 */
export const SAMPLE_ENVELOPES: EventEnvelope[] = [
  {
    eventId: "1",
    sessionId: "sess-demo-001",
    ts: 1770000000000,
    event: { type: "session", status: "created" },
  },
  {
    eventId: "2",
    sessionId: "sess-demo-001",
    ts: 1770000001000,
    event: {
      type: "prompt",
      turnId: "turn-1",
      source: "voice",
      transcript: "明天要跑一趟长途",
    },
  },
  {
    eventId: "3",
    sessionId: "sess-demo-001",
    ts: 1770000001500,
    event: { type: "update", kind: "state", state: "thinking" },
  },
  {
    // 等待期垫场话（M18-01，F-45-06）：夹在 thinking 与首个 delta 之间，
    // 正是它在真实链路上出现的位置。标准序列覆盖它，是为了让 mock 事件驱动器
    // 与真实 SSE 走同一条 fan-out 路径时，"垫场不进全文"也一并被验到。
    eventId: "3f",
    sessionId: "sess-demo-001",
    ts: 1770000001800,
    event: {
      type: "update",
      kind: "filler",
      turnId: "turn-1",
      text: "我在翻你这车的手册",
      source: "l0",
      interruptible: true,
    },
  },
  {
    eventId: "4",
    sessionId: "sess-demo-001",
    ts: 1770000002000,
    event: { type: "update", kind: "delta", turnId: "turn-1", text: "好的，" },
  },
  {
    eventId: "5b",
    sessionId: "sess-demo-001",
    ts: 1770000002500,
    event: {
      type: "update",
      kind: "branch",
      turnId: "turn-1",
      agent: "trip-task",
      status: "ok",
      durationMs: 2140,
      note: "路线规划已完成",
    },
  },
  {
    // 失败分支样本（M37-01）：端上"部分结果"横幅与桥接投影的契约锚点。
    // note 是服务端人话，端上原样渲染——样例里就该长成可直接展示的样子。
    eventId: "5c",
    sessionId: "sess-demo-001",
    ts: 1770000002600,
    event: {
      type: "update",
      kind: "branch",
      turnId: "turn-1",
      agent: "hotel-task",
      status: "timeout",
      durationMs: 60000,
      note: "酒店安排超时未返回",
    },
  },
  {
    eventId: "5",
    sessionId: "sess-demo-001",
    ts: 1770000003000,
    event: {
      type: "update",
      kind: "turn_end",
      turnId: "turn-1",
      messageId: "msg-assistant-1",
    },
  },
  {
    eventId: "6",
    sessionId: "sess-demo-001",
    ts: 1770000004000,
    event: {
      type: "permission",
      interruptId: "int-1",
      action: "calendar_write",
      title: "写入你的日历",
      details: [{ label: "10月1日", value: "出发（深圳 → 黄山）" }],
      scope: "google:primary",
      // 写自己的日历不外发个人信息给第三方——空数组是它的正常形态（M15-04）。
      // 试驾预约那条链路才会非空（`describeDisclosure` 生成，手机号已掩码）。
      disclosure: [],
    },
  },
  {
    eventId: "7",
    sessionId: "sess-demo-001",
    ts: 1770000005000,
    event: {
      type: "tool_call",
      toolCallId: "tc-1",
      toolName: "weather",
      displayName: "正在查沿途天气",
      status: "started",
    },
  },
];

export const SAMPLE_MESSAGES: ChatMessage[] = [
  {
    messageId: "msg-user-1",
    sessionId: "sess-demo-001",
    turnId: "turn-1",
    role: "user",
    source: "voice",
    content: "明天要跑一趟长途",
    ts: 1770000001000,
  },
  {
    messageId: "msg-assistant-1",
    sessionId: "sess-demo-001",
    turnId: "turn-1",
    role: "assistant",
    source: "text",
    content: "好的，出发前建议确认电量与胎压。",
    ts: 1770000003000,
  },
];

export const SAMPLE_HISTORY_PAGE: HistoryPage = {
  messages: [],
  hasMore: false,
  nextBefore: null,
};

export const SAMPLE_CAPTURE_STATUSES: CaptureStatus[] = [
  { kind: "started", mode: "push_to_talk" },
  { kind: "stopped", durationMs: 2300 },
  { kind: "uploading" },
  { kind: "uploaded" },
  { kind: "failed", reason: "permission_denied" },
];

export const SAMPLE_AUDIO_META: AudioMeta = {
  durationMs: 2300,
  format: "pcm_s16le",
  sampleRateHz: 16000,
  channels: 1,
};
