/**
 * ⑥用车数据聚合任务（施工单 M7-05，FL-32 F-32-02）。
 *
 * **这是 §7⑥ 两段式的第二段**：原始流水（PG `trips`）→ 用车画像 → 写 Mem0 `usage_pattern`。
 * 没有它，§6 的"双路检索"就只剩 RAG 一路，用车助手对谁都给同一份通用答案。
 *
 * # 幂等靠「同一用户同一窗口只留一条画像」
 *
 * Mem0 的 `add` 没有 upsert 语义，重跑会堆出第二条内容几乎一样的画像，
 * 检索时两条都命中、还互相稀释相似度。所以写入前先按 `userId + category`
 * 搜出旧画像删掉——**先删后写**而不是"写完再清"：后者中途失败会留下两条，
 * 而前者中途失败只是回到"没有画像"，下个窗口会重新算出来。
 *
 * # 无新数据日不是失败（F-22-09）
 *
 * 窗口内没有新流水，不代表画像该消失。此时**保留上一份画像**并让
 * `staleDays` 自己长上去，下游据它决定还能不能当个性化依据用。
 * 把"这天没开车"当成错误告警，会让告警在正常情况下天天响。
 */

import { getPrisma, createTripRepository, createVehicleMemberRepository } from "@carlife/db";
import {
  getMemoryClient,
  loadCompanionProfile,
  loadMemberUsageProfile,
  loadUsageProfile,
  type CompanionSummary,
  type UsageSummary,
  type EnergyConsumption,
} from "@carlife/memory";

import type { JobContext, JobDefinition, JobResult } from "./job-runner";

const HOUR_MS = 3_600_000;

/** 聚合窗口：画像看的是"近 30 天"，与 `loadUsageProfile` 的默认口径一致。 */
const PROFILE_WINDOW_DAYS = 30;

/**
 * 把摘要渲染成一句可检索的自然语言。
 *
 * Mem0 存的是文本、检索的是语义，所以画像必须写成"人会怎么问"的样子——
 * 存 `{avgDailyKm: 43.2}` 这种结构体，用户问"我平时开得多吗"是检索不到的。
 * `derivation` 一并带上：F-22-06 要求每个数字能追溯到它由哪段流水算出，
 * 否则罗启明问"这个数是真的还是编的"就答不上来。
 */
export function renderProfileText(
  summary: UsageSummary,
  /**
   * 实测能耗（M26-06，F-54-01）。**没有就不写**——
   * 画像里凭空多一句"百公里 X 升"，下游就会拿它去算缺口。
   */
  energy?: EnergyConsumption,
): string {
  const parts = [
    `近 ${summary.windowDays} 天日均里程约 ${summary.avgDailyKm.toFixed(1)} 公里`,
  ];
  if (summary.dominantRoadType) {
    const label = { city: "城市道路", highway: "高速", mixed: "城市与高速混合" }[summary.dominantRoadType];
    parts.push(`最常走${label}`);
  }
  if (summary.commonChargeHours.length) {
    parts.push(`常在 ${summary.commonChargeHours.map((h) => `${h}点`).join("、")}充电`);
  }
  if (summary.lowTempRangeKm !== undefined) {
    const base =
      summary.mildTempRangeKm !== undefined
        ? `，常温下为 ${summary.mildTempRangeKm.toFixed(0)} 公里`
        : "";
    parts.push(`低温（≤5℃）实际续航约 ${summary.lowTempRangeKm.toFixed(0)} 公里${base}`);
  }
  if (energy) {
    // 单位跟着能源类型走：燃油说"升"、纯电说"百分之几"（见 memory 的 energy.ts）。
    const what = energy.unit === "L" ? "百公里油耗" : "每百公里耗电";
    parts.push(`${what}约 ${energy.value}${energy.unit}（${energy.sampleSize} 个样本）`);
  }
  parts.push(`样本 ${summary.sampleSize} 趟`);
  const derivation = [...summary.derivation, ...(energy?.derivation ?? [])];
  return `${parts.join("；")}。依据：${derivation.join("；")}`;
}

/**
 * 按人渲染画像文本（施工单 M17-02，F-46-06）。
 *
 * # 称呼一个字都不能进来
 *
 * 这句话是要写进 pgvector 的。一旦写进"妈妈"，他人姓名就留在了向量库里：
 * 改称呼改不干净，删人删不干净——而 US-46 最严重的失败形态正是
 * "档案没了画像还在被检索到"。
 *
 * 所以文本里只有**成员标识与角色词**（"该驾驶人"），称呼由展示层从 PG 的档案表补。
 * 检索仍然有效：语义匹配靠的是"日均里程""常走高速"这些说法，不靠人名。
 */
