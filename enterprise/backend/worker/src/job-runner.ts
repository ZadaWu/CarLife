/**
 * 定时任务运行契约（施工单 M7-05，FL-32）。
 *
 * 四个任务（memory-decay / usage-aggregation / kb-sync / vehicle-reminder）**共享**
 * 这三条契约，因此做成框架而不是各写一遍：
 *
 * 1. **幂等**——重跑不产生重复条目、重复提醒、重复删除；
 * 2. **可补偿**——漏跑窗口下次能补，且补偿范围有上限（不一次补一年）；
 * 3. **失败要出声**——**一个不会报警的定时任务比没有这个任务更危险**，
 *    因为下游会当它成功了（FL-32 三条运行契约原文）。
 *
 * # 同任务并发互斥
 *
 * 没有它，幂等也救不了：两个实例同时跑 `memory-decay`，各自读到"还没删"，
 * 于是删两遍（§13-13 的单实例假设正是为此）。
 */

export interface JobContext {
  /** 本次执行覆盖的时间窗口。 */
  from: number;
  to: number;
  /** 是否为补偿执行（漏跑后的追赶）。 */
  isCatchUp: boolean;
}

export interface JobResult {
  processed: number;
  changed: number;
  deleted: number;
  failures: string[];
}

export interface JobDefinition {
  name: string;
  /** 正常执行间隔（毫秒）。 */
  intervalMs: number;
  /**
   * 补偿上限：最多往回补几个窗口。
   *
   * **不是无限**——停机一周后一次补 168 个小时窗口会打垮下游，
   * 而且那时补出来的"提醒"多半也没有意义了。
   */
  maxCatchUpWindows: number;
  run(ctx: JobContext): Promise<JobResult>;
}

export interface JobLease {
  /** 取得独占锁；返回 false 表示别的实例在跑（§13-13）。 */
  acquire(job: string, ttlMs: number): Promise<boolean>;
  release(job: string): Promise<void>;
}

export interface JobJournal {
  /** 上次成功执行覆盖到的时间点；无记录表示从未跑过。 */
  lastSuccessTo(job: string): Promise<number | null>;
  record(job: string, ctx: JobContext, result: JobResult, durationMs: number): Promise<void>;
}

export interface JobAlerts {
  /** 连续失败超阈值时报警——**这条是三条契约里最容易被省掉的**。 */
  fire(job: string, message: string): void;
}

export interface RunOptions {
  lease: JobLease;
  journal: JobJournal;
  alerts: JobAlerts;
  now?: () => number;
  /** 连续失败多少次触发告警。 */
  alertAfterFailures?: number;
}

/**
 * 连续失败计数与最后一次错误。
 *
 * **错误原文要留着**：`runJob` 捕获窗口异常后是 `break` 而不是往外抛，
 * 于是调用方从返回值里看不出"这轮到底失败没有"——探活端点（F-32-12）要报
 * 「哪个任务在连续失败、失败在哪」，就只能从这里读。
 */
interface FailureState {
  n: number;
  message: string;
}
const failureCounters = new Map<string, FailureState>();

/**
 * 跑一次任务（含补偿）。
 *
 * 返回执行过的窗口结果数组——一次调用可能补跑多个窗口。
 */
export async function runJob(
  def: JobDefinition,
  opts: RunOptions,
): Promise<{ windows: JobResult[]; skipped?: "locked" }> {
  const now = (opts.now ?? Date.now)();

  // 互斥先于一切：拿不到锁就干脆不跑，**不是等**——
  // 等会让两个实例排队跑同一个窗口，等于串行地跑了两遍。
  if (!(await opts.lease.acquire(def.name, def.intervalMs * 2))) {
    return { windows: [], skipped: "locked" };
  }

  try {
    const lastTo = await opts.journal.lastSuccessTo(def.name);
    const windows: JobContext[] = [];

    if (lastTo === null) {
      windows.push({ from: now - def.intervalMs, to: now, isCatchUp: false });
    } else {
      let cursor = lastTo;
      let count = 0;
      while (cursor < now && count < def.maxCatchUpWindows) {
        const to = Math.min(cursor + def.intervalMs, now);
        windows.push({ from: cursor, to, isCatchUp: count > 0 || to < now });
        cursor = to;
        count += 1;
      }
      // 补偿被上限截断时**要出声**：静默少跑几个窗口 = 数据有洞却没人知道。
      if (cursor < now) {
        opts.alerts.fire(
          def.name,
          `补偿被上限截断：仍有 ${((now - cursor) / def.intervalMs).toFixed(1)} 个窗口未补（上限 ${def.maxCatchUpWindows}）`,
        );
      }
    }

    const results: JobResult[] = [];
    for (const ctx of windows) {
      const startedAt = (opts.now ?? Date.now)();
      try {
        const r = await def.run(ctx);
        await opts.journal.record(def.name, ctx, r, (opts.now ?? Date.now)() - startedAt);
        results.push(r);
        failureCounters.delete(def.name);
        if (r.failures.length > 0) {
          opts.alerts.fire(def.name, `窗口内有 ${r.failures.length} 项失败：${r.failures.slice(0, 3).join("; ")}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const n = (failureCounters.get(def.name)?.n ?? 0) + 1;
        failureCounters.set(def.name, { n, message: msg });
        // 失败**必须出声**。一个不会报警的定时任务比没有这个任务更危险。
        if (n >= (opts.alertAfterFailures ?? 3)) {
          opts.alerts.fire(def.name, `连续失败 ${n} 次：${msg}`);
        }
        // 本窗口失败即停止后续补偿——继续补只会在同一个错误上撞更多次。
        break;
      }
    }
    return { windows: results };
  } finally {
    await opts.lease.release(def.name);
  }
}

/** 测试与运维用：重置连续失败计数。 */
export function resetFailureCounter(job: string): void {
  failureCounters.delete(job);
}

/**
 * 连续失败次数与最后一次错误（探活端点用）。
 *
 * 返回 `n: 0` 表示上一轮是成功的——**不是"没跑过"**。
 * "跑没跑过"由调用方自己的 tick 记录回答，两件事不能混。
 */
export function getFailureState(job: string): { n: number; message?: string } {
  const f = failureCounters.get(job);
  return f ? { n: f.n, message: f.message } : { n: 0 };
}
