/**
 * ⑥用车数据的聚合摘要（施工单 M7-02，§7⑥ 两段式的第二段）。
 *
 * # 为什么是两段式
 *
 * 原始流水（PG/TimescaleDB）不衰减、永久保留，供售后详细分析；
 * 聚合摘要（Mem0 `usage_pattern`）供**对话期低成本检索**——
 * 每次问"我这车冬天续航正常吗"都去扫时序表是不可接受的。
 *
 * # 摘要必须可解释
 *
 * §6 的双路检索靠它给出"这位车主上周在 -5℃ 下实际续航从 400 降到 320"这种话。
 * 每个数字都要能追溯到它由哪段流水算出（F-22-06），否则罗启明问
 * "这个数是真的还是编的"就答不上来。
 *
 * # stale 是可用性标记，不是排序权重
 *
 * `staleDays` 与 `decay.ts` 的半衰期**是两件事**：衰减影响排序，
 * stale 影响"能不能用"。混在一起会出现"排序靠后但仍被当成个性化依据"的情况
 * （F-22-08~10 的降级链条要的正是后者）。
 */

/** 一条行程流水（⑥的原始形态，§7⑥ 列举的五类字段）。 */
export interface TripRecord {
  startedAt: number;
  endedAt: number;
  distanceKm: number;
  /** 途经路况类型。 */
  roadType?: "city" | "highway" | "mixed";
  /** 行程环境温度（℃）。 */
  ambientTempC?: number;
  /** 充电起止 SOC 与时段。 */
  charge?: { startSoc: number; endSoc: number; at: number };
  /** 本次行程的实际续航表现（km，满电折算）。 */
  observedRangeKm?: number;
}

export interface UsageSummary {
  /** 统计窗口（天）。 */
  windowDays: number;
  /** 近窗口内日均里程。 */
  avgDailyKm: number;
  /** 常用充电时段（0-23 小时）。 */
  commonChargeHours: number[];
  /** 最常见路况。 */
  dominantRoadType?: TripRecord["roadType"];
  /** 低温（≤5℃）下的平均续航表现，无样本则 undefined——**不猜**。 */
  lowTempRangeKm?: number;
  /** 常温（>15℃）下的平均续航，作为低温对比基线。 */
  mildTempRangeKm?: number;
  /** 参与统计的行程数——**样本量要能被看到**，3 条和 300 条的结论可信度天差地别。 */
  sampleSize: number;
  /** 距最后一条流水的天数；下游据此判断能不能用（F-22-09）。 */
  staleDays: number;
  /** 每个数字由哪些字段算出——可解释性的落点（F-22-06）。 */
  derivation: string[];
}

const DAY_MS = 86_400_000;
const LOW_TEMP_C = 5;
const MILD_TEMP_C = 15;

function mean(xs: number[]): number | undefined {
  return xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * 从原始流水聚合出画像。
 *
 * `now` 显式传入而不是取当前时间：聚合任务要可重跑且结果一致（F-22-04 幂等）。
 */
export function aggregate(records: readonly TripRecord[], now: number, windowDays = 30): UsageSummary {
  const from = now - windowDays * DAY_MS;
  const inWindow = records.filter((r) => r.endedAt >= from && r.endedAt <= now);

  const totalKm = inWindow.reduce((a, r) => a + r.distanceKm, 0);
  const avgDailyKm = windowDays === 0 ? 0 : totalKm / windowDays;

  const chargeHours = inWindow
    .map((r) => r.charge?.at)
    .filter((x): x is number => typeof x === "number")
    .map((at) => new Date(at).getHours());
  const hourCounts = new Map<number, number>();
  for (const h of chargeHours) hourCounts.set(h, (hourCounts.get(h) ?? 0) + 1);
  const commonChargeHours = [...hourCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h]) => h)
    .sort((a, b) => a - b);

  const roadCounts = new Map<string, number>();
  for (const r of inWindow) if (r.roadType) roadCounts.set(r.roadType, (roadCounts.get(r.roadType) ?? 0) + 1);
  const dominantRoadType = [...roadCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as
    | TripRecord["roadType"]
    | undefined;

  const lowTemp = inWindow.filter(
    (r) => r.ambientTempC !== undefined && r.ambientTempC <= LOW_TEMP_C && r.observedRangeKm !== undefined,
  );
  const mildTemp = inWindow.filter(
    (r) => r.ambientTempC !== undefined && r.ambientTempC > MILD_TEMP_C && r.observedRangeKm !== undefined,
  );

  const lastAt = records.reduce((a, r) => Math.max(a, r.endedAt), 0);
  const staleDays = lastAt === 0 ? Number.POSITIVE_INFINITY : Math.max(0, (now - lastAt) / DAY_MS);

  const derivation = [
    `日均里程 = 窗口内总里程 ${totalKm.toFixed(1)}km ÷ ${windowDays} 天`,
    `样本量 = 窗口内 ${inWindow.length} 条行程`,
    lowTemp.length
      ? `低温续航 = ${lowTemp.length} 条 ≤${LOW_TEMP_C}℃ 行程的实测续航均值`
      : `低温续航：窗口内无 ≤${LOW_TEMP_C}℃ 的样本，**不给数值**`,
  ];

  return {
    windowDays,
    avgDailyKm,
    commonChargeHours,
    dominantRoadType,
    lowTempRangeKm: mean(lowTemp.map((r) => r.observedRangeKm!)),
    mildTempRangeKm: mean(mildTemp.map((r) => r.observedRangeKm!)),
    sampleSize: inWindow.length,
    staleDays,
    derivation,
  };
}

