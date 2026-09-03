/**
 * 记忆衰减 / episodic 硬删任务（施工单 M7-05，FL-32 F-32-01/08）。
 *
 * **这是 §7 自建薄封装的第 3 件事**：Mem0 OSS 无内置 TTL/衰减，所以这个任务是必需品而非优化。
 *
 * # 与 `decay.ts` 的分工：排序 vs 删除
 *
 * `enterprise/backend/shared/memory/src/decay.ts` 的 `decayFactor` 只影响**检索排序**；本任务用同一个
 * 衰减系数决定**删不删**。共用一个函数是刻意的——两处各写一套衰减曲线，
 * 会出现"排序上已经沉底、但永远删不掉"或者反过来的撕裂。
 * 排序错了用户觉得"它记性不好"，删错了内容就永远回不来。
 *
 * # 保守优先：多删与少删之间选少删（F-32-08）
 *
 * 三道闸串起来，任何一道不满足就整批中止：
 *  1. **只删 ②episodic**——③偏好不硬删（§7③），④车辆档案根本不经 Mem0（F-23-08）；
 *  2. **删除比例上限**——一次删掉超过 `maxDeleteRatio` 的记忆几乎一定是阈值配错了，
 *     不是真的有那么多该删的。此时告警并中止，**一条都不删**；
 *  3. **软删优先**——默认只打 `soft_deleted` 标记并留回滚窗口，
 *     物理删除交给下一轮确认过窗口期的条目。硬删不可逆是最大单点风险。
 */

import { getMemoryClient, decayFactor, type DecayMemoryItem } from "@carlife/memory";

import type { JobContext, JobDefinition, JobResult } from "./job-runner";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * 衰减系数低于此值的 ②episodic 进入删除候选。
 *
 * 0.03 对应半衰期 30d 下约 150 天未被访问——**不是拍脑袋**：
 * 这是"再检索也几乎排不进前列"的点位，此前删掉只会丢掉仍可能被用到的内容。
 */
export const DECAY_DELETE_THRESHOLD = 0.03;

/** 单轮删除比例上限。超过即判定为阈值配错，中止并告警。 */
export const MAX_DELETE_RATIO = 0.2;

/** 软删后多久才物理删除（回滚窗口）。 */
export const SOFT_DELETE_GRACE_DAYS = 7;

export interface DecayCandidate {
  id: string;
  userId: string;
  category: string;
  createdAt: number;
  accessCount?: number;
  /** 已被软删的时间；未软删则 undefined。 */
  softDeletedAt?: number;
}

export interface DecayDeps {
  /** 扫描全部 ②episodic 候选。 */
  scan(): Promise<DecayCandidate[]>;
  /** 打软删标记（可回滚）。 */
  softDelete(item: DecayCandidate): Promise<void>;
  /** 物理删除（不可逆），仅对过了回滚窗口的软删条目调用。 */
  hardDelete(item: DecayCandidate): Promise<void>;
  now?: () => number;
}

/** 中止信号：让 `runJob` 走失败路径去告警，而不是安静地返回一个"删了 0 条"。 */
export class DecayAbortError extends Error {}

