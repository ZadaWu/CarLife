/**
 * 行程每日核查任务（施工单 M72-02，设计 内部文档）。
 *
 * 每天早上替车主看一眼每一程：逐日天气变没变、明天出发的路要多开多久。变了就落一份带分级的核查，
 * 主页 60 s 轮询顺带把它带回去。**只写 `trip_plan_reviews`，`trip_plans.plan` 一字不动**（M20-06 的纪律）。
 *
 * # 任务零 LLM
 *
 * AC-32-12：任务逻辑为确定性规则，不含 LLM 调用。`nav-plan` 是 LLM 分支（`subgraphs/nav-plan.ts`
 * 走 `runFanout` 的 `nav-task`），本任务不调它——「导航安排」只取 `map_route` 的确定性摘要
 * （里程 / 时长 / 过路费）。判据（签名 / 比对 / 分级）全部在 contracts 的纯函数里，这里只负责
 * "扫谁、查什么、写哪"，与 `vehicle-reminder.ts` 同一形态。
 *
 * # 同一天只写一行
 *
 * 核查是"今天看一眼"。漏跑补偿只补一个窗口（`maxCatchUpWindows = 1`——补三天前的没有意义），
 * 同一天重跑看到已有今天的核查就跳过，不插第二行。
 *
 * # 拿不到不算失败
 *
 * 无高德 key（算路缺省）、出发日超出预报窗口、行程没有坐标、没有常住地——都是**如实记"没有"**，
 * 不进 `failures`。只有供应商真的抛错才进 `failures`，且单份失败不影响其它行程。
 *
 * # 没定日期的行程按默认明天出发核查
 *
 * 口径在 contracts 的 `effectiveStartDate`（M75-03）：第 1 天 = 明天，逐日往后推，于是天气与出发路线都查得到。
 * 代价是这份核查的 `days[].date` 每天都往后挪一天——比对时（`diffReviews`）按 `day` 对齐不按 `date`，
 * 所以"第 2 天从多云变雷阵雨"仍是有意义的变化；只是它说的是"如果明天出发的话"。
 */

import {
  getPrisma,
  createOwnerProfileRepository,
  createTripPlanRepository,
  createTripPlanReviewRepository,
  type CommittedTripPlan,
  type StoredTripPlanReview,
  type TripPlanReviewInput,
} from "@carlife/db";
import {
  WEATHER_LABELS,
  dayRepresentative,
  diffReviews,
  nextTravelDay,
  reviewSignature,
  severityOf,
  tripDayDate,
  type TripPlanSnapshot,
  type TripReviewDay,
  type TripReviewPoint,
  type TripReviewRoute,
} from "@carlife/shared";
import {
  classifyWeatherKind,
  createAmapClient,
  createCmaClient,
  mapRouteTool,
  reduceSegments,
  setAmapClient,
  setCmaClient,
  weatherTool,
  type RouteSummary,
  type ToolCallContext,
  type WeatherSegment,
} from "@carlife/tools";

import type { JobContext, JobDefinition, JobResult } from "./job-runner";

const DAY_MS = 86_400_000;

/** 预报窗口：今天起 7 天（中国气象局），与 `weather.ts` 的 `CMA_FORECAST_DAYS` 同口径。超出的天不调工具。 */
export const FORECAST_HORIZON_DAYS = 7;
/** 行程间并发；每份行程内的工具调用串行。 */
export const REVIEW_CONCURRENCY = 4;
/** `activeAll` 到顶就该分页了——到顶时告警，不静默截断。 */
export const ACTIVE_PLANS_CAP = 500;

