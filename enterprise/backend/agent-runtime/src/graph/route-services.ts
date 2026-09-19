/**
 * 沿途服务的取数点与确认后补算（行程详情「沿途服务」数据源交接，待执行事项 4）。
 *
 * # 与目的地推荐同一形态（`highlights.ts`）
 *
 * 一份三天行程按天查停靠点周边四类服务（餐饮 / 公厕 / 停车场 / 充电站，M93-04 起含最后一类），
 * 再加高速段的服务区，约 40~70 次高德请求，
 * 闸门下串行要十几秒。串进确认那一跳就是"说完确认之后卡十几秒才弹窗"，所以走
 * **确认后的后台补算 → 写回那一行**：确认那一跳照旧不等它，抽屉打开时读库里那份。
 *
 * # 四条约束怎么落（交接文档原文）
 *
 * 1. 直线半径内不等于可达 → **按天围绕已解析坐标的停靠点查**（景点 / 酒店），不沿折线均匀取样；
 *    高速段（出发地 → 第 1 天第一站）单独算路取样，只查服务区并**列名**。
 * 2. `200300` 含母婴室 → 工具侧剔掉（`route_services`），这里不再管。
 * 3. 偏远段返回空是真实结果 → 类目查成了就写数字（含 0），没查成才缺省（展示「待查」）。
 *    明细（`pois`，M93-04）与计数分账：计数说"周边有多少"，明细说"图上画哪些"，
 *    后者按距离升序截到 20 条，两者不等是正常形态。
 * 4. 请求预算 → 只在这里、只在后台、按天串行；一天没有坐标就整天不查（不编）。
 *
 * # 骨架指纹
 *
 * 结果带 `skeletonKey`（`tripServicesKey`）。改景点 / 换酒店后老的那份不作数——
 * 展示层比对不上就退回「待查」，后台按新骨架重算一遍；没动的那几天全部命中⑤缓存。
 */

import { MAX_POIS_PER_CATEGORY, tripDayIndex, tripServicesKey } from "@carlife/shared";
import type { ServicePoi, TripPlanDayServices, TripPlanServices, TripPlanSnapshot } from "@carlife/shared";
import { getAmapClient, invokeTool, type RouteServicesArgs, type RouteServicesResult, type ToolCallContext } from "@carlife/tools";

/** 高速段取样间距（km）。与 `probe:route-services` 同值：服务区之间本来就隔几十公里。 */
export const HIGHWAY_SAMPLE_EVERY_KM = 40;
/** 高速段最多取几个样点——超长线路也别把一次补算烧成上百次请求。 */
export const HIGHWAY_MAX_SAMPLES = 12;

export interface RouteServicesDeps {
  /** 查一批点周边的服务。缺省经 `invokeTool("route_services")`（它自带 mock 三态与⑤缓存）。 */
  query?: (args: RouteServicesArgs, ctx: ToolCallContext) => Promise<RouteServicesResult>;
  /**
   * 大交通高速段的取样点：`outbound` = 出发地 → 第 1 天第一站，`return` = 最后一天最后一站 → 出发地
   * （同一条高速两个方向的服务区不同，要分开算）。缺省用高德算路（地理编码 + 驾车规划）；
   * 返回 undefined = 没有出发地 / 算不出 / 不开车，这一项就缺省。
   */
  highwaySamples?: (
    plan: TripPlanSnapshot,
    point: { lat: number; lon: number },
    direction: HighwayDirection,
  ) => Promise<Array<{ lat: number; lon: number }> | undefined>;
  now?: () => Date;
}

export type HighwayDirection = "outbound" | "return";

const ctxFor = (sessionId: string): ToolCallContext => ({ sessionId, agent: "trip" });

const defaultQuery: RouteServicesDeps["query"] = async (args, ctx) => {
  const r = (await invokeTool("route_services", args, ctx)) as { data: RouteServicesResult };
  return r.data;
};

/** 当天所有带坐标的停靠点（景点 + 酒店），按名字去重。没有坐标的点**不查也不猜**。 */
export function dayPoints(plan: TripPlanSnapshot, day: number): Array<{ name: string; lat: number; lon: number }> {
  const d = plan.skeleton.find((x) => x.day === day);
  if (!d) return [];
  const out: Array<{ name: string; lat: number; lon: number }> = [];
  const seen = new Set<string>();
  const push = (name: string, lat?: number, lon?: number) => {
    if (lat === undefined || lon === undefined || seen.has(name)) return;
    seen.add(name);
    out.push({ name, lat, lon });
  };
  for (const s of d.spots) push(s.name, s.lat, s.lon);
  if (d.hotel) push(d.hotel.name, d.hotel.lat, d.hotel.lon);
  return out;
}

