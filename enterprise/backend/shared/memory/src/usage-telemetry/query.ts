/**
 * ⑥用车数据的读取侧（施工单 M7-04）。
 *
 * 两个消费方，形态不同：
 *  - **画像聚合**（`aggregate`）：取窗口内全部流水，算日均里程、低温续航等；
 *  - **售后详细分析**（FL-20）：按时间范围看具体某几趟，
 *    用户拿它和维修厂对账，所以要的是原始记录不是摘要。
 *
 * 本文件只做"取数 + 组装成画像"，判断能不能用是 `assessUsability` 的事——
 * 两者分开是因为 **staleDays 管「能不能用」、半衰期管「排序权重」**，
 * 混在一起会出现"排序靠后但仍被当成个性化依据"。
 */

import type { StoredTrip, TripStore } from "./ingest";
import {
  aggregate,
  aggregateCompanion,
  assessCompanionUsability,
  assessUsability,
  type CompanionSummary,
  type UsabilityVerdict,
  type UsageSummary,
} from "./summary";

const DAY_MS = 86_400_000;

/**
 * 画像 + 可用性判定，一次拿全。
 *
 * 返回结构刻意让 `summary` 与 `verdict` 并存而不是"不可用就返回 undefined"：
 * 降级话术需要说清**为什么**不可用（"样本只有 2 条"比"数据不足"有用得多），
 * 而那个理由只能从 summary 里读出来。
 */
export interface UsageProfile {
  summary: UsageSummary;
  verdict: UsabilityVerdict;
  /** 参与统计的原始流水条数（未过滤前）。 */
  fetched: number;
}

export async function loadUsageProfile(
  store: TripStore,
  userId: string,
  now: number,
  windowDays = 30,
  vin?: string,
): Promise<UsageProfile> {
  if (!userId?.trim()) {
    // 与 Mem0 客户端同一条红线：无用户上下文的读取必须失败，不能读全量。
    throw new Error("读取用车数据必须带用户维度：userId 为空");
  }
  // 多取一倍窗口：`aggregate` 自己会按窗口过滤，但 staleDays 需要知道
  // **窗口之外**是否还有更近的流水——只取窗口内会把"上个月开过、这个月没开"
  // 误判成"从没有数据"。
  const trips = await store.range(userId, now - windowDays * 2 * DAY_MS, now, vin);
  const summary = aggregate(trips, now, windowDays);
  return { summary, verdict: assessUsability(summary), fetched: trips.length };
}

/** 售后详细分析：按时间范围取原始流水（不聚合）。 */
export async function listTrips(
  store: TripStore,
  userId: string,
  fromMs: number,
  toMs: number,
  vin?: string,
): Promise<StoredTrip[]> {
  if (!userId?.trim()) throw new Error("读取用车数据必须带用户维度：userId 为空");
  if (toMs < fromMs) throw new Error("时间范围非法：结束早于开始");
  return store.range(userId, fromMs, toMs, vin);
}

// ── 按人读取（施工单 M17-02，F-46-07/08）──────────────────────

/**
 * 画像的口径。**必须随结果一起交付**：
 * 回落到整车数据时如果不说，用户会以为那是"她"的数字。
 */
export type ProfileScope = "member" | "vehicle";

export interface MemberUsageProfile extends UsageProfile {
  memberId: string;
  scope: ProfileScope;
}

/**
 * 某位常驾人的用车画像（F-46-07）。
 *
 * **同时限定用户与成员**，缺任一个直接抛。只限定用户会把一家人的流水
 * 混算成一个画像——那比没有画像更糟，因为它看起来是个结论。
 */
export async function loadMemberUsageProfile(
  store: TripStore,
  ownerId: string,
  memberId: string,
  now: number,
  windowDays = 30,
  vin?: string,
): Promise<MemberUsageProfile> {
  if (!ownerId?.trim()) throw new Error("读取人员画像必须带用户维度：ownerId 为空");
  if (!memberId?.trim()) throw new Error("读取人员画像必须指明是谁：memberId 为空");
  const trips = await store.range(ownerId, now - windowDays * 2 * DAY_MS, now, vin, {
    driverMemberId: memberId,
  });
  const summary = aggregate(trips, now, windowDays);
  return {
    summary,
    verdict: assessUsability(summary),
    fetched: trips.length,
    memberId,
    scope: "member",
  };
}

export interface CompanionProfile {
  memberId: string;
  summary: CompanionSummary;
  verdict: UsabilityVerdict;
  fetched: number;
}

/** 某位常乘人的同行画像（F-46-06）。只给频次与时段，不给里程。 */
export async function loadCompanionProfile(
  store: TripStore,
  ownerId: string,
  memberId: string,
  now: number,
  windowDays = 30,
  vin?: string,
): Promise<CompanionProfile> {
  if (!ownerId?.trim()) throw new Error("读取同行画像必须带用户维度：ownerId 为空");
  if (!memberId?.trim()) throw new Error("读取同行画像必须指明是谁：memberId 为空");
  const trips = await store.range(ownerId, now - windowDays * 2 * DAY_MS, now, vin, {
    passengerMemberId: memberId,
  });
  const summary = aggregateCompanion(trips, now, windowDays);
  return { memberId, summary, verdict: assessCompanionUsability(summary), fetched: trips.length };
}

/**
 * 人员画像不可用时回落到整车口径（F-46-08）。
 *
 * **回落是显式的**：返回体带 `scope: "vehicle"`，调用方必须据此在话术里说明
 * "这是整车数据不是她一个人的"。隐式回落等于用整车数字冒充个人结论——
 * 那正是 §7⑥ 反复在防的那件事，只是换了个维度。
 *
 * 按人拆分后样本天然更稀疏，"整车有画像、每个人都没有"是**真实状态**，
 * 不靠调低 `MIN_SAMPLE` 粉饰。
 */
export async function memberProfileFallback(
  store: TripStore,
  ownerId: string,
  memberId: string,
  now: number,
  windowDays = 30,
  vin?: string,
): Promise<MemberUsageProfile> {
  const own = await loadMemberUsageProfile(store, ownerId, memberId, now, windowDays, vin);
  if (own.verdict.usable) return own;
  const whole = await loadUsageProfile(store, ownerId, now, windowDays, vin);
  return { ...whole, memberId, scope: "vehicle" };
}
