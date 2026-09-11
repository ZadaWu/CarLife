/**
 * 行程每日核查（施工单 M72-01，设计 内部文档）。
 *
 * 守夜人每天替车主看一眼每一程：逐日天气、下一出行日的出发路线。这里是**核查结果的形状**
 * 与**"变没变"的判据**——worker 写、网关搬、端上读，三处只能有一份判据，所以放 contracts。
 *
 * # 核查另存，不碰批准过的行程
 *
 * `trip_plans.plan` 是用户点过确认弹窗的那份（M20-06 的纪律：环境数据不该悄悄改写它）。
 * 核查是"环境现在怎样"，与"用户当时批了什么"是两件事，落两处。
 *
 * # 变化 = 签名比对，不是逐字段 diff
 *
 * 温度变一度不该打扰车主；晴转雨、新增预警、路上多开半小时才该。签名只收这些进得了
 * 判据的量：逐日 `WeatherKind`、预警标题集合、路线时长（取整 10 分钟）与里程（取整 5 km）。
 * 核查永远与**上一份核查**比，不与首份比——周一确认了"转雨"，周三又转回晴，那确实又变了。
 *
 * # 首份核查没有基线
 *
 * 行程确认那刻快照里只有一个整程的 `weather.kind`（M20-05），不是逐日的，拿它当基线会把
 * "第 3 天本来就下雨"记成"变了"。所以首份只记录，`changes` 为空。
 */

import type { WeatherKind } from "./hud";
import { tripDayIndex, type TripPlanSnapshot } from "./trip-plan";

// ── 形状 ──────────────────────────────────────────────────────

export interface TripReviewDay {
  /** 第几天（1 起，与 `TripPlanDaySnapshot.day` 同口径）。 */
  day: number;
  /** `YYYY-MM-DD`；行程没定日期时缺省。 */
  date?: string;
  kind?: WeatherKind;
  /** 展示用短描述（`WEATHER_LABELS` 或供应商的中文现象）。 */
  label?: string;
  tempMinC?: number;
  tempMaxC?: number;
  /** 气象预警标题（已去重）。 */
  alarms?: string[];
  /** 超出预报窗口 / 没有坐标 / 供应商失败——**不是**"晴"，展示层画灰点。 */
  unavailable?: boolean;
}

export interface TripReviewRoute {
  /** 核查的是第几天的出发路线。 */
  day: number;
  from: string;
  to: string;
  distanceKm: number;
  durationMin: number;
  tollYuan?: number;
}

export type TripReviewChangeKind = "weather" | "alarm" | "route";
export type TripReviewSeverity = "none" | "notice" | "critical";

export interface TripReviewChange {
  kind: TripReviewChangeKind;
  day?: number;
  before: string;
  after: string;
  severity: Exclude<TripReviewSeverity, "none">;
  /** 给人读的一句，例如「第 2 天：多云 → 有雨」。弹层与播报都用它。 */
  text: string;
}

export interface TripPlanReview {
  reviewId: string;
  planId: string;
  /** ISO 时间戳。 */
  reviewedAt: string;
  days: TripReviewDay[];
  route?: TripReviewRoute;
  changes: TripReviewChange[];
  severity: TripReviewSeverity;
  /** 用户点过「知道了」的时刻；缺省 = 还没看过。 */
  ackedAt?: string;
}

/** 主页列表的一项：整份快照（切换选中行程要它）+ 最新一份核查。 */
export interface TripPlanListEntry {
  planId: string;
  plan: TripPlanSnapshot;
  committedAt: string;
  /** 行程最后一次被 `trip_plan_update` 改写的时刻——核查早于它就作废。 */
  updatedAt: string;
  review?: TripPlanReview;
}

// ── 判据常量（全部是代码常量，单测逐条打边界）───────────────────

/** 路线时长多出这么多分钟**且**超过 NOTICE_DURATION_RATIO → notice。 */
export const NOTICE_DURATION_MIN = 30;
export const NOTICE_DURATION_RATIO = 0.25;
export const CRITICAL_DURATION_MIN = 60;
export const CRITICAL_DURATION_RATIO = 0.5;
/** 签名里时长取整到 10 分钟、里程取整到 5 km——比这更细的抖动不构成"变化"。 */
export const SIGNATURE_DURATION_STEP_MIN = 10;
export const SIGNATURE_DISTANCE_STEP_KM = 5;

