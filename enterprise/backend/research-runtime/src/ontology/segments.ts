/**
 * 行为分群（施工单 M82-05，Brief 分群图谱 §3⑧ 三步）。
 *
 * # 先行为、后语义，顺序不能反
 *
 * 按**话语**聚出来的群是"说同一类话的人"，那多半只是复述了我们的码表。
 * 按行为聚出来的群才可能是我们还不知道的分法——命名与解释是聚完之后的事。
 *
 * # 没有可区分外部变量的群只能是 draft
 *
 * k-means 给任何数据都会返回 k 个簇，包括纯噪声。判断"这个分法是不是真的"
 * 唯一的办法是看它在**没参与聚类的变量**上是否也不一样（提醒接受率、行程确认转化）。
 * 差得不够或样本不够 → `draft`，不是 `validated`。
 *
 * # k 固定为 5
 *
 * POC 口径，写进快照。不做肘部法：车队规模下肘部图基本是一条直线，
 * 选出来的 k 更多反映随机种子而不是数据结构——那比固定一个数更不可辩护。
 */

import { DEFAULT_MIN_CELL_VEHICLES } from "@carlife/research";

/** 参与聚类的八个行为变量。**改这张表要升 `LENS_ALGO_VERSION`。** */
export const SEGMENT_FEATURES = [
  "avgDailyKm",
  "cityRatio",
  "longTripRatio",
  "socDeltaMean",
  "coldTripRatio",
  "coldRangeLoss",
  "memberCount",
  "voiceRatio",
] as const;

export type SegmentFeature = (typeof SEGMENT_FEATURES)[number];

export const SEGMENT_K = 5;

/** 一台车的行为画像。 */
export interface VehicleFeatures {
  vin: string;
  values: Record<SegmentFeature, number>;
}

/** 行为单元（一趟）的子集，聚合成车画像用。 */
export interface BehaviorRow {
  vin: string | null;
  distanceKm: number | null;
  roadType: string | null;
  ambientTempC: number | null;
  observedRangeKm: number | null;
  socDelta: number | null;
}

/** 话语侧的两个变量（语音占比、共用成员数）。 */
export interface UtteranceRow {
  vin: string | null;
  source: string | null;
}

/**
 * 按车聚合成八维画像。
 *
 * 缺测一律**折成 0 而不是跳过这台车**：跳过会让"数据少的车"整体消失，
 * 而它们恰恰是最该被看到的一类（新车、刚绑定的车）。0 的语义在
 * `coldRangeLoss` 这种比值上是"没观察到低温衰减"，可辩护。
 */
export function buildVehicleFeatures(
  trips: readonly BehaviorRow[],
  utterances: readonly UtteranceRow[],
  memberCounts: Readonly<Record<string, number>>,
  windowDays: number,
): VehicleFeatures[] {
  const byVin = new Map<string, BehaviorRow[]>();
  for (const t of trips) {
    if (!t.vin) continue;
    const list = byVin.get(t.vin) ?? [];
    list.push(t);
    byVin.set(t.vin, list);
  }

  const voiceByVin = new Map<string, { voice: number; total: number }>();
  for (const u of utterances) {
    if (!u.vin) continue;
    const v = voiceByVin.get(u.vin) ?? { voice: 0, total: 0 };
    v.total += 1;
    if (u.source === "voice") v.voice += 1;
    voiceByVin.set(u.vin, v);
  }

  const out: VehicleFeatures[] = [];
  for (const [vin, list] of byVin) {
    const km = list.reduce((n, t) => n + (t.distanceKm ?? 0), 0);
    const cold = list.filter((t) => t.ambientTempC !== null && t.ambientTempC < 5);
    const withRange = cold.filter((t) => t.observedRangeKm !== null && t.observedRangeKm > 0);
    const socs = list.map((t) => t.socDelta).filter((s): s is number => s !== null);
    const voice = voiceByVin.get(vin) ?? { voice: 0, total: 0 };

    out.push({
      vin,
      values: {
        avgDailyKm: windowDays === 0 ? 0 : km / windowDays,
        cityRatio: list.length === 0 ? 0 : list.filter((t) => t.roadType === "city").length / list.length,
        longTripRatio: list.length === 0 ? 0 : list.filter((t) => (t.distanceKm ?? 0) > 200).length / list.length,
        socDeltaMean: socs.length === 0 ? 0 : socs.reduce((a, b) => a + b, 0) / socs.length,
        coldTripRatio: list.length === 0 ? 0 : cold.length / list.length,
        // 观测续航相对满窗最大值的折减。缺低温样本时 0 = "没观察到"。
        coldRangeLoss:
          withRange.length === 0
            ? 0
            : 1 - withRange.reduce((n, t) => n + (t.observedRangeKm ?? 0), 0) / withRange.length / 500,
        memberCount: memberCounts[vin] ?? 0,
        voiceRatio: voice.total === 0 ? 0 : voice.voice / voice.total,
      },
    });
  }
  out.sort((a, b) => a.vin.localeCompare(b.vin));
  return out;
}