export async function runDecay(_ctx: JobContext, deps: DecayDeps): Promise<JobResult> {
  const now = (deps.now ?? Date.now)();
  const result: JobResult = { processed: 0, changed: 0, deleted: 0, failures: [] };

  const all = await deps.scan();
  result.processed = all.length;
  if (all.length === 0) return result;

  // 闸 1：作用域。**断言而不是过滤**——扫描层如果把③偏好或④档案漏进来了，
  // 这里静静滤掉会掩盖上游的错，下次换个人改扫描就真删到了（F-23-08）。
  const outOfScope = all.filter((item) => item.category !== "episodic");
  if (outOfScope.length > 0) {
    throw new DecayAbortError(
      `衰减作用域越界：候选里出现 ${outOfScope.length} 条非 episodic（${[
        ...new Set(outOfScope.map((i) => i.category)),
      ].join("、")}），已中止，未删除任何条目`,
    );
  }

  // 先处理已软删且过了回滚窗口的——它们上一轮就判过了，这轮只是执行。
  const graceMs = SOFT_DELETE_GRACE_DAYS * DAY_MS;
  const ripe = all.filter((i) => i.softDeletedAt !== undefined && now - i.softDeletedAt >= graceMs);

  // 本轮新增的软删候选：衰减系数已低于阈值、且还没被软删过。
  const fresh = all.filter((item) => {
    if (item.softDeletedAt !== undefined) return false;
    const factor = decayFactor(
      {
        id: item.id,
        category: item.category,
        createdAt: item.createdAt,
        accessCount: item.accessCount,
        score: 1,
        text: "",
      } satisfies DecayMemoryItem,
      now,
    );
    return factor < DECAY_DELETE_THRESHOLD;
  });

  // 闸 2：比例上限。分母是"活着的"条目——把已软删的算进分母会让阈值随
  // 软删堆积而虚高，越删越容易通过检查，恰好是我们要防的方向。
  const alive = all.filter((i) => i.softDeletedAt === undefined).length;
  if (alive > 0 && fresh.length / alive > MAX_DELETE_RATIO) {
    throw new DecayAbortError(
      `异常删除量级：本轮将软删 ${fresh.length}/${alive} 条（${((fresh.length / alive) * 100).toFixed(
        1,
      )}% > 上限 ${MAX_DELETE_RATIO * 100}%），判定为阈值配错，已中止，未删除任何条目`,
    );
  }

  // 闸 3：软删在前、硬删在后。顺序不能反——先硬删会让本轮的比例检查失去意义。
  for (const item of fresh) {
    try {
      await deps.softDelete(item);
      result.changed += 1;
    } catch (err) {
      result.failures.push(`软删 ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const item of ripe) {
    try {
      await deps.hardDelete(item);
      result.deleted += 1;
    } catch (err) {
      result.failures.push(`硬删 ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** 生产依赖装配：全量扫 Mem0 的 ②episodic。 */
export function createDecayDeps(listUserIds: () => Promise<string[]>): DecayDeps {
  const memory = getMemoryClient();

  return {
    async scan() {
      const out: DecayCandidate[] = [];
      for (const userId of await listUserIds()) {
        const res = await memory.getAll(userId, { category: "episodic" }, 500);
        for (const item of res.results ?? []) {
          const meta = (item.metadata ?? {}) as Record<string, unknown>;
          out.push({
            id: item.id,
            userId,
            category: String(meta.category ?? "episodic"),
            createdAt: Date.parse(String(meta.created_at ?? item.createdAt ?? "")) || Date.now(),
            accessCount: typeof meta.access_count === "number" ? meta.access_count : undefined,
            softDeletedAt:
              typeof meta.soft_deleted_at === "string" ? Date.parse(meta.soft_deleted_at) : undefined,
          });
        }
      }
      return out;
    },
    async softDelete(item) {
      /*
       * 软删标记写 metadata，**与 scan 的判据同一处**（M37-03 评测发现的缺陷修复）：
       * 此前标记写在正文前缀而 scan 读 metadata.soft_deleted_at（无人写入）——
       * 软删条目每轮被重复软删、`ripe` 恒空、物理删除永远不会发生。
       * mem0ai ≥3.1 的 update({ metadata }) 是合并语义，正文与其余元数据不动；
       * 回滚 = 把 soft_deleted_at 置 null（updateMetadata 的说明）。
       */
      await memory.updateMetadata(item.id, { soft_deleted_at: new Date().toISOString() });
    },
    async hardDelete(item) {
      await memory.delete(item.id);
    },
  };
}

export const memoryDecayJob: JobDefinition = {
  name: "memory-decay",
  // 每天一次。衰减是以天为尺度的现象，跑得再密也不会更准，只会多占资源。
  intervalMs: 24 * HOUR_MS,
  // 补偿上限 7 天：更久之前的"该不该删"重算一遍结论也一样（衰减只看 createdAt），
  // 补跑多轮纯属浪费。
  maxCatchUpWindows: 7,
  run: (ctx) =>
    runDecay(
      ctx,
      createDecayDeps(async () => {
        const { getPrisma } = await import("@carlife/db");
        /*
         * 排除访客会话（M48-01 起 `userId` 可空）。访客没有账号，
         * 也就没有②③记忆可衰减——把 null 放进来，下游会拿它当用户维度去
         * 检索 Mem0，而"用一个空的隔离键去检索"正是 memory/client.ts 明令
         * 拒绝的那件事（缺用户维度时抛错，不退化成读全量）。
         */
        const rows = await getPrisma().session.findMany({
          where: { userId: { not: null } },
          select: { userId: true },
          distinct: ["userId"],
        });
        return rows.flatMap((r) => (r.userId ? [r.userId] : []));
      }),
    ),
};
