/**
 * 途中提醒的判据（施工单 M77-05，FL-62 F-62-04 / 05 / 07 / 13）。
 *
 * # 两类提醒两种重量
 *
 * - 停靠提前提醒：距下一个计划停靠还有一个提前量时说一句（有 ETA 按时间，没有按距离）。一站一次，错过不补——
 *   到站后交给既有的到站播报（`nav-announce.ts`）。
 * - 连续驾驶提醒：本段开了上限的 90% 且前方没有能及时到的计划停靠时说一句。用户说"不用"后本段静默，
 *   驻车后由 tracker 重置计时。它是**安全类**（AC-19-4 允许打断），用 alert 形态，不用红。
 *
 * # 闸：说 / 顺延 / 只卡片
 *
 * 车速剧变或上一句在飞 → 顺延；顺延累计超过提前量的一半 → 降级为只卡片；密度 low 档下停靠提醒恒只卡片。
 * 去重与在飞的两道闸沿 `nav-announce.ts` 的判据，不复制一份实现——在飞状态由调用方经 memo 传入。
 *
 * # 不做导航
 *
 * 判据只读快照里的停靠与当前进度，不产生转向、不重算路线、不判"走错了"。
 */

import type { TripPlanLeg } from "@carlife/shared";
import { formatRestReminder, formatStopReminder, type ReminderText } from "@carlife/shared";

import type { NavTripProgress } from "../map";
import { drivenMinutes, isPositionStale, speedJump, type TrackerState } from "./en-route-tracker";

export type ReminderDensity = "high" | "normal" | "low";

export interface ReminderMemo {
  /** 已提醒过的停靠点名（一站一次）。 */
  remindedStops: string[];
  /** 用户对连续驾驶提醒说了"不用"的那一段。 */
  restDeclinedLeg?: number;
  /** 已经催过一次的那一段（说出去或只卡片都算）——一段只催一次，不每帧重复。 */
  restRemindedLeg?: number;
  /** 用户说了"闭嘴"的那一段：本段不再主动提醒。 */
  hushedLeg?: number;
  /** 顺延从何时开始；说出去或降级后清空。 */
  deferredSince?: number;
  /** 上一句播报（到站 / 提醒）还没回完。 */
  inFlight: boolean;
}

export const INITIAL_MEMO: ReminderMemo = { remindedStops: [], inFlight: false };

export interface ReminderConfig {
  /** 提前量（秒），有 ETA 时用。默认 10 分钟——没有依据，上线带计数标定（FL-62 未决 #1）。 */
  leadSec: number;
  /** 提前量（米），没有 ETA 时用。 */
  leadM: number;
  /** 连续驾驶上限（分钟）。同行者约束不在快照里，由调用方给；缺省按安全上限 180。 */
  limitMin: number;
  /** 达到上限的这个比例就提醒。 */
  ratio: number;
  /** 相邻两帧差分车速变化超过它 → 视为车速剧变，顺延。 */
  speedJumpKmh: number;
}

export const DEFAULT_REMINDER_CONFIG: ReminderConfig = { leadSec: 600, leadM: 8_000, limitMin: 180, ratio: 0.9, speedJumpKmh: 30 };

export interface StopReminder {
  kind: "stop";
  stopName: string;
  remainingM: number;
  remainingSec?: number;
  reason?: "rest" | "charge";
  legIndex: number;
}

export interface RestReminder {
  kind: "rest";
  drivenMin: number;
  nextStopName?: string;
  remainingM?: number;
  legIndex: number;
}

export type Reminder = StopReminder | RestReminder;

/** 停靠提前提醒。位置陈旧时不发（它依赖位置）；`legs` 缺省仍按距离发，只少"原因"。 */
export function shouldRemindStop(
  frame: NavTripProgress,
  tracker: TrackerState,
  plan: { legs?: readonly TripPlanLeg[] },
  memo: ReminderMemo,
  nowMs: number,
  cfg: ReminderConfig = DEFAULT_REMINDER_CONFIG,
): StopReminder | undefined {
  if (frame.finished || !frame.nextStopName) return undefined;
  if (isPositionStale(tracker, nowMs)) return undefined;
  if (memo.hushedLeg === tracker.legIndex) return undefined;
  if (memo.remindedStops.includes(frame.nextStopName)) return undefined;
  const near = frame.remainingSec !== undefined ? frame.remainingSec <= cfg.leadSec : frame.remainingM <= cfg.leadM;
  if (!near) return undefined;
  const leg = plan.legs?.find((l) => l.toStop === frame.nextStopName);
  return {
    kind: "stop",
    stopName: frame.nextStopName,
    remainingM: frame.remainingM,
    ...(frame.remainingSec !== undefined ? { remainingSec: frame.remainingSec } : {}),
    ...(leg?.reason ? { reason: leg.reason } : {}),
    legIndex: tracker.legIndex,
  };
}

