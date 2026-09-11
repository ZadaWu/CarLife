/**
 * 屏底状态栏的那一段路：出发地 → 今天第一站的**预计里程 / 预计用时 / 道路情况**（2026-09-11）。
 *
 * # 它回答的是"现在出发这一段怎么样"，不是"整程怎么样"
 *
 * 用户定的口径：出发地到第一个目的地，走高德驾车规划。整程里程是行程规划时算的另一回事
 * （`TripPlanSnapshot.legs`）。第一站由 `tripPlanNavTarget` 定——与出发卡、出发导航同一条规则，
 * 三处各算一份的话卡上导去 A、状态栏按 B 报里程。
 *
 * # 缓存放哪一层：⑤环境缓存（Redis TTL），**不是记忆**
 *
 * 分层记忆里它只可能是⑤：外部世界的事实，与谁在问无关（§7⑤，`env-cache.ts` 文件头）。
 * 键**不含 userId / planId**——同一段路对所有人是同一段，带用户维度既泄露隐私又让命中率归零。
 * 两级、两个 TTL，各自有依据：
 *
 *  1. 地名 → 坐标（`geocode`）：1 小时（表里除两条周级例外之外一律 ≤ 1 小时；60 秒一轮的轮询压到每小时一次就够）。
 *  2. 驾车规划（`leg`）：3 分钟，与 `map_route` 同一个数。实时路况是这一段的价值所在，
 *     缓存久了等于给过期路况，而过期路况带着"刚查的"可信度，比不缓存更糟。
 *     车机每 60 秒轮询一次 HUD，3 分钟里三次轮询只打一次高德——足够。
 *
 * 不进 Mem0（会跟着"访问强化"越查越不过期）、不进④（它不是这辆车的档案）、
 * 不进①（它不是某一轮对话的任务态）。
 *
 * # 拿不到就没有，不编
 *
 * 起点解析不出、第一站没坐标、高德没路、缓存与高德都不可用——一律返回 undefined，
 * 状态栏那三格显示「暂无」。**绝不回落到一个常数**：36 km / 4 h 30 min 这种数看起来和真的一模一样。
 * 路况只有当"未知"路段占比过半时才判读不到——那时说"畅通"是拿没数据冒充好消息。
 */

import { getAmapClient, type AmapPath, type AmapTmc, type LngLat } from "./amap";
import { ENV_TTL, envCacheKey, roundCoord, withEnvCache } from "./env-cache";

export interface TripLegInput {
  /** 出发地：地名（走地理编码）或坐标（车的当前位置 / 常住地）。 */
  origin: string | LngLat;
  /** 今天第一站的坐标（`tripPlanNavTarget`）。 */
  destination: LngLat;
}

export interface TripLegResult {
  distanceKm: number;
  durationMin: number;
  /** 缺席 = 路况读不到（未知路段占比过半 / 高德没给 tmcs）。 */
  road?: { label: string; status: RoadStatus };
  computedAt: string;
}

export type RoadStatus = "畅通" | "缓行" | "拥堵";

/**
 * 整条路的路况：按**里程加权**，不数段数。
 *
 * 高德一条路给几百段 tmc，长短从 30 米到几公里不等；数段数的话城里几百段短的畅通
 * 会把高速上一段十公里的拥堵平均掉。阈值：
 *  - 拥堵 + 严重拥堵 ≥ 10% 里程 → 拥堵（十公里里有一公里堵着，就得说）
 *  - 否则 缓行 ≥ 20% 里程 → 缓行
 *  - 否则 → 畅通
 *  - 未知 > 50% 里程，或一段 tmc 都没有 → undefined（读不到）
 *
 * `label` 只给「拥堵」用红——design-system.md §4 红色纪律：红只给「拥堵」和「读不到」。
 */
