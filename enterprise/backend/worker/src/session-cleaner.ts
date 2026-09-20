/**
 * 会话按天自动清理（施工单 M108-02，FL-03 F-03-11）。
 *
 * # 它治的是"演示环境的会话只增不减"
 *
 * 公开演示的访客共用一个账号，会话一天攒几百条，谁都能在列表里翻到别人聊过什么。
 * 这条任务每小时把**最后活动早于 N 天**的会话清理一批。N 来自热配置
 * `SESSION_AUTO_CLEAN_DAYS`：**缺省 0 = 关**，演示环境在后台「配置」页设成 1。
 * 缺省不开是因为车主本来翻得到昨天的对话——那是产品行为，不该被一个缺省值改掉。
 *
 * # 清理是软删除，不物理删任何东西
 *
 * 仓储那一侧只写 `sessions.deleted_at`（顺手把为空的 `closed_at` 落值），
 * 会话行、消息、轨迹、用量一行不少，控制台「会话与对话」页可以筛出来恢复。
 * 所以 `JobResult.deleted`（物理删除的行数）**恒为 0**，软删的条数记在 `changed`；
 * 测试里有一条断言专门守它。也**不会有**「N 天后真删」的第二段——
 * 删会话只有消息会级联，轨迹、用量、附件、行程都会变成找不到主人的孤儿。
 *
 * # 每拍读一次配置，不在装配时读
 *
 * `research-acquire` 是装配时读开关（开着才进调度表）；这里反过来：任务恒在调度表里，
 * **每次跑的时候读天数**。否则在后台把 0 改成 1 之后还得重启 worker 才生效，
 * 而"改了配置没反应"正是最容易让人以为功能坏了的那种沉默。
 * 读不到配置（库抖了一下）时**这一拍不清**并报一条 failure——宁可晚一小时，不按缺省值猜。
 *
 * # 状态收敛型，不是窗口聚合型
 *
 * 与 `session-sweeper` 同形：每次跑都扫**当前**所有符合条件的会话，`ctx.from/to` 不改变行为
 * （因此 `maxCatchUpWindows: 1`）。一拍只跑一批（`CLEAN_LIMIT`），剩下的如实报出来、下一拍继续——
 * 在一拍里循环到清完等于把上限取消了。
 */

import type { JobContext, JobDefinition, JobResult } from "./job-runner";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** 一次最多清理多少条：不长时间占着表；剩下的下一拍继续。 */
export const CLEAN_LIMIT = 500;

/** 热配置键（注册在 `@carlife/db` 的 `config/registry.ts`）。 */
export const CLEAN_DAYS_KEY = "SESSION_AUTO_CLEAN_DAYS";

/**
 * 配置值 → 天数。**只接受正整数，其余一律当 0（关）。**
 *
 * 注册表的校验已经挡掉了负数与小数，这里再挡一遍是因为值也可能来自 env 回落——
 * 那条路不过校验。把 `"0.5"` 当成半天、把 `"abc"` 当成 `NaN` 再算出一个 `Invalid Date`，
 * 后果都是"清掉了不该清的"，而关着最多是"没清"。
 */
export function parseCleanDays(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return 0;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export interface SessionCleanerDeps {
  /** 读热配置里的天数原文。抛错 = 这一拍不清。 */
  readCleanDays(): Promise<string | null | undefined>;
  /** 分批软删。返回扫到几条、真清了几条、这一批之外还剩几条。 */
  softDeleteSessions(opts: {
    olderThan?: Date;
    now?: Date;
    limit?: number;
  }): Promise<{ scanned: number; deleted: number; remaining: number }>;
  now?: () => number;
}

const EMPTY: JobResult = { processed: 0, changed: 0, deleted: 0, failures: [] };

export async function runSessionCleaner(
  _ctx: JobContext,
  deps: SessionCleanerDeps,
): Promise<JobResult> {
  let raw: string | null | undefined;
  try {
    raw = await deps.readCleanDays();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ...EMPTY, failures: [`读不到 ${CLEAN_DAYS_KEY}，本拍不清理：${reason}`] };
  }
  const days = parseCleanDays(raw);
  // 关着是常态（缺省就是 0），不是失败，也不打日志——每小时一行"没开"只会让人学会忽略它。
  if (days === 0) return { ...EMPTY };

  const now = new Date((deps.now ?? Date.now)());
  const { scanned, deleted, remaining } = await deps.softDeleteSessions({
    olderThan: new Date(now.getTime() - days * DAY_MS),
    now,
    limit: CLEAN_LIMIT,
  });
  if (remaining > 0) {
    // **上限要说出来**：不说的话，"这轮清了 500 条"看起来像已经清干净了。
    console.log(`[worker] session-cleaner 本轮到达上限 ${CLEAN_LIMIT}，还剩 ${remaining} 条待下一拍`);
  }
  return {
    processed: scanned,
    changed: deleted,
    // **恒为 0**：软删除不物理删任何行。测试里有一条断言专门守它。
    deleted: 0,
    failures: [],
  };
}

export const sessionCleanerJob: JobDefinition = {
  name: "session-cleaner",
  intervalMs: HOUR_MS,
  // 状态收敛型（见模块注释）：漏跑的窗口不需要补，下一拍照样扫得到。
  maxCatchUpWindows: 1,
  run: (ctx) => runSessionCleaner(ctx, createSessionCleanerDeps()),
};

function createSessionCleanerDeps(): SessionCleanerDeps {
  // 延迟到调用时才建仓储：与其它任务一致，装配失败不该在模块加载时炸。
  return {
    async readCleanDays() {
      const { getPrisma, createConfigStore } = await import("@carlife/db");
      return createConfigStore(getPrisma()).get(CLEAN_DAYS_KEY);
    },
    async softDeleteSessions(opts) {
      const { getPrisma, createChatRepository } = await import("@carlife/db");
      return createChatRepository(getPrisma()).softDeleteSessions(opts);
    },
  };
}
