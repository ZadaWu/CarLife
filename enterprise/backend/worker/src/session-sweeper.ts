/**
 * 空闲空会话的兜底收口（施工单 M50-03，FL-07 F-07-09）。
 *
 * # 它治的是"懒关闭等不到那一次访问"
 *
 * 网关的会话过期是**懒关闭**：`checkSessionUsable` 判出过期就顺手落 `closed_at`，
 * 但那只发生在**下一次访问那个会话**的时候（`enterprise/backend/gateway/src/http/index.ts`
 * 的注释原文：「没有 cron，过期是在下一次访问时才落定的」）。
 *
 * 而零消息的会话多半没有下一次访问——2026-08-31 实测：dev 库里 73 个零消息会话中
 * **60 个的 `closed_at` 是 NULL**（其余 13 个碰巧被再访问过一次，由懒关闭顺手收掉了），
 * 那 60 个在每一个按"未关闭"判活的地方都显示成活着的会话
 * （车机的会话列表、运营控制台、演示大屏的会话选择）。
 * **懒关闭不是不生效，是够不着**——它只能收到"还会被访问的那些"。
 *
 * 所以这条不是"再做一遍网关做过的事"，是**补上网关这条路够不到的那一块**。
 * 两条路并存是刻意的：访问路径要立刻回 `expired`，兜底路径负责那些永远不会被访问的。
 *
 * # 状态收敛型，不是窗口聚合型
 *
 * 与 `usage-aggregation` 形态不同：本任务每次跑都扫**当前**所有符合条件的会话，
 * `ctx.from/to` 与 `isCatchUp` 不改变它的行为（因此 `maxCatchUpWindows: 1`）。
 * 照着聚合任务的样子给它套窗口是错的——漏跑一小时不会漏掉任何会话，
 * 它们下一拍照样在那儿等着。
 *
 * # 只关不删
 *
 * `deleted` 恒为 0，测试里有一条断言专门守着它。关掉的是"还能不能接着说"，
 * 行与消息一条不删——删行会让"这辆车上发生过一次访客对话"这类审计证据消失。
 */

import { DEFAULT_SESSION_IDLE_MIN } from "@carlife/shared";

import type { JobContext, JobDefinition, JobResult } from "./job-runner";

const HOUR_MS = 3_600_000;

/** 一次最多处理多少条：不长时间占着表；剩下的下一拍继续（`remaining` 会报出来）。 */
export const SWEEP_LIMIT = 500;

/**
 * 空闲多久算结束。
 *
 * **与网关同源**：读同一个 `CARLIFE_SESSION_IDLE_MIN`、回落同一个默认值。
 * 两处各写一个阈值就是两套过期语义——会出现"车机认为还能接着说、兜底已经把它关了"。
 * 与网关的 `sessionIdleMs()` 一样在调用时读 env（非入口模块不在模块级读环境变量）。
 */
export function sweepIdleMs(): number {
  const raw = Number(process.env.CARLIFE_SESSION_IDLE_MIN);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SESSION_IDLE_MIN;
  return minutes * 60 * 1000;
}

export interface SessionSweeperDeps {
  /** 批量收口。返回扫到几条、真关了几条、这一批之外还剩几条。 */
  closeIdleEmptySessions(opts: {
    idleMs: number;
    now?: Date;
    limit?: number;
  }): Promise<{ scanned: number; closed: number; remaining: number }>;
  now?: () => number;
}

export async function runSessionSweeper(
  _ctx: JobContext,
  deps: SessionSweeperDeps,
): Promise<JobResult> {
  const now = new Date((deps.now ?? Date.now)());
  const idleMs = sweepIdleMs();
  const { scanned, closed, remaining } = await deps.closeIdleEmptySessions({
    idleMs,
    now,
    limit: SWEEP_LIMIT,
  });
  if (remaining > 0) {
    // **上限要说出来**：不说的话，"这轮关了 500 条"看起来像已经清干净了。
    console.log(`[worker] session-sweeper 本轮到达上限 ${SWEEP_LIMIT}，还剩 ${remaining} 条待下一拍`);
  }
  return {
    processed: scanned,
    changed: closed,
    // **恒为 0**：这个任务只关不删。测试里有一条断言专门守它。
    deleted: 0,
    /*
     * 扫到 0 条**不是失败**：库里此刻没有可关的会话是正常状态。
     * 把它记成 failure 会让"一切正常"变成每小时一条告警，
     * 而那正是让人从此忽略这个任务告警的最快方式。
     */
    failures: [],
  };
}

export const sessionSweeperJob: JobDefinition = {
  name: "session-sweeper",
  intervalMs: HOUR_MS,
  // 状态收敛型（见模块注释）：漏跑的窗口不需要补，下一拍照样扫得到。
  maxCatchUpWindows: 1,
  run: (ctx) => runSessionSweeper(ctx, createSessionSweeperDeps()),
};

function createSessionSweeperDeps(): SessionSweeperDeps {
  // 延迟到调用时才建仓储：与其它任务一致，装配失败不该在模块加载时炸。
  return {
    async closeIdleEmptySessions(opts) {
      const { getPrisma, createChatRepository } = await import("@carlife/db");
      return createChatRepository(getPrisma()).closeIdleEmptySessions(opts);
    },
  };
}
