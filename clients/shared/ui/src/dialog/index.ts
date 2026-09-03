// dialog — 对话层（M65-02 上提）：消息流 + 会话历史 + 会话生命周期判据，两端共用
export { DialogScreen } from "./DialogScreen";
export type { DialogScreenProps, StreamingTurn } from "./DialogScreen";
export { SessionList, sessionResumable } from "./SessionList";
export type { SessionBrief, SessionListProps } from "./SessionList";
// `AssistantMode` 类型不在这里 re-export：assistant-avatar 已经导出同名类型（同为 "rest" | "work"）。
export { IDLE_MS, assistantMode, canResume, canRetire } from "./session-lifecycle";