/** 干 / 湿两组；跨组才算天气变了，组内（晴 ↔ 多云）不算。haze 单独一档：出现即 notice。 */
const DRY: ReadonlySet<WeatherKind> = new Set(["sunny", "cloudy", "overcast"]);
const WET: ReadonlySet<WeatherKind> = new Set(["rain", "snow"]);

/** 预警标题里命中任一 → critical；否则新增预警只是 notice。 */
export const CRITICAL_ALARM_PATTERN = /暴雨|台风|暴雪|大雾|橙色|红色/;

// ── 签名 ──────────────────────────────────────────────────────

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

function alarmKey(alarms: readonly string[] | undefined): string {
  return [...new Set(alarms ?? [])].sort().join(",");
}

/**
 * 逐日 `kind|预警` + 路线 `时长|里程`。`unavailable` 的天记 `-`，与"晴"区分——
 * 拿不到预报的那天在签名上也不能冒充任何一种天气。
 */
export function reviewSignature(
  days: readonly TripReviewDay[],
  route: TripReviewRoute | undefined,
): string {
  const dayPart = days
    .map((d) => (d.unavailable || !d.kind ? "-" : `${d.kind}|${alarmKey(d.alarms)}`))
    .join(";");
  const routePart = route
    ? `${roundTo(route.durationMin, SIGNATURE_DURATION_STEP_MIN)}|${roundTo(route.distanceKm, SIGNATURE_DISTANCE_STEP_KM)}`
    : "-";
  return `${dayPart}#${routePart}`;
}

// ── 比对与分级 ────────────────────────────────────────────────

export interface ReviewComparable {
  days: readonly TripReviewDay[];
  route?: TripReviewRoute;
}

function kindLabel(d: TripReviewDay): string {
  return d.label ?? d.kind ?? "未知";
}

function weatherChangeSeverity(before: WeatherKind, after: WeatherKind): TripReviewChange["severity"] | undefined {
  if (before === after) return undefined;
  if (after === "haze" && before !== "haze") return "notice";
  const crossed = (DRY.has(before) && WET.has(after)) || (WET.has(before) && DRY.has(after));
  return crossed ? "notice" : undefined;
}

/**
 * 比出**该打扰车主**的变化。上一份缺省（首份核查）→ 空数组。
 *
 * 只比两份都拿得到的量：任一侧 `unavailable` 的天不比（"昨天没查到、今天查到了"不是天气变了），
 * 路线只在两份都有时比，且只记**变慢**——路上少开半小时没有人需要被提醒。
 */
export function diffReviews(
  prev: ReviewComparable | undefined,
  next: ReviewComparable,
): TripReviewChange[] {
  if (!prev) return [];
  const out: TripReviewChange[] = [];

  const prevByDay = new Map(prev.days.map((d) => [d.day, d]));
  for (const after of next.days) {
    const before = prevByDay.get(after.day);
    if (!before || before.unavailable || after.unavailable) continue;

    if (before.kind && after.kind) {
      const sev = weatherChangeSeverity(before.kind, after.kind);
      if (sev) {
        out.push({
          kind: "weather",
          day: after.day,
          before: kindLabel(before),
          after: kindLabel(after),
          severity: sev,
          text: `第 ${after.day} 天：${kindLabel(before)} → ${kindLabel(after)}`,
        });
      }
    }

    const known = new Set(before.alarms ?? []);
    for (const title of new Set(after.alarms ?? [])) {
      if (known.has(title)) continue;
      const sev = CRITICAL_ALARM_PATTERN.test(title) ? "critical" : "notice";
      out.push({
        kind: "alarm",
        day: after.day,
        before: "无预警",
        after: title,
        severity: sev,
        text: `第 ${after.day} 天：新增${title}`,
      });
    }
  }

  if (prev.route && next.route && prev.route.day === next.route.day) {
    const delta = next.route.durationMin - prev.route.durationMin;
    const ratio = prev.route.durationMin > 0 ? delta / prev.route.durationMin : 0;
    let sev: TripReviewChange["severity"] | undefined;
    if (delta >= CRITICAL_DURATION_MIN && ratio >= CRITICAL_DURATION_RATIO) sev = "critical";
    else if (delta >= NOTICE_DURATION_MIN && ratio >= NOTICE_DURATION_RATIO) sev = "notice";
    if (sev) {
      out.push({
        kind: "route",
        day: next.route.day,
        before: `${Math.round(prev.route.durationMin)} 分钟`,
        after: `${Math.round(next.route.durationMin)} 分钟`,
        severity: sev,
        text: `第 ${next.route.day} 天出发路线：${Math.round(prev.route.durationMin)} → ${Math.round(next.route.durationMin)} 分钟`,
      });
    }
  }

  return out;
}