export function roadCondition(tmcs: readonly AmapTmc[]): RoadStatus | undefined {
  let total = 0;
  let jam = 0;
  let slow = 0;
  let unknown = 0;
  for (const t of tmcs) {
    if (!(t.distanceM > 0)) continue;
    total += t.distanceM;
    if (t.status === "拥堵" || t.status === "严重拥堵") jam += t.distanceM;
    else if (t.status === "缓行") slow += t.distanceM;
    else if (t.status !== "畅通") unknown += t.distanceM;
  }
  if (total === 0 || unknown / total > 0.5) return undefined;
  if (jam / total >= 0.1) return "拥堵";
  if (slow / total >= 0.2) return "缓行";
  return "畅通";
}

/**
 * 「高速 / 城区 / 混合」：按收费里程占比。高速几乎都收费、城区几乎都不收，
 * 这是高德回包里唯一能分出路型的字段——不按名字猜"XX高速"。
 *
 * 两个字，不是四个字：状态栏那一格 148px 宽（2048 基准），「高速为主 畅通」要 168px，
 * 尾巴钻到「开始行程」按钮底下（2026-09-11 iPad 模拟器实拍）。定稿画的是「城市道路 畅通」，
 * 但定稿那一格比实现宽——四格等宽是状态栏自己定的版式，字得迁就格。
 */
export function roadLabel(path: Pick<AmapPath, "distanceM" | "tollDistanceM">): string {
  if (!(path.distanceM > 0)) return "沿途";
  const share = path.tollDistanceM / path.distanceM;
  if (share >= 0.6) return "高速";
  if (share <= 0.2) return "城区";
  return "混合";
}

async function resolveOrigin(origin: string | LngLat, signal?: AbortSignal): Promise<LngLat | undefined> {
  if (typeof origin !== "string") return origin;
  const amap = getAmapClient();
  if (!amap) return undefined;
  const key = envCacheKey("geocode", [origin.trim()]);
  const { value } = await withEnvCache(key, ENV_TTL.geocode, async () => {
    const p = await amap.geocode(origin, undefined, signal);
    return { lat: p.lat, lon: p.lon };
  });
  return value;
}

/**
 * 算这一段。未接入高德 / 起点解析不出 / 规划失败 → undefined（调用方显示「暂无」）。
 * 这里不吞 AbortError 之外的错误：拿不到就是拿不到，但为什么拿不到要让日志看见。
 */
export async function computeTripLeg(input: TripLegInput, signal?: AbortSignal): Promise<TripLegResult | undefined> {
  const amap = getAmapClient();
  if (!amap) return undefined;
  const origin = await resolveOrigin(input.origin, signal);
  if (!origin) return undefined;
  const { destination } = input;

  // 键只含坐标（取整到 ~1km）——与 map_route 同一条纪律，且不带策略维（这里恒用高德推荐）。
  const key = envCacheKey("leg", [
    roundCoord(origin.lat),
    roundCoord(origin.lon),
    roundCoord(destination.lat),
    roundCoord(destination.lon),
  ]);
  /*
   * 缓存的是**算完的三个数**，不是高德的整条路。整条路带折线与几百段 tmc，
   * 一条 500 KB（2026-09-11 实测 Redis 里 `leg` 每条 497 KB）；状态栏只要里程、用时、路况，
   * 存下来不到 200 字节。`map_route` 缓整条路是因为它还要沿途取样与休息点，这里不需要。
   */
  const { value } = await withEnvCache(key, ENV_TTL.route, async () => {
    const path = await amap.driving({ origin, destination }, signal);
    return summarize(path);
  });
  return value ?? undefined;
}

/** 高德整条路 → 状态栏三格。`null` 表示高德回了但没有可用里程（缓存里也记 null，3 分钟内不再打）。 */
function summarize(path: AmapPath): TripLegResult | null {
  if (!(path.distanceM > 0)) return null;
  const status = roadCondition(path.steps.flatMap((s) => s.tmcs ?? []));
  return {
    distanceKm: Math.round(path.distanceM / 100) / 10,
    durationMin: Math.round(path.durationS / 60),
    ...(status ? { road: { label: roadLabel(path), status } } : {}),
    computedAt: new Date().toISOString(),
  };
}