/** 画像是否足以支撑个性化结论（F-22-08~10 的降级判据）。 */
export interface UsabilityVerdict {
  usable: boolean;
  reason?: string;
}

export const MIN_SAMPLE = 5;
export const MAX_STALE_DAYS = 14;

/**
 * **宁可退化为通用回答，也不能用过期或不足的数据冒充个性化**（F-22-08 原文）。
 *
 * 这条比"没有个性化"更重要：一个基于三个月前数据的"你的续航正常"
 * 会让用户在真出问题时也以为正常。
 */
export function assessUsability(s: UsageSummary): UsabilityVerdict {
  // 判定顺序即措辞优先级，**不是随手排的**：
  //
  // 有 10 条上个月的流水时，窗口内样本量是 0。先判样本量会说"样本不足（0 条）"——
  // 这句话是错的（用户明明开过），而且不可行动（他不知道该做什么）。
  // 先判过期则会说"最后一条在 40 天前"，既属实又指向真正的原因。
  //
  // `staleDays` 由**全部**传入流水算出（不是窗口内），所以它能区分
  // "从来没有数据"（Infinity）与"有但旧了"（有限值）。
  if (!Number.isFinite(s.staleDays)) {
    return { usable: false, reason: "还没有任何用车流水" };
  }
  if (s.staleDays > MAX_STALE_DAYS) {
    return {
      usable: false,
      reason: `数据已过期（最后一条流水在 ${Math.round(s.staleDays)} 天前，上限 ${MAX_STALE_DAYS} 天）`,
    };
  }
  if (s.sampleSize < MIN_SAMPLE) {
    return { usable: false, reason: `样本不足（${s.sampleSize} 条，需要至少 ${MIN_SAMPLE} 条）` };
  }
  return { usable: true };
}

// ── 乘车人（施工单 M17-02，F-46-06）────────────────────────────

/**
 * 同行画像。
 *
 * **刻意比 `UsageSummary` 少**：乘客没有日均里程可言，也没有充电时段。
 * 为了字段齐全而给乘客算里程，等于把驾驶人的口径套在一个没开车的人身上——
 * 那个数字会被下游当成"她开了多少"。
 */
export interface CompanionSummary {
  windowDays: number;
  /** 窗口内同行的趟数。 */
  sampleSize: number;
  /** 常见同行时段（0-23 小时，取出发时刻的前 3 个高频值）。 */
  commonHours: number[];
  /** 距最后一次同行的天数。 */
  staleDays: number;
  derivation: string[];
}

/** 从流水聚合同行画像。`now` 显式传入，与 `aggregate` 同一条（可重跑且结果一致）。 */
export function aggregateCompanion(
  records: readonly TripRecord[],
  now: number,
  windowDays = 30,
): CompanionSummary {
  const from = now - windowDays * DAY_MS;
  const inWindow = records.filter((r) => r.endedAt >= from && r.endedAt <= now);

  const hourCounts = new Map<number, number>();
  for (const r of inWindow) {
    const h = new Date(r.startedAt).getHours();
    hourCounts.set(h, (hourCounts.get(h) ?? 0) + 1);
  }
  const commonHours = [...hourCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h]) => h)
    .sort((a, b) => a - b);

  const lastAt = records.reduce((a, r) => Math.max(a, r.endedAt), 0);
  const staleDays = lastAt === 0 ? Number.POSITIVE_INFINITY : Math.max(0, (now - lastAt) / DAY_MS);

  return {
    windowDays,
    sampleSize: inWindow.length,
    commonHours,
    staleDays,
    derivation: [`同行趟数 = 窗口内 ${inWindow.length} 条带该成员的行程`],
  };
}

/**
 * 同行画像的可用性。**复用 `assessUsability` 而不是抄一份阈值**——
 * 两处各写一个 5，改一次就会有一处忘改，而表现只是"某个人的画像莫名其妙可用了"。
 */
export function assessCompanionUsability(s: CompanionSummary): UsabilityVerdict {
  return assessUsability({
    windowDays: s.windowDays,
    avgDailyKm: 0,
    commonChargeHours: [],
    sampleSize: s.sampleSize,
    staleDays: s.staleDays,
    derivation: s.derivation,
  });
}