export function severityOf(changes: readonly TripReviewChange[]): TripReviewSeverity {
  if (changes.some((c) => c.severity === "critical")) return "critical";
  if (changes.length > 0) return "notice";
  return "none";
}

/** 标志位：有变化且还没看过。 */
export function reviewNeedsAttention(review: Pick<TripPlanReview, "changes" | "ackedAt">): boolean {
  return review.changes.length > 0 && !review.ackedAt;
}

/**
 * 行程在核查之后又被 `trip_plan_update` 改过 → 这份核查说的不是这一版，不展示。
 * 时间戳解析不了按**作废**处理：拿不准的时候宁可少打一次扰。
 */
export function reviewIsStale(
  review: Pick<TripPlanReview, "reviewedAt">,
  planUpdatedAtIso: string | undefined,
): boolean {
  if (!planUpdatedAtIso) return false;
  const reviewed = Date.parse(review.reviewedAt);
  const updated = Date.parse(planUpdatedAtIso);
  if (Number.isNaN(reviewed) || Number.isNaN(updated)) return true;
  return reviewed < updated;
}

// ── 逐日代表点与下一出行日（M72-02 用；端上列表卡也按同一口径取点）─────────

export interface TripReviewPoint {
  name: string;
  lat: number;
  lon: number;
}

/**
 * 第 d 天的代表点：当天第一个带坐标的景点，没有则当天酒店，再没有则**沿用前一天的**
 * （住同一城市，天气一样）。全程都没有坐标 → undefined，调用方记 `unavailable`，不猜。
 */
export function dayRepresentative(plan: TripPlanSnapshot, day: number): TripReviewPoint | undefined {
  for (let d = day; d >= 1; d -= 1) {
    const found = plan.skeleton.find((x) => x.day === d) ?? plan.skeleton[d - 1];
    if (!found) continue;
    const spot = found.spots.find((s) => s.lat !== undefined && s.lon !== undefined);
    if (spot) return { name: spot.name, lat: spot.lat!, lon: spot.lon! };
    const h = found.hotel;
    if (h && h.lat !== undefined && h.lon !== undefined) return { name: h.name, lat: h.lat, lon: h.lon };
  }
  return undefined;
}