export function renderMemberProfileText(memberId: string, summary: UsageSummary): string {
  return `该驾驶人（成员 ${memberId}）${renderProfileText(summary)}`;
}

/** 乘车人：只给同行频次与时段。**不给里程**——她没开车。 */
export function renderCompanionProfileText(memberId: string, summary: CompanionSummary): string {
  const hours = summary.commonHours.length
    ? `，常在 ${summary.commonHours.map((h) => `${h}点`).join("、")}出发`
    : "";
  return (
    `该同行人（成员 ${memberId}）近 ${summary.windowDays} 天同行 ${summary.sampleSize} 次${hours}。` +
    `依据：${summary.derivation.join("；")}`
  );
}

export interface AggregationDeps {
  /** 本窗口内有流水的用户。分离出来是为了单测能不碰数据库。 */
  activeUserIds(fromMs: number, toMs: number): Promise<string[]>;
  loadProfile(userId: string, now: number): Promise<{ summary: UsageSummary }>;
  /** 删除该用户已有的画像，返回删除条数。 */
  clearProfiles(userId: string): Promise<number>;
  writeProfile(userId: string, text: string, summary: UsageSummary): Promise<void>;
  /**
   * 该用户当前**仍然存在**的成员（施工单 M17-02）。
   *
   * 聚合前必须按它过滤：删除路径（`removeMemberCascade`）删得再干净，
   * 也挡不住下一轮聚合照着旧流水把画像重新造出来。
   */
  listMembers?(userId: string): Promise<Array<{ id: string; roles: string[] }>>;
  loadMemberProfile?(userId: string, memberId: string, now: number): Promise<{ summary: UsageSummary }>;
  loadCompanion?(userId: string, memberId: string, now: number): Promise<{ summary: CompanionSummary }>;
  /** 删除该成员已有的画像，返回条数。 */
  clearMemberProfiles?(userId: string, memberId: string): Promise<number>;
  writeMemberProfile?(
    userId: string,
    memberId: string,
    scope: "driver" | "passenger",
    text: string,
    meta: { sampleSize: number; staleDays: number; windowDays: number },
  ): Promise<void>;
  now?: () => number;
}