/** 连续驾驶提醒。只需要时钟——位置陈旧也照发。 */
export function shouldRemindRest(
  frame: NavTripProgress | undefined,
  tracker: TrackerState,
  memo: ReminderMemo,
  nowMs: number,
  cfg: ReminderConfig = DEFAULT_REMINDER_CONFIG,
): RestReminder | undefined {
  if (tracker.finished) return undefined;
  if (memo.restDeclinedLeg === tracker.legIndex || memo.hushedLeg === tracker.legIndex || memo.restRemindedLeg === tracker.legIndex) return undefined;
  const driven = drivenMinutes(tracker, nowMs);
  if (driven < cfg.limitMin * cfg.ratio) return undefined;
  // 前方计划停靠来得及（在剩余额度内到）→ 不催；额度按上限算，不按 90%。
  const allowanceMin = Math.max(0, cfg.limitMin - driven);
  if (frame && !frame.finished && frame.remainingSec !== undefined && frame.remainingSec / 60 <= allowanceMin) return undefined;
  return {
    kind: "rest",
    drivenMin: Math.round(driven),
    ...(frame?.nextStopName ? { nextStopName: frame.nextStopName } : {}),
    ...(frame && !isPositionStale(tracker, nowMs) ? { remainingM: frame.remainingM } : {}),
    legIndex: tracker.legIndex,
  };
}

export type ReminderGate = "speak" | "defer" | "card-only";

/** 说 / 顺延 / 只卡片。 */
export function gateReminder(
  reminder: Reminder,
  tracker: TrackerState,
  memo: ReminderMemo,
  nowMs: number,
  density: ReminderDensity = "normal",
  cfg: ReminderConfig = DEFAULT_REMINDER_CONFIG,
): ReminderGate {
  if (density === "low" && reminder.kind === "stop") return "card-only";
  const busy = memo.inFlight || speedJump(tracker) > cfg.speedJumpKmh;
  if (!busy) return "speak";
  const since = memo.deferredSince ?? nowMs;
  return nowMs - since >= (cfg.leadSec * 1000) / 2 ? "card-only" : "defer";
}

/** 判定后的 memo 更新：一站一次 / 顺延起点 / 出声后清顺延。 */
export function afterGate(memo: ReminderMemo, reminder: Reminder, gate: ReminderGate, nowMs: number): ReminderMemo {
  if (gate === "defer") return { ...memo, deferredSince: memo.deferredSince ?? nowMs };
  const remembered = reminder.kind === "stop" ? [...new Set([...memo.remindedStops, reminder.stopName])] : memo.remindedStops;
  return {
    ...memo,
    remindedStops: remembered,
    ...(reminder.kind === "rest" ? { restRemindedLeg: reminder.legIndex } : {}),
    deferredSince: undefined,
  };
}

/** 文案：吃 contracts 的模板；ETA 时刻由调用方按本地时钟算好传入（这里不读时钟）。 */
export function reminderText(
  reminder: Reminder,
  opts: { etaClock?: string; constraintLine?: string; limitMin?: number; remainingPct?: number } = {},
): ReminderText {
  if (reminder.kind === "stop") {
    return formatStopReminder({
      stopName: reminder.stopName,
      remainingM: reminder.remainingM,
      ...(opts.etaClock ? { etaClock: opts.etaClock } : {}),
      ...(reminder.reason ? { reason: reminder.reason } : {}),
      ...(typeof opts.remainingPct === "number" ? { remainingPct: opts.remainingPct } : {}),
      ...(opts.constraintLine ? { constraintLine: opts.constraintLine } : {}),
    });
  }
  return formatRestReminder({
    drivenMin: reminder.drivenMin,
    ...(reminder.nextStopName ? { nextStopName: reminder.nextStopName } : {}),
    ...(typeof reminder.remainingM === "number" ? { remainingM: reminder.remainingM } : {}),
    limitMin: opts.limitMin ?? DEFAULT_REMINDER_CONFIG.limitMin,
  });
}

/** 「14:20」——由 `nowMs + remainingSec` 得到的本地时刻；调用方传 now，这里不读时钟。 */
export function etaClockOf(nowMs: number, remainingSec: number): string {
  const d = new Date(nowMs + remainingSec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