/** 大圆距离（km）——取样用，精度到一个 step 足够。 */
function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371 * Math.asin(Math.sqrt(h));
}

/** 沿折线每隔 `everyKm` 取一点（首点不取——那是出发地，市区里没有服务区）。 */
export function samplePolyline(points: ReadonlyArray<{ lat: number; lon: number }>, everyKm = HIGHWAY_SAMPLE_EVERY_KM, max = HIGHWAY_MAX_SAMPLES): Array<{ lat: number; lon: number }> {
  const out: Array<{ lat: number; lon: number }> = [];
  let acc = 0;
  for (let i = 1; i < points.length && out.length < max; i += 1) {
    acc += haversineKm(points[i - 1]!, points[i]!);
    if (acc >= everyKm) {
      out.push({ lat: points[i]!.lat, lon: points[i]!.lon });
      acc = 0;
    }
  }
  return out;
}

/** 这一程开不开车：大交通定了火车 / 飞机就没有高速段可言。 */
function drivesThere(plan: TripPlanSnapshot): boolean {
  const t = plan.transit?.recommended;
  return t !== "train" && t !== "flight";
}

/** 缺省的高速取样：出发地地理编码 → 驾车规划 → 沿折线取样。任一步失败返回 undefined（不猜）。 */
const defaultHighwaySamples: NonNullable<RouteServicesDeps["highwaySamples"]> = async (plan, point, direction) => {
  const origin = plan.origin?.trim();
  if (!origin || !drivesThere(plan)) return undefined;
  const amap = getAmapClient();
  if (!amap) return undefined;
  const home = await amap.geocode(origin);
  // 去程从家出发、返程回到家：两个方向各算一次路，服务区按行进方向不同。
  const path =
    direction === "outbound"
      ? await amap.driving({ origin: home, destination: point })
      : await amap.driving({ origin: point, destination: home });
  const polyline = path.steps.flatMap((s) => s.points);
  const samples = samplePolyline(polyline);
  return samples.length > 0 ? samples : undefined;
};

/** 类目结果 → 计数：一个点都没查成就缺省（待查），查成了就是条数（含 0）。 */
function countOf(r: { pois: unknown[]; queriedPoints: number } | undefined): number | undefined {
  if (!r || r.queriedPoints === 0) return undefined;
  return r.pois.length;
}

/** 本单要留明细的四类（服务区不在内：它只列名，不上图）。 */
const DETAIL_CATEGORIES = ["food", "restroom", "parking", "charging"] as const;
type DetailCategory = (typeof DETAIL_CATEGORIES)[number];

/**
 * 类目结果 → 上图用的明细：**按到当天任一停靠点的最近距离升序**，截断到
 * `MAX_POIS_PER_CATEGORY`，只留 `{name, lat, lon}`。
 *
 * 排序不是可有可无的：用户点开这一格是想知道"我住的地方附近有什么"，
 * 截掉的必须是远的那些。按高德的返回顺序截，截掉的是随机的那些。
 *
 * 查过了但一条都没有 → 返回 `undefined` 而不是空数组：计数已经把"有没有"说清楚了
 * （`food: 0`），明细只回答"画哪些"，多一个空数组只多一份歧义。
 */
