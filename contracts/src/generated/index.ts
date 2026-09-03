/**
 * ts-rs 生成物的 barrel（施工单 M2-01）。
 *
 * ⚠️ 本目录下除本文件外全部为生成文件，**不得手工编辑**。
 * 唯一真相源：`clients/shared/rust/carlife-core/src/contract/`。
 * 重新生成：`corepack pnpm generate:contract`（幂等，生成物入库）。
 * 契约变更流程：改 Rust → 重新生成 → 本 barrel 增删对应行 → typecheck 捕获消费点。
 */

// events —— SSE 会话事件（ACP 语义投影，§3）
export type { AssistantState } from "./AssistantState";
export type { EventEnvelope } from "./EventEnvelope";
export type { SessionEvent } from "./SessionEvent";
export type { SessionOpened } from "./SessionOpened";
export type { SessionOpenStatus } from "./SessionOpenStatus";
export type { PromptAccepted } from "./PromptAccepted";
export type { SessionUpdate } from "./SessionUpdate";
export type { UpdateDelta } from "./UpdateDelta";
export type { UpdateState } from "./UpdateState";
export type { UpdateTitle } from "./UpdateTitle";
export type { UpdateTurnEnd } from "./UpdateTurnEnd";
export type { UpdateFiller } from "./UpdateFiller";
export type { FillerSource } from "./FillerSource";
export type { UpdateBranch } from "./UpdateBranch";
export type { BranchStatus } from "./BranchStatus";
export type { PermissionRequest } from "./PermissionRequest";
export type { PermissionDetail } from "./PermissionDetail";
export type { ToolCallEvent } from "./ToolCallEvent";
export type { ToolCallStatus } from "./ToolCallStatus";

// messages —— 对话消息与历史查询（FL-03 F-03-12）
export type { ChatRole } from "./ChatRole";
export type { MessageSource } from "./MessageSource";
export type { ChatMessage } from "./ChatMessage";
export type { HistoryQuery } from "./HistoryQuery";
export type { HistoryPage } from "./HistoryPage";
export type { AttachmentRef } from "./AttachmentRef";
export type { AttachmentKind } from "./AttachmentKind";
export type { ThoughtStep } from "./ThoughtStep";

// voice —— 语音会话（FL-02 F-02-13）
export type { CaptureMode } from "./CaptureMode";
export type { CaptureStatus } from "./CaptureStatus";
export type { CaptureStarted } from "./CaptureStarted";
export type { CaptureStopped } from "./CaptureStopped";
export type { CaptureFailed } from "./CaptureFailed";
export type { AudioMeta } from "./AudioMeta";
export type { WakeStatus } from "./WakeStatus";
export type { SentinelIndication } from "./SentinelIndication";
export type { SentinelListenState } from "./SentinelListenState";