export interface ReviewDeps {
  /** 全部用户的活动行程（进行中 + 未来 + 未定日期）。 */
  plans(today: string): Promise<CommittedTripPlan[]>;
  /** 常住地；没有就是 undefined（不算路）。 */
  home(userId: string): Promise<TripReviewPoint | undefined>;
  /** 某一天某几个点的预报；供应商抛错就抛出来（进 failures）。 */
  weather(points: readonly TripReviewPoint[], date: string): Promise<WeatherSegment[]>;
  /** 起终点算路摘要；未接入 / 算不出 → undefined（不算失败）。 */
  route(origin: TripReviewPoint, destination: TripReviewPoint): Promise<RouteSummary | undefined>;
  latest(planId: string): Promise<StoredTripPlanReview | null>;
  insert(input: TripPlanReviewInput): Promise<unknown>;
  /** 本地今天（`YYYY-MM-DD`）。 */
  today(): string;
  /** 分页到顶等异常量级的告警出口。 */
  warn?(message: string): void;
}

/** 本地日期串（年-月-日）。与其它任务一致，口径是进程时区（容器 `TZ`）。 */
export function localToday(now = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/** ISO 时间戳落在本地哪一天。与 `localToday` 同一口径。 */
export function localDateOf(iso: string): string {
  return localToday(new Date(iso));
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

function uniqueAlarms(segments: readonly WeatherSegment[]): string[] {
  const titles = new Set<string>();
  for (const s of segments) for (const a of s.alarms ?? []) if (a.title) titles.add(a.title);
  return [...titles].sort();
}

/**
 * 逐日天气：只查预报窗口内、有代表点的天；其余如实记 `unavailable`。
 * 没定日期的按默认明天起算日期（`tripDayDate` 带 `today`）。
 * 供应商抛错**向上抛**——由调用方计进这份行程的失败，不在这里吞。
 */
export async function reviewDays(
  plan: TripPlanSnapshot,
  today: string,
  weather: ReviewDeps["weather"],
): Promise<TripReviewDay[]> {
  const out: TripReviewDay[] = [];
  for (let day = 1; day <= plan.days; day += 1) {
    const date = tripDayDate(plan, day, today);
    const point = dayRepresentative(plan, day);
    if (!point) {
      out.push({ day, date, unavailable: true });
      continue;
    }
    const offset = daysBetween(today, date);
    if (offset < 0 || offset >= FORECAST_HORIZON_DAYS) {
      out.push({ day, date, unavailable: true });
      continue;
    }
    const segments = await weather([point], date);
    const view = reduceSegments(segments);
    if (view.phenomena.length === 0 && view.maxTempC === undefined) {
      // 调通了但没有一个可用字段——供应商在这一天没给预报，不当成"晴"。
      out.push({ day, date, unavailable: true });
      continue;
    }
    const kind = classifyWeatherKind(view);
    out.push({
      day,
      date,
      kind,
      label: view.phenomena[0] ?? WEATHER_LABELS[kind],
      tempMinC: view.minTempC,
      tempMaxC: view.maxTempC,
      alarms: uniqueAlarms(segments),
    });
  }
  return out;
}

/** 下一出行日的出发路线：常住地 → 那天第一个带坐标的落点。任一端缺失 → undefined（不算路）。 */
export async function reviewRoute(
  plan: CommittedTripPlan,
  today: string,
  deps: Pick<ReviewDeps, "home" | "route">,
): Promise<TripReviewRoute | undefined> {
  const day = nextTravelDay(plan.plan, today);
  if (day === undefined) return undefined;
  const dest = dayRepresentative(plan.plan, day);
  if (!dest) return undefined;
  const origin = await deps.home(plan.userId);
  if (!origin) return undefined;
  const summary = await deps.route(origin, dest);
  if (!summary) return undefined;
  return {
    day,
    from: origin.name,
    to: dest.name,
    distanceKm: summary.distanceKm,
    durationMin: summary.durationMin,
    tollYuan: summary.tollYuan,
  };
}

async function reviewOne(plan: CommittedTripPlan, today: string, deps: ReviewDeps): Promise<"skipped" | "changed" | "recorded"> {
  const latest = await deps.latest(plan.planId);
  if (latest && localDateOf(latest.reviewedAt) === today) return "skipped";

  const days = await reviewDays(plan.plan, today, deps.weather);
  const route = await reviewRoute(plan, today, deps);
  const next = { days, route };
  const changes = diffReviews(latest ?? undefined, next);
  await deps.insert({
    planId: plan.planId,
    userId: plan.userId,
    signature: reviewSignature(days, route),
    days,
    route,
    changes,
    severity: severityOf(changes),
  });
  return changes.length > 0 ? "changed" : "recorded";
}

export async function runTripPlanReview(_ctx: JobContext, deps: ReviewDeps): Promise<JobResult> {
  const today = deps.today();
  const result: JobResult = { processed: 0, changed: 0, deleted: 0, failures: [] };
  const plans = await deps.plans(today);
  if (plans.length >= ACTIVE_PLANS_CAP) {
    deps.warn?.(`活动行程达到单次上限 ${ACTIVE_PLANS_CAP}，超出的这一轮没有核查——该分页了`);
  }

  // 行程间并发、行程内串行：一份行程的天气最多 7 跳，串起来不慢；行程之间互不相干。
  let cursor = 0;
  const workers = Array.from({ length: Math.min(REVIEW_CONCURRENCY, plans.length) }, async () => {
    while (cursor < plans.length) {
      const plan = plans[cursor]!;
      cursor += 1;
      result.processed += 1;
      try {
        const outcome = await reviewOne(plan, today, deps);
        if (outcome === "changed") result.changed += 1;
      } catch (err) {
        result.failures.push(`${plan.userId}/${plan.planId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  await Promise.all(workers);
  return result;
}

/** 工具上下文：没有 turnId——`map_route` 的候选记录器只在有 turnId 时写，本任务不该往按轮白名单里堆东西。 */
function toolCtx(): ToolCallContext {
  return {
    sessionId: "system:worker",
    agent: "trip",
    mode: (process.env.CARLIFE_TOOLS as ToolCallContext["mode"]) ?? "real",
  };
}

export function createReviewDeps(): ReviewDeps {
  const prisma = getPrisma();
  const plans = createTripPlanRepository(prisma);
  const reviews = createTripPlanReviewRepository(prisma);
  const owners = createOwnerProfileRepository(prisma);

  // 装配与 agent-runtime 同源（`index.ts` 那两行）：无 key 时天气走 Open-Meteo，算路缺省。
  const amapKey = process.env.AMAP_SERVER_KEY?.trim();
  setAmapClient(amapKey ? createAmapClient({ key: amapKey }) : undefined);
  const cmaOn = (process.env.CARLIFE_WEATHER_CMA ?? "on").trim() !== "off";
  setCmaClient(cmaOn ? createCmaClient() : undefined);

  return {
    plans: (today) => plans.activeAll(today, ACTIVE_PLANS_CAP),
    home: async (userId) => {
      const profile = await owners.currentForUser(userId);
      const h = profile.home;
      return h ? { name: h.city, lat: h.lat, lon: h.lon } : undefined;
    },
    weather: async (points, date) => (await weatherTool.call({ points: [...points], date }, toolCtx())).data,
    route: async (origin, destination) => {
      if (!amapKey && toolCtx().mode === "real") return undefined;
      try {
        const r = await mapRouteTool.call(
          { origin: { lat: origin.lat, lon: origin.lon, name: origin.name }, destination: { lat: destination.lat, lon: destination.lon, name: destination.name } },
          toolCtx(),
        );
        return r.data.summary;
      } catch (err) {
        // 算不出来记 warn 但不算失败：路线是"顺带看一眼"，天气那半仍然有效。
        console.warn(`[trip-plan-review] 算路失败（本次不比路线）：${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    },
    latest: (planId) => reviews.latestForPlan(planId),
    insert: (input) => reviews.insert(input),
    today: () => localToday(),
    warn: (m) => console.warn(`[trip-plan-review] ${m}`),
  };
}

export const tripPlanReviewJob: JobDefinition = {
  name: "trip-plan-review",
  intervalMs: 24 * 3_600_000,
  maxCatchUpWindows: 1,
  run: (ctx) => runTripPlanReview(ctx, createReviewDeps()),
};
