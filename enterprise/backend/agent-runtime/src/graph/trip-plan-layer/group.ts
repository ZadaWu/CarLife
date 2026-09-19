/**
 * 1b `planGroup`：把候选池按坐标分成 K = 天数个片区簇，配额裁剪，再把 `route_audit`
 * journey 层的建议**直接应用**（施工单 M86-02，ACR-037；设计定稿 §2.2）。
 *
 * # 为什么是代码，不是提示词
 *
 * "同一片区的点排同一天"此前只是 `tour.md` 里的一句希望：模型换代（INC-0134）之后它就不分了，
 * 09-12 起误归率 13~20%。这里把它变成代码保证的产物——从此分组的对错可以用
 * `evals/trip-clustering` 量，而不是看着顺眼。
 *
 * # 为什么自研而不用 ml-kmeans
 *
 * ACR-037 方案评估：要的是**带配额、确定性**的分组——到达 / 离开日半天配额、每天点数上限、
 * 同输入同输出（评测要可复现）。这三样都得在无约束 k-means 外面再写一层，而那一层就是
 * k-means 本身八成的代码。对象 ≤ 40 个点、K ≤ 7，引入依赖换不来任何算法收益。
 *
 * # 确定性
 *
 * 初始化用**最远点遍历**（第一个种子取候选池首位，即搜索相关度最高的点），不用随机；
 * 迭代上界 `PLAN_KMEANS_MAX_ROUNDS`；所有并列都取下标小的。同一份候选池两次调用逐字相同。
 *
 * # 三步各自纯函数
 *
 * `groupSpots`（聚类 + 配额）→ 调用方拿 `journeyArgsOf` 去调 `route_audit` →
 * `finishGroup`（应用 regroup / dayOrder / 天内顺序、按出发地定链的方向、到达 / 离开日半天配额、片区名）。
 * 拆开是为了 IO 在中间：本文件零 IO，单测直接打三个函数。
 */

import { haversineKm, type RouteAuditArgs, type RouteAuditResult } from "@carlife/tools";

import { PLAN_KMEANS_MAX_ROUNDS, PLAN_POOL_MAX, PLAN_POOL_PER_DAY, PLAN_SPOTS_HALF_DAY, PLAN_SPOTS_PER_DAY } from "./config";
import type { Coord, DayRole, PlanSpot, SkeletonDay } from "./types";

export function centroidOf(points: readonly Coord[]): Coord {
  if (points.length === 0) return { lat: 0, lon: 0 };
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
  };
}

/** 最远点遍历选种子：第一个取候选池首位，之后每次取"离已有种子最近距离最大"的点。 */
function farthestFirstSeeds(pool: readonly PlanSpot[], k: number): number[] {
  const seeds = [0];
  while (seeds.length < k) {
    let bestIdx = -1;
    let bestDist = -1;
    pool.forEach((p, i) => {
      if (seeds.includes(i)) return;
      const nearest = Math.min(...seeds.map((s) => haversineKm(p, pool[s]!)));
      if (nearest > bestDist) {
        bestDist = nearest;
        bestIdx = i;
      }
    });
    if (bestIdx < 0) break;
    seeds.push(bestIdx);
  }
  return seeds;
}

/**
 * 确定性 k-means。返回恰好 `k` 个簇（候选池不够时后面的为空），簇内成员保持候选池顺序
 * （候选池顺序 = 搜索相关度 = 配额裁剪时谁排进当天）。
 */