function poisOf(
  r: { pois: Array<{ name: string; lat: number; lon: number }>; queriedPoints: number } | undefined,
  points: ReadonlyArray<{ lat: number; lon: number }>,
): ServicePoi[] | undefined {
  if (!r || r.queriedPoints === 0 || r.pois.length === 0) return undefined;
  const near = (p: { lat: number; lon: number }): number =>
    points.length === 0 ? 0 : Math.min(...points.map((pt) => haversineKm(pt, p)));
  return r.pois
    .map((p) => ({ p, km: near(p) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, MAX_POIS_PER_CATEGORY)
    .map(({ p }) => ({ name: p.name, lat: p.lat, lon: p.lon }));
}

/**
 * 算一次。**抛错就抛出去**——调用方（补算循环）负责记日志。
 * 返回 undefined = 这份行程一个能查的点都没有（全部没坐标），不写空对象冒充"查过了"。
 */
export async function collectRouteServices(
  plan: TripPlanSnapshot,
  deps: RouteServicesDeps = {},
  sessionId = "trip-services",
): Promise<TripPlanServices | undefined> {
  const query = deps.query ?? defaultQuery!;
  const highway = deps.highwaySamples ?? defaultHighwaySamples;
  const ctx = ctxFor(sessionId);
  const days: TripPlanDayServices[] = [];
  let radiusM: number | undefined;

  for (const d of [...plan.skeleton].sort((a, b) => a.day - b.day)) {
    const points = dayPoints(plan, d.day);
    if (points.length === 0) continue;
    // 按天串行（约束 4）：一天失败不影响别的天。
    try {
      const r = await query({ points }, ctx);
      radiusM = r.radiusM;
      const entry: TripPlanDayServices = { day: d.day };
      const pois: NonNullable<TripPlanDayServices["pois"]> = {};
      for (const cat of DETAIL_CATEGORIES) {
        const count = countOf(r[cat]);
        if (count !== undefined) entry[cat] = count;
        const detail = poisOf(r[cat], points);
        if (detail) pois[cat] = detail;
      }
      // 一类明细都没有就不写这个键——老快照与"这次一条都没查到"在端上是同一件事。
      if (Object.keys(pois).length > 0) entry.pois = pois;
      days.push(entry);
    } catch (err) {
      console.warn(`[route-services] 第 ${d.day} 天的沿途服务没查成（这一天保持待查）`, err);
    }
  }
  if (days.length === 0) return undefined;

  /*
   * 高速段的服务区：去程落第 1 天（出发地 → 第 1 天第一站），返程落最后一天（最后一天最后一站 → 出发地）。
   * 单天往返两段都落同一天，名字去重。多段大交通（中途换城）不算——那几段的两端都不是出发地。
   */
  const sorted = [...plan.skeleton].sort((a, b) => a.day - b.day);
  const firstDay = sorted[0];
  const lastDay = sorted[sorted.length - 1];
  const legs: Array<{ day: number; point: { lat: number; lon: number }; direction: HighwayDirection }> = [];
  const first = firstDay ? dayPoints(plan, firstDay.day)[0] : undefined;
  if (firstDay && first) legs.push({ day: firstDay.day, point: first, direction: "outbound" });
  const lastPoints = lastDay ? dayPoints(plan, lastDay.day) : [];
  const last = lastPoints[lastPoints.length - 1];
  if (lastDay && last) legs.push({ day: lastDay.day, point: last, direction: "return" });

  for (const leg of legs) {
    try {
      const samples = await highway(plan, leg.point, leg.direction);
      if (!samples || samples.length === 0) continue;
      const r = await query({ points: samples, categories: ["service_area"] }, ctx);
      if (!r.service_area || r.service_area.queriedPoints === 0) continue;
      const entry =
        days.find((x) => x.day === leg.day) ??
        (() => {
          const e: TripPlanDayServices = { day: leg.day };
          days.push(e);
          return e;
        })();
      const names = r.service_area.pois.map((p) => p.name);
      entry.serviceAreas = [...new Set([...(entry.serviceAreas ?? []), ...names])];
    } catch (err) {
      console.warn(`[route-services] ${leg.direction === "outbound" ? "去程" : "返程"}高速段服务区没算成（那一天不列服务区）`, err);
    }
  }

  return {
    computedAt: (deps.now ?? (() => new Date()))().toISOString(),
    radiusM: radiusM ?? 3_000,
    skeletonKey: tripServicesKey(plan),
    days: days.sort((a, b) => a.day - b.day),
  };
}

// ── 确认后的后台补算与回写（与 highlights.ts 同一形态）──────────────────────

/**
 * 行程变更时这一栏的去留：新快照自带且对得上骨架 → 用它；库里那份对得上 → 沿用；其余清掉。
 * 判据是 `skeletonKey`：改了景点或酒店，老的计数就不是这份行程的了——错的数比暂时没有糟。
 */
export function carryOverServices(prev: TripPlanSnapshot | undefined, next: TripPlanSnapshot): TripPlanSnapshot {
  const key = tripServicesKey(next);
  if (next.services?.skeletonKey === key) return next;
  const inherited = prev?.services;
  if (inherited?.skeletonKey === key) return { ...next, services: inherited };
  if (!next.services) return next;
  const { services: _drop, ...rest } = next;
  return rest;
}

/**
 * 补算要用到的仓储面。**只声明这两个方法**——不 import `@carlife/db`，单测给个假的即可。
 *
 * 读的那一半是 `confirmedById` 而**不是 `currentForUser`**（2026-09-18 排查）：见下面
 * `once()` 里那道核对。
 */
export interface ServicesPlanStore {
  confirmedById(userId: string, planId: string): Promise<{ planId: string; sessionId: string; plan: TripPlanSnapshot } | null>;
  update(userId: string, planId: string, sessionId: string, plan: TripPlanSnapshot): Promise<unknown>;
}

export interface ServicesBackfillTarget {
  userId: string;
  planId: string;
  sessionId: string;
  plan: TripPlanSnapshot;
}

export interface ServicesBackfill {
  /** 确认/变更之后调。**不返回 Promise**：主动作绝不等它。 */
  schedule(target: ServicesBackfillTarget): void;
  /** 等当前在跑的补算全部结束（测试与优雅退出用）。 */
  idle(): Promise<void>;
}

export interface ServicesBackfillOptions {
  /** 取数（测试注入）。 */
  collect?: (plan: TripPlanSnapshot) => Promise<TripPlanServices | undefined>;
  /** 今天（YYYY-MM-DD，测试注入）。 */
  today?: () => string;
}

/**
 * 行程确认/变更 → 后台算一次沿途服务 → 写回那一行。
 *
 * 三条取舍与目的地推荐逐字相同（`createHighlightsBackfill`）：fire-and-forget；写回前按
 * `planId` 重读那一行、它没了或骨架改了就整个丢弃；同一程只跑一个，在跑时记一次重跑。
 */
export function createServicesBackfill(store: ServicesPlanStore, opts: ServicesBackfillOptions = {}): ServicesBackfill {
  const collect = opts.collect ?? ((plan: TripPlanSnapshot) => collectRouteServices(plan));
  const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
  const running = new Map<string, boolean>();
  const waiters: Array<Promise<void>> = [];

  const once = async (t: ServicesBackfillTarget): Promise<void> => {
    if (tripDayIndex(t.plan, today()) === null) return; // 已经结束的行程不值得烧配额
    // 库里那份已经是按这版骨架算的 → 不重算（改出发日、改天气这类变更走到这里时很常见）。
    if (t.plan.services?.skeletonKey === tripServicesKey(t.plan)) return;
    const services = await collect(t.plan);
    if (!services) return; // 一个能查的点都没有——不写空对象冒充查过

    /*
     * 写回前重读**这一行**（`confirmedById`），不是"当前行程"（2026-09-18 排查）。
     *
     * 这里原来读 `currentForUser` 再比 `planId`，意思是"期间换了行程就丢弃"。
     * 但「当前行程」= 最新一条 confirmed，而车主能从列表里载入并变更任何一程（M72-05）——
     * 改的只要不是最新那一程，重读回来的必然是**另一份**，`planId` 必然对不上，
     * 于是查得好好的结果每次都被丢掉：真实库里那趟「湖州（南浔）＋嘉兴（桐乡）」
     * 三天全部查成、四格却一直是「待查」，而 `update` 不改 `committedAt`，
     * 它永远排不回第一名 —— 这条路对它是死的，且每改一次白烧几十次高德请求。
     *
     * 该核对的是"这一行还在不在、还是不是 confirmed"（取消了就别再写回），
     * 以及骨架有没有在这十几秒里变过。排第几与补算无关。
     */
    const cur = await store.confirmedById(t.userId, t.planId);
    if (!cur) return; // 期间被取消 / 不属于这个人 / 没有这一行
    if (services.skeletonKey !== tripServicesKey(cur.plan)) return; // 期间改了骨架，这份属于旧版本
    await store.update(t.userId, cur.planId, cur.sessionId, { ...cur.plan, services });
  };

  const loop = async (t: ServicesBackfillTarget): Promise<void> => {
    try {
      do {
        running.set(t.planId, false);
        try {
          await once(t);
        } catch (err) {
          console.warn("[route-services] 后台补算失败（这一程这次三格保持待查）", err);
        }
      } while (running.get(t.planId));
    } finally {
      running.delete(t.planId);
    }
  };

  return {
    schedule(t) {
      if (running.has(t.planId)) {
        running.set(t.planId, true);
        return;
      }
      const p = loop(t);
      waiters.push(p);
      void p.finally(() => {
        const i = waiters.indexOf(p);
        if (i >= 0) waiters.splice(i, 1);
      });
    },
    async idle() {
      while (waiters.length > 0) await Promise.allSettled([...waiters]);
    },
  };
}
