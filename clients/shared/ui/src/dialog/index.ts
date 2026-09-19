// dialog — 对话层（M65-02 上提）：消息流 + 会话历史 + 会话生命周期判据，两端共用
export { DialogScreen, splitHighlights } from "./DialogScreen";
export type { DialogScreenProps, StreamingTurn } from "./DialogScreen";
export { SessionList, sessionResumable, sessionRowText } from "./SessionList";
export type { SessionBrief, SessionListProps } from "./SessionList";
// `AssistantMode` 类型不在这里 re-export：assistant-avatar 已经导出同名类型（同为 "rest" | "work"）。
export { IDLE_MS, assistantMode, canResume, canRetire } from "./session-lifecycle";
// 附件（M80-03）：气泡里的缩略图 / 播放器，与选择前的预检。
export { AttachmentStrip, releaseAttachmentUrls } from "./AttachmentStrip";
export type { AttachmentLoader } from "./AttachmentStrip";
export { attachmentLabel, checkPendingAdd, durationHint, formatBytes, kindOfFile, kindOfMime, readyDetections, readyHandles, MAX_DETECTIONS_PER_PHOTO } from "./attachments";
export type { PendingAttachment } from "./attachments";
// 端上框灯（ACR-044）：开关、摘要与结果类型；两端的 Tauri 端口按 `OnDeviceDetectResult` 回。
export { ON_DEVICE_VISION_KEY, detectSummary, onDeviceVisionEnabled, setOnDeviceVisionEnabled } from "./attachments";
export type { OnDeviceDetectResult, OnDeviceDetection, PendingDetect } from "./attachments";
// 版式截图入口用的演示数据（`?dialog=demo`）：两端共用一份。
export { DEMO_DIALOG_MESSAGES, DEMO_DIALOG_SESSIONS, DEMO_DIALOG_STREAMING, isDialogDemo } from "./demo-dialog";
