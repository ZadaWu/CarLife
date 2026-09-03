/**
 * 语音端口的环境自适应入口：Tauri 内用真实端口（`pttPort.ts`），
 * 纯浏览器 vite dev 用 `@carlife/ui` 的 mock。
 *
 * 真实端口的实现与说明在 `pttPort.ts`——拆开是为了让它能被 Node 单测到
 * （`@carlife/ui` 根包带着样式与图片，进不了 node:test）。
 */

import { mockVoicePort, type AssistantVoicePort } from "@carlife/ui";
import { createTauriVoicePort, type StopOutcome } from "./pttPort";

export { createTauriVoicePort, type StopOutcome } from "./pttPort";

/** 是否运行在 Tauri WebView 内（纯浏览器开发时为 false）。 */
export function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 环境自适应：Tauri 内用真实端口，浏览器开发用 mock。 */
export function createVoicePort(
  getSessionId: () => string | null,
  onStopped?: (outcome: StopOutcome) => void,
): AssistantVoicePort {
  return isTauriEnv() ? createTauriVoicePort(getSessionId, onStopped) : mockVoicePort;
}
