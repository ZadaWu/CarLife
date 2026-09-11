/**
 * 途中提醒的文案表（施工单 M77-05，FL-62 F-62-06）。
 *
 * # 一句话一口气，关键信息前置
 *
 * 车机上一句提醒能占的注意力只有几秒：站名 → 距离 → 原因 → 余量，重要的在前。
 * 槽位缺省时**整句去掉**，不留"预计 -- 到"这种空洞——摆一个像真的却是空的字段，比不说糟。
 *
 * # 不出现疲劳判断
 *
 * 连续驾驶提醒只说"开了多久、前面哪能停"，不说"你累了"——那是对人的判断，§8.3 不允许，
 * 车主也不爱听。`FORBIDDEN_FATIGUE_WORDS` 导出给单测当负例词表。
 *
 * 两端一份：车机端念、手机端只显示，文案不能各写一版。
 */

export interface ReminderText {
  headline: string;
  body?: string;
  caption?: string;
}

export interface StopReminderSlots {
  stopName: string;
  remainingM: number;
  /** 预计到达时刻 `HH:MM`；没有 ETA 就没有（不用常数拍一个）。 */
  etaClock?: string;
  reason?: "rest" | "charge";
  /** 到站余量百分比（US-61 的账本落地后才有）。 */
  remainingPct?: number;
  /** 依据行，如「同行者约束：每 2 小时停一次」。 */
  constraintLine?: string;
}

export interface RestReminderSlots {
  drivenMin: number;
  nextStopName?: string;
  remainingM?: number;
  limitMin: number;
}

/** 单测负例词表：这些词一个都不许出现在提醒里。 */
export const FORBIDDEN_FATIGUE_WORDS = ["累", "疲劳", "注意休息", "困", "犯困", "打瞌睡"] as const;

/** 「1 小时 50 分」/「45 分」。 */
export function durationText(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} 分`;
  return r === 0 ? `${h} 小时` : `${h} 小时 ${r} 分`;
}

/** 「15 公里」/「800 米」——10 公里以上取整，以下一位小数，1 公里以内用米。 */
export function distanceText(m: number): string {
  if (m < 1000) return `${Math.round(m / 50) * 50} 米`;
  const km = m / 1000;
  return `${km >= 10 ? Math.round(km) : km.toFixed(1)} 公里`;
}

export function formatStopReminder(s: StopReminderSlots): ReminderText {
  const headline = `前面 ${distanceText(s.remainingM)}是 ${s.stopName}`;
  const parts: string[] = [];
  if (s.reason === "charge") parts.push("按计划在这充一下");
  else if (s.reason === "rest") parts.push("按计划在这歇一下");
  if (s.etaClock) parts.push(`预计 ${s.etaClock} 到`);
  if (typeof s.remainingPct === "number") parts.push(`到那大概还剩 ${Math.round(s.remainingPct)}%`);
  return {
    headline,
    ...(parts.length ? { body: parts.join(" · ") } : {}),
    ...(s.constraintLine ? { caption: s.constraintLine } : {}),
  };
}

export function formatRestReminder(s: RestReminderSlots): ReminderText {
  const headline = `已经开了 ${durationText(s.drivenMin)}`;
  const body =
    s.nextStopName && typeof s.remainingM === "number"
      ? `前面 ${distanceText(s.remainingM)}有 ${s.nextStopName}，要不要歇一下`
      : "要不要找个地方歇一下";
  const pct = Math.min(100, Math.round((s.drivenMin / s.limitMin) * 100));
  return { headline, body, caption: `同行者约束：每 ${durationText(s.limitMin)} 停一次 · 已到 ${pct}%` };
}

/** 播报用的一句话：标题与正文用逗号接起来，caption 不念（它是依据，屏上看就够）。 */
export function spokenLine(t: ReminderText): string {
  return t.body ? `${t.headline}，${t.body}` : t.headline;
}