export async function runAggregation(ctx: JobContext, deps: AggregationDeps): Promise<JobResult> {
  const now = (deps.now ?? Date.now)();
  const result: JobResult = { processed: 0, changed: 0, deleted: 0, failures: [] };

  const userIds = await deps.activeUserIds(ctx.from, ctx.to);
  for (const userId of userIds) {
    result.processed += 1;
    try {
      const { summary } = await deps.loadProfile(userId, now);
      // 样本为 0 时不写画像——**空画像比没有画像更危险**：
      // 下游读到一条"日均 0 公里"的记录会当成真实结论，而不是"没数据"。
      if (summary.sampleSize === 0) continue;

      result.deleted += await deps.clearProfiles(userId);
      await deps.writeProfile(userId, renderProfileText(summary), summary);
      result.changed += 1;

      // 整车画像之后再跑一轮按人的（F-46-06）。**整车那份不动**——
      // 双路检索的下游还在用它，人员维度是新增的一层，不是替换。
      await aggregateMembers(deps, userId, now, result);
    } catch (err) {
      // 单个用户失败不拖垮整个窗口：其余用户的画像照常更新，
      // 失败项进 failures 由 runJob 汇总告警（F-32-07）。
      result.failures.push(`${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/**
 * 按人聚合（F-46-06/07/12）。
 *
 * 三条纪律都在这几十行里：
 *  1. **只对现存成员算**——删掉的人不能因为旧流水复活；
 *  2. **样本为 0 不写**——空画像比没有画像更危险（同整车那条）；
 *  3. **驾驶与同行分开算**：乘客没有日均里程可言，为了字段齐全给她算一个，
 *     那个数字会被下游当成"她开了多少"。
 */
async function aggregateMembers(
  deps: AggregationDeps,
  userId: string,
  now: number,
  result: JobResult,
): Promise<void> {
  if (!deps.listMembers || !deps.writeMemberProfile || !deps.clearMemberProfiles) return;
  const members = await deps.listMembers(userId);
  for (const m of members) {
    if (m.roles.includes("driver") && deps.loadMemberProfile) {
      const { summary } = await deps.loadMemberProfile(userId, m.id, now);
      result.deleted += await deps.clearMemberProfiles(userId, m.id);
      if (summary.sampleSize > 0) {
        await deps.writeMemberProfile(userId, m.id, "driver", renderMemberProfileText(m.id, summary), {
          sampleSize: summary.sampleSize,
          staleDays: summary.staleDays,
          windowDays: summary.windowDays,
        });
        result.changed += 1;
      }
    }
    if (m.roles.includes("passenger") && deps.loadCompanion) {
      const { summary } = await deps.loadCompanion(userId, m.id, now);
      if (!m.roles.includes("driver")) {
        result.deleted += await deps.clearMemberProfiles(userId, m.id);
      }
      if (summary.sampleSize > 0) {
        await deps.writeMemberProfile(
          userId,
          m.id,
          "passenger",
          renderCompanionProfileText(m.id, summary),
          {
            sampleSize: summary.sampleSize,
            staleDays: summary.staleDays,
            windowDays: summary.windowDays,
          },
        );
        result.changed += 1;
      }
    }
  }
}

/** 生产依赖装配：PG 流水 + Mem0 画像。 */
export function createAggregationDeps(): AggregationDeps {
  const prisma = getPrisma();
  const trips = createTripRepository(prisma);
  const members = createVehicleMemberRepository(prisma);
  const memory = getMemoryClient();

  /** 按成员清画像。**过滤条件必须含 member_id**，否则会把整车画像一起删掉。 */
  const clearFor = async (userId: string, memberId: string): Promise<number> => {
    const existing = await memory.getAll(userId, { category: "usage_pattern" }, 200);
    const mine = (existing.results ?? []).filter((m) => m.metadata?.member_id === memberId);
    for (const item of mine) await memory.delete(item.id);
    return mine.length;
  };

  return {
    async activeUserIds(fromMs, toMs) {
      const rows = await prisma.trip.findMany({
        where: { endedAt: { gte: new Date(fromMs), lte: new Date(toMs) } },
        select: { userId: true },
        distinct: ["userId"],
      });
      return rows.map((r) => r.userId);
    },
    loadProfile: (userId, now) => loadUsageProfile(trips, userId, now, PROFILE_WINDOW_DAYS),
    async clearProfiles(userId) {
      // getAll 的 category 过滤在客户端侧完成（见 client.ts 注释），这里直接给 filters
      const existing = await memory.getAll(userId, { category: "usage_pattern" }, 200);
      // **只清整车那份**：带 member_id 的是按人画像，由 clearMemberProfiles 各自负责。
      // 不加这个过滤，整车聚合会在每一轮把刚写好的人员画像全删一遍。
      const stale = (existing.results ?? []).filter((m) => !m.metadata?.member_id);
      for (const item of stale) await memory.delete(item.id);
      return stale.length;
    },

    async listMembers(userId) {
      const rows = await members.listByOwner(userId);
      return rows.map((m) => ({ id: m.id, roles: m.roles as string[] }));
    },
    loadMemberProfile: (userId, memberId, now) =>
      loadMemberUsageProfile(trips, userId, memberId, now, PROFILE_WINDOW_DAYS),
    loadCompanion: (userId, memberId, now) =>
      loadCompanionProfile(trips, userId, memberId, now, PROFILE_WINDOW_DAYS),
    clearMemberProfiles: clearFor,
    async writeMemberProfile(userId, memberId, scope, text, meta) {
      const periodEnd = new Date();
      const periodStart = new Date(periodEnd.getTime() - meta.windowDays * 86_400_000);
      await memory.addUsagePattern(userId, text, {
        summaryType: "daily",
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        // 人员维度是 **metadata 上的过滤条件**，不是新的 category——
        // 新 category 会绕开 F-21-01 的衰减策略（taxonomy 里没有它，衰减任务不认识它）。
        member_id: memberId,
        member_scope: scope,
        stale_days: meta.staleDays,
        sample_size: meta.sampleSize,
        window_days: meta.windowDays,
      });
    },
    async writeProfile(userId, text, summary) {
      const periodEnd = new Date();
      const periodStart = new Date(periodEnd.getTime() - summary.windowDays * 86_400_000);
      await memory.addUsagePattern(userId, text, {
        summaryType: "daily",
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        // stale_days 是下游判「能不能当个性化依据」的开关（F-22-09、F-32-07），
        // 必须随画像一起落在 metadata 上，不能只存在摘要文本里
        stale_days: summary.staleDays,
        sample_size: summary.sampleSize,
        window_days: summary.windowDays,
      });
    },
  };
}

export const usageAggregationJob: JobDefinition = {
  name: "usage-aggregation",
  // 每小时跑一次。低峰窗口的资源控制交给部署侧的调度表达式，
  // 这里只声明"窗口有多长"——两者混在一起会让补偿算错窗口数。
  intervalMs: HOUR_MS,
  // 最多补 48 个窗口（两天）。停机一周后一次补 168 个窗口会打垮 Mem0，
  // 而且两天前的"最新画像"补出来立刻会被下一个窗口覆盖，没有意义。
  maxCatchUpWindows: 48,
  run: (ctx) => runAggregation(ctx, createAggregationDeps()),
};
