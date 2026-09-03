/**
 * AssistantVoicePort 的 Tauri 实现（施工单 M2-03，F-02-09 接线）。
 *
 * 替换 M1-03 的 mock：长按 → `invoke("start_push_to_talk")`，
 * 松手 → `invoke("stop_push_to_talk")`。接口签名不变（M1-03 红线）；
 * mock 保留为非 Tauri 环境（纯浏览器 vite dev）的开发模式。
 *
 * 采集状态经 `voice:capture` 事件（CaptureStatus，M2-01 契约）由 Rust emit，
 * 订阅归 M2-04 的事件适配器；本模块只管命令上行。
 */

import { invoke } from "@tauri-apps/api/core";
import { mockVoicePort, type AssistantVoicePort } from "@carlife/ui";

/** 是否运行在 Tauri WebView 内（纯浏览器开发时为 false）。 */
export function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface StopOutcome {
  turnId: string;
  durationMs: number;
  truncated: boolean;
  /** Rust 侧收编过期会话时返回；正常 PTT 上传时为空。 */
  sessionId?: string;
}

/**
 * @param getSessionId 当前会话 id 提供者（会话引导在 M2-04/05 落地；
 *                     无会话时松手丢弃本段录音并记警告，不抛错打断手势）。
 */
export function createTauriVoicePort(
  getSessionId: () => string | null,
  onStopped?: (outcome: StopOutcome) => void,
): AssistantVoicePort {
  return {
    async startPushToTalk() {
      await invoke("start_push_to_talk");
    },
    async stopPushToTalk() {
      const sessionId = getSessionId();
      if (!sessionId) {
        console.warn("[voice] 无活跃会话，丢弃本段录音");
        // 仍需停止采集释放麦克风：用占位会话，上传必然 404，Rust 侧按失败处理。
        await invoke("stop_push_to_talk", { sessionId: "sess-none" }).catch(() => {});
        return;
      }
      const outcome = await invoke<StopOutcome>("stop_push_to_talk", { sessionId });
      onStopped?.(outcome);
    },
  };
}

/** 环境自适应：Tauri 内用真实端口，浏览器开发用 mock。 */
export function createVoicePort(
  getSessionId: () => string | null,
  onStopped?: (outcome: StopOutcome) => void,
): AssistantVoicePort {
  return isTauriEnv() ? createTauriVoicePort(getSessionId, onStopped) : mockVoicePort;
}