/** z-score 标准化。方差为 0 的维度全给 0——否则除零会把整列变成 NaN。 */
export function zScore(rows: readonly VehicleFeatures[]): number[][] {
  const n = rows.length;
  return rows.map((r) =>
    SEGMENT_FEATURES.map((f) => {
      const xs = rows.map((x) => x.values[f]);
      const mean = n === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / n;
      const sd = n === 0 ? 0 : Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
      return sd === 0 ? 0 : (r.values[f] - mean) / sd;
    }),
  );
}

export interface ClusterResult {
  /** 每台车属于哪个簇，与输入同序。 */
  assignments: number[];
  centroids: number[][];
}

/**
 * k-means（Lloyd），**固定初始化**：按等距抽样取初始质心，不用随机。
 *
 * 不引 `ml-kmeans`：这里只要 Lloyd 的十几行，而引一个包会带来
 * "同一份数据两次跑出不同分群"的风险——那个包默认随机初始化，
 * 而快照必须同输入同输出（`inputsHash` 那条不变量）。
 */
export function kmeans(points: readonly number[][], k: number, maxIter = 50): ClusterResult {
  if (points.length === 0) return { assignments: [], centroids: [] };
  const dims = points[0].length;
  const kk = Math.min(k, points.length);

  // 等距抽样做初始质心：确定性，且比取前 k 个更能铺开。
  const centroids = Array.from({ length: kk }, (_, i) => [
    ...points[Math.floor((i * points.length) / kk)],
  ]);
  let assignments = new Array<number>(points.length).fill(0);

  for (let iter = 0; iter < maxIter; iter += 1) {
    let moved = false;
    points.forEach((p, i) => {
      let best = 0;
      let bestD = Infinity;
      centroids.forEach((c, j) => {
        let d = 0;
        for (let x = 0; x < dims; x += 1) d += (p[x] - c[x]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      if (assignments[i] !== best) moved = true;
      assignments[i] = best;
    });

    for (let j = 0; j < kk; j += 1) {
      const members = points.filter((_, i) => assignments[i] === j);
      if (members.length === 0) continue; // 空簇保持原质心，不重随机
      for (let x = 0; x < dims; x += 1) {
        centroids[j][x] = members.reduce((a, m) => a + m[x], 0) / members.length;
      }
    }
    if (!moved) break;
  }

  return { assignments, centroids };
}

/** 外部验证的一项。 */
export interface ExternalMetric {
  metric: string;
  /** 该群的取值。 */
  value: number;
  /** 全体均值。 */
  overall: number;
  n: number;
}

/** 差 ≥ 0.1 且 n ≥ 10 才算验证通过（工单口径）。 */
export const EXTERNAL_DELTA_MIN = 0.1;

export function verdictOf(m: ExternalMetric | null, minN: number = DEFAULT_MIN_CELL_VEHICLES): "validated" | "insufficient" {
  if (!m) return "insufficient";
  return Math.abs(m.value - m.overall) >= EXTERNAL_DELTA_MIN && m.n >= minN ? "validated" : "insufficient";
}

/** 两个簇的相似度：质心的余弦相似度，画连线用。 */
export function centroidSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
