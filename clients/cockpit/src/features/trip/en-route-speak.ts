/**
 * 途中提醒的出声胶水（施工单 M77-06，F-62-08）。
 *
 * 途中提醒走端上直接 TTS（Tauri 命令 `speak_reminder`），**不经 `sendText` 进会话**——
 * 它是端上闸门算出来的固定文案，没有需要模型回话的内容。到站 / 点火播报仍走 `sendText`
 * （它们的开头是服务端判据的一部分），两条路别混。
 *
 * 浏览器走查没有 Tauri：返回 false，卡片照出、只是不出声。
 */
export type SpeakReminder = (line: string, kind: "stop" | "rest") => Promise<boolean>;

export function createTauriReminderSpeaker(
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
  isTauri: () => boolean,
): SpeakReminder {
  return async (line, kind) => {
    if (!isTauri()) return false;
    try {
      return await invoke<boolean>("speak_reminder", { text: line, kind });
    } catch (err) {
      console.warn("[en-route] speak_reminder 失败，只留卡片", err);
      return false;
    }
  };
}
