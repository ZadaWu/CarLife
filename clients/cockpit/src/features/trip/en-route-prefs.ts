/**
 * 途中提醒的端上偏好（施工单 M77-07，F-62-11 / F-62-12）。
 *
 * 真相源在 Rust（`commands/reminders.rs` 的两个静态量 + 偏好文件）：`speak_reminder` 要读它，
 * 放前端 localStorage 的话语音口令拨了档而出声那一侧不知道。前端只做三件事：
 * 启动时问一次、订阅 Rust 的三个事件、把字符串档位收窄成 `ReminderDensity`。
 *
 * 事件名与 Rust 的 `EVENT_*` 常量一字不差——`en-route-prefs.test.ts` 读 Rust 源码比对。
 */
import type { ReminderDensity } from "@carlife/ui";

export const EN_ROUTE_EVENTS = {
  enabled: "en-route-enabled",
  density: "en-route-density",
  hushed: "en-route-hushed",
} as const;

export const DENSITIES: readonly ReminderDensity[] = ["high", "normal", "low"];

/** Rust 回的字符串 → 档位。认不出的一律**适中**：传错值时静默变成"不提醒"是最不该发生的那种默认。 */
export function densityFromRust(value: unknown): ReminderDensity {
  return value === "high" || value === "low" ? value : "normal";
}

export function densityLabel(d: ReminderDensity): string {
  return d === "high" ? "多提醒" : d === "low" ? "少提醒" : "适中";
}

/** 设置页那行说明：写清楚"这一档到底少了什么"，不写"更少的提醒"。 */
export function describeDensity(d: ReminderDensity): string {
  switch (d) {
    case "high":
      return "停靠提醒多带一句下一段要开多久；连续驾驶提醒照常。";
    case "low":
      return "停靠提醒只出卡片不出声；连续驾驶提醒（安全类）仍会说。";
    default:
      return "停靠提前 10 分钟说一句，连续驾驶到上限九成说一句。也可以直接说「少提醒点」「多提醒点」。";
  }
}