export function clusterSpots(pool: readonly PlanSpot[], k: number, maxRounds: number = PLAN_KMEANS_MAX_ROUNDS): PlanSpot[][] {
  const empty = (): PlanSpot[][] => Array.from({ length: k }, () => []);
  if (k <= 0) return [];
  if (pool.length === 0) return empty();
  const kEff = Math.min(k, pool.length);
  let centers: Coord[] = farthestFirstSeeds(pool, kEff).map((i) => ({ lat: pool[i]!.lat, lon: pool[i]!.lon }));
  let assignment: number[] = [];

  const assign = (): number[] =>
    pool.map((p) => {
      let best = 0;
      let bestD = Infinity;
      centers.forEach((c, j) => {
        const d = haversineKm(p, c);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      return best;
    });

  for (let round = 0; round < maxRounds; round += 1) {
    const next = assign();
    // 空簇：从最大的那个簇里挑离自己质心最远的点另立门户——否则 K 个天里会有一天空着而别的天挤着。
    for (let j = 0; j < kEff; j += 1) {
      if (next.includes(j)) continue;
      const sizes = Array.from({ length: kEff }, (_, c) => next.filter((a) => a === c).length);
      const biggest = sizes.indexOf(Math.max(...sizes));
      let farIdx = -1;
      let farD = -1;
      next.forEach((a, i) => {
        if (a !== biggest) return;
        const d = haversineKm(pool[i]!, centers[biggest]!);
        if (d > farD) {
          farD = d;
          farIdx = i;
        }
      });
      if (farIdx >= 0) next[farIdx] = j;
    }
    const stable = next.length === assignment.length && next.every((a, i) => a === assignment[i]);
    assignment = next;
    centers = Array.from({ length: kEff }, (_, j) => centroidOf(pool.filter((_, i) => assignment[i] === j)));
    if (stable) break;
  }

  const clusters = empty();
  pool.forEach((p, i) => clusters[assignment[i]!]!.push(p));
  return clusters;
}

/** 候选池截到聚类要看的规模：前 min(8K, 40) 个（候选池已按搜索相关度排好）。 */
export function trimPool(pool: readonly PlanSpot[], k: number): PlanSpot[] {
  return pool.slice(0, Math.min(PLAN_POOL_MAX, PLAN_POOL_PER_DAY * Math.max(1, k)));
}

/** 簇内成员 `district` 的众数；并列取先出现的；一个都没有就用兜底名。 */
export function areaNameOf(spots: readonly PlanSpot[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const s of spots) if (s.district) counts.set(s.district, (counts.get(s.district) ?? 0) + 1);
  let best: string | undefined;
  let bestN = 0;
  for (const [name, n] of counts) {
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  return best ?? fallback;
}

/**
 * 聚类 + 整天配额。**不定角色、不定顺序**——那两样要等 `route_audit` 的 journey 层与出发地
 * （`finishGroup`）。返回恰好 K 天，天号 1..K 只是临时编号。
 */
export function groupSpots(pool: readonly PlanSpot[], k: number, fallbackArea: string): SkeletonDay[] {
  const clusters = clusterSpots(trimPool(pool, k), k);
  return clusters.map((members, i) => {
    const spots = members.slice(0, PLAN_SPOTS_PER_DAY);
    const alternates = members.slice(PLAN_SPOTS_PER_DAY);
    return { day: i + 1, area: areaNameOf(members, fallbackArea), centroid: centroidOf(spots), roles: [], spots, alternates };
  });
}

/** 给 `route_audit` 的入参：全部天一起、每天当前排的点；空天不传（工具对空 days 抛错，对单点天照收）。 */
export function journeyArgsOf(days: readonly SkeletonDay[], city: string): RouteAuditArgs {
  return {
    city,
    days: days.filter((d) => d.spots.length > 0).map((d) => ({ day: d.day, points: d.spots.map((s) => ({ name: s.name, lat: s.lat, lon: s.lon })) })),
  };
}

function byNames(names: readonly string[], from: ReadonlyMap<string, PlanSpot>): PlanSpot[] {
  return names.map((n) => from.get(n)).filter((s): s is PlanSpot => s !== undefined);
}

/**
 * 直接应用 `route_audit` 的建议——不交给模型"参考"：
 *  1. `journey.regroup.days[].order`：重分组后各天的成员与天内最短顺序（只交换、每天点数不变）；
 *  2. 没被 regroup 覆盖的天，用 `days[].suggested.order` 排天内顺序；
 *  3. `journey.dayOrder.order`：天序。
 * 名字对不上的建议整条忽略（建议里只可能出现我们传进去的名字；对不上就是工具那边的 unresolved）。
 * `alternates` 跟着自己原来那天走。
 */
export function applyJourney(days: readonly SkeletonDay[], audit: RouteAuditResult | undefined): SkeletonDay[] {
  if (!audit) return days.map((d) => ({ ...d }));
  const known = new Map<string, PlanSpot>();
  for (const d of days) for (const s of d.spots) known.set(s.name, s);

  const out = days.map((d) => ({ ...d, spots: [...d.spots], alternates: [...d.alternates] }));
  const regrouped = new Set<number>();
  for (const rd of audit.journey?.regroup?.days ?? []) {
    if (rd.day === undefined) continue;
    const target = out.find((d) => d.day === rd.day);
    if (!target) continue;
    const members = byNames(rd.order, known);
    // 建议里的名字必须全部认得，且点数与原来相等（regroup 只交换）——否则整条不用。
    if (members.length !== rd.order.length || members.length !== target.spots.length) continue;
    target.spots = members;
    regrouped.add(rd.day);
  }
  for (const ad of audit.days) {
    if (ad.day === undefined || regrouped.has(ad.day) || !ad.suggested) continue;
    const target = out.find((d) => d.day === ad.day);
    if (!target) continue;
    const ordered = byNames(ad.suggested.order, new Map(target.spots.map((s) => [s.name, s])));
    if (ordered.length !== target.spots.length) continue;
    target.spots = ordered;
  }
  let ordered = out;
  const order = audit.journey?.dayOrder?.order;
  if (order && order.length === out.length && new Set(order).size === out.length) {
    const picked = order.map((dayNo) => out.find((d) => d.day === dayNo)).filter((d): d is SkeletonDay => d !== undefined);
    if (picked.length === out.length) ordered = picked;
  }
  return ordered.map((d, i) => ({ ...d, day: i + 1, centroid: centroidOf(d.spots) }));
}

/**
 * 链的方向由出发地定：离出发地近的一端是第 1 天（进城那天顺路）。
 * 没有出发地坐标就保持 dayOrder 给的方向；两端一样近也不动。
 */
export function orientByOrigin(days: readonly SkeletonDay[], origin: Coord | undefined): SkeletonDay[] {
  if (!origin || days.length < 2) return days.map((d) => ({ ...d }));
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const dFirst = haversineKm(origin, first.centroid);
  const dLast = haversineKm(origin, last.centroid);
  const list = dLast < dFirst ? [...days].reverse() : [...days];
  return list.map((d, i) => ({ ...d, day: i + 1 }));
}

/** 第 1 天到达、第 K 天离开（单天两者都是）；这两天只有半天，配额减到 2，多出来的挪到 alternates 最前。 */
export function assignRoles(days: readonly SkeletonDay[]): SkeletonDay[] {
  return days.map((d, i) => {
    const roles: DayRole[] = [];
    if (i === 0) roles.push("arrival");
    if (i === days.length - 1) roles.push("departure");
    if (roles.length === 0 || d.spots.length <= PLAN_SPOTS_HALF_DAY) return { ...d, roles };
    const spots = d.spots.slice(0, PLAN_SPOTS_HALF_DAY);
    const demoted = d.spots.slice(PLAN_SPOTS_HALF_DAY);
    return { ...d, roles, spots, alternates: [...demoted, ...d.alternates], centroid: centroidOf(spots) };
  });
}

/** `groupSpots` 之后、拿到 `route_audit` 结果之后的收尾：应用建议 → 定方向 → 定角色与半天配额。 */
export function finishGroup(days: readonly SkeletonDay[], opts: { audit?: RouteAuditResult; originCoord?: Coord } = {}): SkeletonDay[] {
  return assignRoles(orientByOrigin(applyJourney(days, opts.audit), opts.originCoord));
}