/** `YYYY-MM-DD` 加 n 天；只做日期串运算，不碰时区。 */
export function addDaysIso(dateIso: string, n: number): string {
  const t = Date.parse(`${dateIso}T00:00:00Z`);
  // 解析不了原样返回：下游按「日期待定」处理（`relativeDepartLabel`），不在这里抛。
  if (Number.isNaN(t)) return dateIso;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 没定日期的行程**默认明天出发**（2026-09-08 产品口径，M75-03）：多天行程从明天逐日往后推。
 *
 * 这是一个**随今天移动的默认值**，不是日期——`trip_plans.startDate` 仍为空，用户定了日期就覆盖它。
 * 所有"这一程第 d 天是哪天"的判断都从这里出，端上与 worker 不各自猜：
 * 天气核查按明天起取预报、周日历把它画成明天起的色块、相对时间说「明天出发」。
 * 反面是**确认那一刻算的整程天气**：它是按确认那天的"明天"算的，第二天就不再是这一程的第 1 天，
 * 所以列表卡对没定日期的行程不拿它兜底（见 `TripListCard.dayCells`）。
 */
export const DEFAULT_DEPART_OFFSET_DAYS = 1;

/** 生效出发日：定了日期用日期；没定 → 今天 + `DEFAULT_DEPART_OFFSET_DAYS`。 */
export function effectiveStartDate(plan: Pick<TripPlanSnapshot, "startDate">, todayIso: string): string {
  return plan.startDate || addDaysIso(todayIso, DEFAULT_DEPART_OFFSET_DAYS);
}

/** 第 d 天的日期 = 生效出发日 + d - 1（没定日期按默认明天起算）。 */
export function tripDayDate(plan: Pick<TripPlanSnapshot, "startDate">, day: number, todayIso: string): string {
  return addDaysIso(effectiveStartDate(plan, todayIso), day - 1);
}

/**
 * 下一出行日（1 起）：还没出发 → 第 1 天；行程中 → 明天那一天（若仍在行程内）；
 * 已到最后一天 / 已结束 → undefined（不算路）。没定日期按默认明天出发 → 永远是第 1 天。
 */
export function nextTravelDay(plan: TripPlanSnapshot, todayIso: string): number | undefined {
  if (todayIso < effectiveStartDate(plan, todayIso)) return 1;
  const idx = tripDayIndex(plan, todayIso);
  if (idx === null) return undefined;
  const next = idx + 2;
  return next <= plan.days ? next : undefined;
}

// ── 「让暖暖调整」的文本形状（M72-04 端上发、M72-05 服务端解析；两处只能有一份）──

/**
 * 端上替车主发进会话的那句话的固定开头。服务端在没有会话内草案时按它抓 planId、
 * 把已确认行程装进图状态再走既有的粘性细化（与「出发」的无草案段同形态）。
 */
export const ADJUST_PREFIX = "调整行程";

/** 抓 `调整行程 <planId>：` 里的 planId；不是这个形状 → undefined。 */
export function adjustPlanIdOf(text: string): string | undefined {
  const m = new RegExp(`^\\s*${ADJUST_PREFIX}\\s+([A-Za-z0-9_-]{8,})\\s*[:：]`).exec(text);
  return m?.[1];
}

/**
 * 一句结构化的话：`调整行程 <planId>：第 2 天：多云 → 雷阵雨；第 2 天：新增暴雨橙色预警。请按这些变化调整行程，其它不动。`
 * 变化文案直接用 `TripReviewChange.text`——弹层上给人看的与发给模型的是同一份。
 */
export function adjustPrompt(planId: string, changes: readonly TripReviewChange[]): string {
  const body = changes.map((c) => c.text).join("；");
  return `${ADJUST_PREFIX} ${planId}：${body || "行程环境有变化"}。请按这些变化调整行程，其它不动。`;
}

// ── 周日历与相对时间（M73-01）：主页列表卡的口径，端上不自己算 ──────────────

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** `2026-09-20` → 「周六」。按 UTC 解析日期串（与 `addDaysIso` 同口径），不受进程时区影响。 */
export function weekdayLabel(dateIso: string): string {
  const t = Date.parse(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(t)) return "";
  return WEEKDAY_LABELS[new Date(t).getUTCDay()]!;
}

/** 含今天的那一周，**周一起** 7 个日期串。周日当今天时是它前面 6 天 + 它自己。 */
export function weekOf(todayIso: string): string[] {
  const t = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(t)) return [];
  const dow = new Date(t).getUTCDay(); // 0 = 周日
  const offsetToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = addDaysIso(todayIso, offsetToMonday);
  return Array.from({ length: 7 }, (_, i) => addDaysIso(monday, i));
}

/**
 * 起止日。结束日 = 出发日 + 天数 - 1（与仓储 `endDateOf` 同口径）。
 * 没定日期按默认明天起算（所以必须给 `todayIso`）；`tentative` 标出这是默认值不是用户定的日期，
 * 展示层据此画成待定形态（虚线色块 / 「待定」标签），排序与落库都不拿它当真日期。
 */
export function tripDateRange(
  plan: Pick<TripPlanSnapshot, "startDate" | "days">,
  todayIso: string,
): { start: string; end: string; tentative: boolean } {
  const start = effectiveStartDate(plan, todayIso);
  return { start, end: addDaysIso(start, Math.max(1, plan.days) - 1), tentative: !plan.startDate };
}

/**
 * 「进行中 · 第 N 天」「今天出发」「明天出发」「N 天后出发」「已结束」；日期解析不了才是「日期待定」。
 * 没定日期的行程按默认口径恒为「明天出发」。车上的人想的是"还有几天"，不是"几号"；日期本身另给。
 */
export function relativeDepartLabel(plan: Pick<TripPlanSnapshot, "startDate" | "days">, todayIso: string): string {
  const range = tripDateRange(plan, todayIso);
  const diff = Math.round((Date.parse(`${range.start}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
  if (Number.isNaN(diff)) return "日期待定";
  if (diff > 1) return `${diff} 天后出发`;
  if (diff === 1) return "明天出发";
  if (diff === 0) return "今天出发";
  const dayIndex = -diff;
  if (dayIndex < Math.max(1, plan.days)) return `进行中 · 第 ${dayIndex + 1} 天`;
  return "已结束";
}
