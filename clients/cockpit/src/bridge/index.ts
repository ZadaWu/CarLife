/**
 * 桥接层事件适配器（施工单 M2-04，F-01-08）。
 *
 * 订阅 Rust 侧 emit 的桥接事件，映射为回调——这是助手状态机与对话记录的
 * **唯一**外部数据入口（AC-01-3）。适配器只做映射不做业务决策；
 * 未注册处理器的事件被忽略（Rust 侧另有未知事件计数）。
 *
 * 非 Tauri 环境（纯浏览器 vite dev）下 `subscribeBridge` 为 no-op，
 * UI 开发用 `start_mock_stream` 命令（Tauri 内）回放标准样例序列。
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  BRIDGE_EVENTS,
  type AssistantState,
  type CaptureStatus,
  type ChatMessage,
  type PermissionRequest,
  type SentinelIndication,
  type UpdateBranch,
  type UpdateTitle,
  type ToolCallEvent,
  type UpdateDelta,
  type WakeStatus,
} from "@carlife/shared";

export interface ConnectionState {
  state: "online" | "reconnecting";
}

export interface BridgeHandlers {
  onAssistantState?: (state: AssistantState) => void;
  onDelta?: (delta: UpdateDelta) => void;
  /**
   * 工具进展（FL-08 F-08-05）：不注册就等于让车主继续对着十几秒空白等。
   * **它不进对话历史**——桥接层已经不写缓存，UI 也只该把它放在思考区。
   */
  onToolCall?: (event: ToolCallEvent) => void;
  onMessage?: (message: ChatMessage) => void;
  onConnection?: (conn: ConnectionState) => void;
  onCaptureStatus?: (status: CaptureStatus) => void;
  /** HITL 确认请求（M13-05）：不注册就等于把弹窗扔了——权限门会挂到超时。 */
  onPermission?: (request: PermissionRequest) => void;
  /** 唤醒状态（M25-03）：形象联动、窗口指示、409 收编都靠它。 */
  onWakeStatus?: (status: WakeStatus) => void;
  /** 哨兵指示快照（M25-04）：MicIndicator 的唯一数据源，页面不得自行推断。 */
  onSentinelStatus?: (status: SentinelIndication) => void;
  /**
   * 会话标题（M28-01）：首轮结束后旁路起的名字，更新左侧历史列表里这一条。
   * **不进对话历史**——它不是助手说的话。
   */
  onSessionTitle?: (update: UpdateTitle) => void;
  /**
   * 分支起止（M37-01）：failed/timeout 由对话层出"部分结果"横幅。
   * 不注册就退回旧形态——失败信息只剩正文文字，用户看不看得到取决于模型自觉。
   * **不进对话历史**——它是本轮的状态标识，不是助手说的话。
   */
  onBranch?: (update: UpdateBranch) => void;
}

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 订阅桥接事件；返回退订函数。 */
export async function subscribeBridge(handlers: BridgeHandlers): Promise<() => void> {
  if (!isTauriEnv()) return () => {};

  const unlisteners: UnlistenFn[] = [];
  const on = async <T>(event: string, cb?: (payload: T) => void) => {
    if (!cb) return;
    unlisteners.push(await listen<T>(event, (e) => cb(e.payload)));
  };

  await on<AssistantState>(BRIDGE_EVENTS.assistantState, handlers.onAssistantState);
  await on<UpdateDelta>(BRIDGE_EVENTS.dialogDelta, handlers.onDelta);
  await on<ToolCallEvent>(BRIDGE_EVENTS.dialogToolCall, handlers.onToolCall);
  await on<ChatMessage>(BRIDGE_EVENTS.dialogMessage, handlers.onMessage);
  await on<ConnectionState>(BRIDGE_EVENTS.netConnection, handlers.onConnection);
  await on<CaptureStatus>(BRIDGE_EVENTS.voiceCapture, handlers.onCaptureStatus);
  await on<PermissionRequest>(BRIDGE_EVENTS.dialogPermission, handlers.onPermission);
  await on<WakeStatus>(BRIDGE_EVENTS.voiceWake, handlers.onWakeStatus);
  await on<SentinelIndication>(BRIDGE_EVENTS.voiceSentinel, handlers.onSentinelStatus);
  await on<UpdateTitle>(BRIDGE_EVENTS.dialogTitle, handlers.onSessionTitle);
  await on<UpdateBranch>(BRIDGE_EVENTS.dialogBranch, handlers.onBranch);

  return () => {
    for (const un of unlisteners) un();
  };
}
