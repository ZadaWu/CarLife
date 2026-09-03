/**
 * 按类衰减的检索期 re-rank（施工单 M7-01，§7 自建薄封装第 2 件事）。
 *
 * # 为什么要自建
 *
 * **Mem0 OSS 没有内置 TTL/衰减**（§7 首段）。六类记忆的衰减策略差异很大：
 * ②情景半衰期 ~30d、③偏好 ~365d 且带访问强化、⑥聚合摘要 ~180d。
 * 一刀切的向量相似度排序会让"一年前那次充电站排队"和"这位车主一直讨厌排队"
 * 排在一起——前者早该淡出，后者应该越用越牢。
 *
 * # 衰减是排序权重，不是删除
 *
 * 本模块只影响**检索时的排序**。真正的删除（②的硬删阈值）在
 * `enterprise/backend/worker/src/memory-decay.ts`，两者不能混：
 * 排序错了用户觉得"它记性不好"，删错了内容就永远回不来了。
 *
 * # 访问强化：越常用越不容易忘
 *
 * ③偏好带访问强化（§7 表）。它建模的是"这条偏好还在被使用"这件事本身携带的信息量
 * ——用户每次让系统按某个偏好行事，都是在重新确认它。
 */

/** 各类别的衰减参数（§7 表）。**改这里等于改产品行为**，不是调参。 */
export interface DecayProfile {
  /** 半衰期（天）。`Infinity` 表示不衰减。 */
  halfLifeDays: number;
  /** 是否有访问强化。 */
  reinforceOnAccess: boolean;
  /** 单次访问的强化增量（相当于把"年龄"往回拨的天数）。 */
  reinforceDays?: number;
}

export const DECAY_PROFILES: Record<string, DecayProfile> = {
  // ②情景：指数衰减，半衰期 ~30d
  episodic: { halfLifeDays: 30, reinforceOnAccess: false },
  // ③偏好：慢衰减 + 访问强化，半衰期 ~365d，不硬删
  preference: { halfLifeDays: 365, reinforceOnAccess: true, reinforceDays: 30 },
  // ⑥用车画像聚合摘要：同③的强化策略，半衰期 ~180d
  usage_pattern: { halfLifeDays: 180, reinforceOnAccess: true, reinforceDays: 15 },
};

/** ④车辆档案与⑥原始流水不衰减——它们根本不经本模块（§7 表）。 */
export const NON_DECAYING = ["vehicle_profile", "usage_telemetry_raw"] as const;

export interface MemoryItem {
  id: string;
  category: string;
  /** §7 薄封装第 1 条：所有 Mem0 记忆带 category + created_at。 */
  createdAt: number;
  /** 最近一次被检索命中的时间；无则未被访问过。 */
  lastAccessedAt?: number;
  /** 累计访问次数。 */
  accessCount?: number;
  /** Mem0 给的向量相似度（0~1）。 */
  score: number;
  text: string;
}

export interface RerankOptions {
  now?: number;
  /**
   * 衰减权重在最终排序里的占比（0~1）。
   *
   * **不是 1.0**：完全按时间排序会让一条久远但高度相关的记忆彻底沉底。
   * 衰减是"降低陈旧信息的权重"，不是"只看新的"。
   */
  decayWeight?: number;
}

const DAY_MS = 86_400_000;

/**
 * 计算某条记忆的衰减系数（0~1）。
 *
 * 访问强化的实现方式是**把有效年龄往回拨**，而不是直接加分——
 * 后者会让一条被访问很多次的陈旧记忆权重超过 1，排到新记忆前面去。
 */
export function decayFactor(item: MemoryItem, now = Date.now()): number {
  const profile = DECAY_PROFILES[item.category];
  // 未登记的类别不衰减——**宁可不衰减，也不要按一个猜出来的半衰期衰减**。
  if (!profile || !Number.isFinite(profile.halfLifeDays)) return 1;

  let ageDays = (now - item.createdAt) / DAY_MS;

  if (profile.reinforceOnAccess && item.accessCount) {
    // 每次访问把年龄往回拨若干天，但**不能拨到负数**（那等于比新记忆还新）。
    ageDays = Math.max(0, ageDays - item.accessCount * (profile.reinforceDays ?? 0));
  }

  return Math.pow(0.5, ageDays / profile.halfLifeDays);
}

/**
 * 检索结果 re-rank。
 *
 * 混合权重：`score * (1 - w) + score * decay * w`。
 * 相似度仍是主导——衰减只调整同等相关度下的先后。
 */
export function rerank(items: readonly MemoryItem[], opts: RerankOptions = {}): MemoryItem[] {
  const now = opts.now ?? Date.now();
  const w = Math.min(1, Math.max(0, opts.decayWeight ?? 0.5));

  return [...items]
    .map((item) => ({ item, weighted: item.score * (1 - w) + item.score * decayFactor(item, now) * w }))
    .sort((a, b) => b.weighted - a.weighted)
    .map((x) => x.item);
}

/** 检索命中后的访问强化记录（写回 metadata 用）。 */
export function reinforce(item: MemoryItem, now = Date.now()): MemoryItem {
  const profile = DECAY_PROFILES[item.category];
  if (!profile?.reinforceOnAccess) return item;
  return { ...item, lastAccessedAt: now, accessCount: (item.accessCount ?? 0) + 1 };
}
