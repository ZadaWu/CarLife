/**
 * 行程「天与天抱团 / 交叉」的评分纯函数（施工单 M86-01，ACR-037）。
 *
 * # 它回答什么
 *
 * 「这一份多天行程，每天的点是不是真的聚在一片、天与天之间分不分得开」——
 * **每个点离自己那天的质心近，还是离别的天的质心更近**。离别的天更近的点占比（误归率）
 * 就是"抱团 + 交叉"的直接度量。算法逐字来自探针 `scripts/dev/probe/tour-day-clustering.mts`
 * （2026-09-15 取证用的判据），探针现在 import 这里——**判据只有一份**。
 *
 * # 两个数必须一起看
 *
 * 把所有点塞进一天，误归率天然是 0——那不是"分好了"，是"没分"。所以每份评分同时带
 * 天内平均半径（每天紧不紧凑）与天间距（天与天分不分得开），`summarize` 也不许只返回一个数。
 *
 * # 零 IO
 *
 * 本文件不 import `@carlife/db` 与任何运行时模块：`test:infra` 用 `node --import tsx --test`
 * 加载 evals 下每个目录的 `.test.ts`，走 CJS 解析路径时那类 import 会红在「Cannot find module」上
 * （`evals/lib/auth.ts` 文件头记过同一坑）。数据从哪来是 `run.ts` 与探针各自的事。
 */

export interface Coord {
  lat: number;
  lon: number;
}

export interface DayGroup {
  day: number;
  points: readonly Coord[];
}

export interface ClusterScore {
  /** 有坐标、参与计算的点数。 */
  points: number;
  /** 离别的天质心更近的点数。 */
  misassigned: number;
  /** 点到自己那天质心的平均距离（km）——"每天是不是紧凑"。 */
  radiusKm: number;
  /** 天质心两两平均距离（km）——"天与天分不分得开"。 */
  separationKm: number;
  /** 每天参与计算的点数，按 `groups` 的顺序。 */
  perDay: number[];
}

/** 两点大圆距离（km）。直线估算，与 `route_audit` 同一口径。 */
export function distanceKm(a: Coord, b: Coord): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function centroid(points: readonly Coord[]): Coord {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
  return { lat, lon };
}

/**
 * 同一景区的两个门离两天质心几乎等距——差不到 50 m 不算误归，
 * 否则每一份含「灵隐寺 / 飞来峰」这类相邻点的行程都会被扣一个假分。
 */
const MISASSIGN_TOLERANCE_KM = 0.05;

/**
 * 一份逐天分组 → 一份评分。少于两天有点的组返回 undefined：没有"天与天"可言，
 * 宁可不报也不拿半份数据下结论（与探针同一取向）。
 */
export function scoreDayGroups(groups: readonly DayGroup[]): ClusterScore | undefined {
  const usable = groups.filter((g) => g.points.length > 0);
  if (usable.length < 2) return undefined;

  const centers = usable.map((g) => centroid(g.points));
  let total = 0;
  let misassigned = 0;
  let radiusSum = 0;
  usable.forEach((g, i) => {
    for (const p of g.points) {
      total += 1;
      const own = distanceKm(p, centers[i]!);
      radiusSum += own;
      let best = own;
      let bestIdx = i;
      centers.forEach((c, j) => {
        const d = distanceKm(p, c);
        if (d < best - MISASSIGN_TOLERANCE_KM) {
          best = d;
          bestIdx = j;
        }
      });
      if (bestIdx !== i) misassigned += 1;
    }
  });

  let sepSum = 0;
  let pairs = 0;
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = i + 1; j < centers.length; j += 1) {
      sepSum += distanceKm(centers[i]!, centers[j]!);
      pairs += 1;
    }
  }

  return {
    points: total,
    misassigned,
    radiusKm: radiusSum / total,
    separationKm: pairs > 0 ? sepSum / pairs : 0,
    perDay: usable.map((g) => g.points.length),
  };
}

/** `TripPlanSnapshot.skeleton` 的最小形状——只要天号与点的坐标，别的字段一概不读。 */
export interface SnapshotDay {
  day: number;
  spots: ReadonlyArray<{ lat?: number; lon?: number }>;
}

export interface Coverage {
  /** 带坐标、进了计算的点。 */
  withCoord: number;
  /** 骨架里全部的点。 */
  total: number;
}

/**
 * 从落库快照计分。没坐标的点只进 `total`——`off` 档下 `fillCoordsFromSearches` 只写过了
 * `trustCoordHit` 的点，覆盖率是这份分数可信不可信的前提，所以一并交出去。
 */
export function scoreSnapshot(skeleton: readonly SnapshotDay[]): { score?: ClusterScore; coverage: Coverage } {
  let total = 0;
  const groups: DayGroup[] = skeleton.map((d) => {
    total += d.spots.length;
    const points = d.spots
      .filter((s): s is { lat: number; lon: number } => typeof s.lat === "number" && typeof s.lon === "number")
      .map((s) => ({ lat: s.lat, lon: s.lon }));
    return { day: d.day, points };
  });
  const score = scoreDayGroups(groups);
  return { ...(score ? { score } : {}), coverage: { withCoord: score?.points ?? groups.reduce((n, g) => n + g.points.length, 0), total } };
}

export interface ScoredRow {
  id: string;
  score?: ClusterScore;
  coverage: Coverage;
}

/** 坐标覆盖率低于它的 case 不进合计：分母都不全的分数不该和别人相加。 */
export const MIN_COVERAGE = 0.6;

export interface Summary {
  /** 进了合计的 case id。 */
  counted: string[];
  /** 因没有分数或覆盖率不足被剔出合计的 case id。 */
  excluded: string[];
  points: number;
  misassigned: number;
  /** 0~100；没有可计的点时为 undefined。 */
  misassignedPct?: number;
  /** 进合计的 case 的平均值；没有时为 undefined。 */
  radiusKm?: number;
  separationKm?: number;
}

export function coverageRatio(c: Coverage): number {
  return c.total === 0 ? 0 : c.withCoord / c.total;
}

/**
 * 合计。误归率的分子分母各自相加（不是比率平均——一条 30 个点的 case 与一条 6 个点的
 * 不该同权）；半径与天间距按 case 平均（它们本来就是每份行程一个数）。
 */
export function summarize(rows: readonly ScoredRow[]): Summary {
  const counted = rows.filter((r) => r.score !== undefined && coverageRatio(r.coverage) >= MIN_COVERAGE);
  const excluded = rows.filter((r) => !counted.includes(r));
  const points = counted.reduce((n, r) => n + r.score!.points, 0);
  const misassigned = counted.reduce((n, r) => n + r.score!.misassigned, 0);
  const avg = (pick: (s: ClusterScore) => number): number | undefined =>
    counted.length ? counted.reduce((n, r) => n + pick(r.score!), 0) / counted.length : undefined;
  return {
    counted: counted.map((r) => r.id),
    excluded: excluded.map((r) => r.id),
    points,
    misassigned,
    ...(points > 0 ? { misassignedPct: (100 * misassigned) / points } : {}),
    ...(counted.length ? { radiusKm: avg((s) => s.radiusKm), separationKm: avg((s) => s.separationKm) } : {}),
  };
}
