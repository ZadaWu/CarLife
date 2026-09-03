/**
 * AssistantVoicePort 的 Tauri 实现（施工单 M2-03，F-02-09 接线）。
 *
 * 长按 → `invoke("start_push_to_talk")`，松手 → `invoke("stop_push_to_talk")`。
 * 接口签名不变（M1-03 红线）。
 *
 * 采集状态经 `voice:capture` 事件（CaptureStatus，M2-01 契约）由 Rust emit，
 * 订阅归 M2-04 的事件适配器；本模块只管命令上行。
 *
 * 与 `tauriVoicePort.ts` 分成两个文件是为了能被单测到：那边要 import `@carlife/ui`
 * 的 mock 端口（整包带着样式与图片，Node 里进不来），这里只有类型引用。
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { AssistantVoicePort } from "@carlife/ui";

export interface StopOutcome {
  turnId: string;
  durationMs: number;
  truncated: boolean;
  /**
   * Rust 侧**新建**了会话时返回：手上没有会话（关闭会话之后的第一次长按）
   * 或旧会话已过期（409）。正常上传时为空。前端拿到就要收编（`adoptSession`）。
   */
  sessionId?: string;
}

export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * @param getSessionId 当前会话 id 提供者。**没有会话时不丢录音**（2026-09-03 车机走查）：
 *   「退下」/「新建对话」之后端上的会话位是空的、下一句话才现建（M50-02），
 *   文字那条路一直靠 `ensureUsableSession` 现建，语音这条原来却在这里把整段录音
 *   丢掉、只留一行 warn——车主看到的就是"关掉会话之后长按老是录不上"。
 *   现在把 `null` 原样交给 Rust，由它停完采集再现建会话并上传，新 id 随 outcome 回来。
 * @param invoke 可注入，单测用；生产走 Tauri 的 invoke。
 */
export function createTauriVoicePort(
  getSessionId: () => string | null,
  onStopped?: (outcome: StopOutcome) => void,
  invoke: InvokeFn = tauriInvoke,
): AssistantVoicePort {
  return {
    async startPushToTalk() {
      await invoke("start_push_to_talk");
    },
    async stopPushToTalk() {
      const sessionId = getSessionId();
      if (!sessionId) console.info("[voice] 无活跃会话，交给 Rust 侧现建后上传");
      const outcome = await invoke<StopOutcome>("stop_push_to_talk", { sessionId });
      onStopped?.(outcome);
    },
  };
}
