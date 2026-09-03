/**
 * worker 调度入口（施工单 M7-05，FL-32）。
 *
 * 五个任务（memory-decay / usage-aggregation / kb-sync / vehicle-reminder /
 * session-sweeper）挂在 node-cron 上，
 * 每次触发都经 `runJob` —— 三条运行契约（幂等 / 可补偿 / 失败要出声）由它统一保证，
 * 任务本体只管自己那点业务。
 *
 * # 调度器与任务是两层，不能合并
 *
 * cron 表达式决定"什么时候敲门"，`JobDefinition.intervalMs` 决定"一个窗口有多长"。
 * 两者刻意分开：补偿逻辑按窗口算，如果直接拿 cron 周期当窗口，
 * 改一次 cron 表达式就会让历史窗口的边界全部错位（F-32-11 的时区口径同理）。
 *
 * # 启动即自检，缺依赖直接不挂
 *
 * 一个连不上 Mem0 的聚合任务每小时失败一次、告警刷屏，比压根没启动更难排查。
 * 因此装配失败的任务**不进调度表**并在启动日志里点名，其余任务照常跑
 * （kb-sync 缺 RAGFLOW 配置不该拖垮 usage-aggregation）。
 *
 * # 进程活着 ≠ 任务跑过（F-32-12）
 *
 * 这两件事以前混在一起：worker 没有端口，`/system` 只能拿 `job_runs` 留痕反推死活，
 * 而最密的 cron 也是小时级——"刚起来的 worker"和"根本没起的 worker"在留痕上一模一样。
 * 现在分成两种证据：`./health` 的端口回答"进程此刻在不在"（实时，答话的就是本进程），
 * 留痕继续回答"任务最近跑过没有"。网关把两者合成一张卡。
 */

import { hostname } from "node:os";

import cron from "node-cron";
import { getPrisma, createJobRepository } from "@carlife/db";

import { getFailureState, runJob, type JobDefinition, type RunOptions } from "./job-runner";
import {
  createHealthServer,
  createSchedulerState,
  type SchedulerState,
  type TickOutcome,
} from "./health";
import { createJobAlerts } from "./alerts";
import { memoryDecayJob } from "./memory-decay";
import { usageAggregationJob } from "./usage-aggregation";
import { kbSyncJob } from "./kb-sync";
import { vehicleReminderJob } from "./vehicle-reminder";
import { sessionSweeperJob } from "./session-sweeper";

/** 本实例标识，进租约表用于诊断"是谁占着"。 */
const HOLDER = `${hostname()}:${process.pid}`;

/**
 * 探活端口（F-32-12）。
 *
 * worker 曾经是这套服务里唯一没有端口的进程，死活只能从 PG 留痕反推——而留痕
 * 的粒度是小时级 cron，于是"刚起来"和"没起来"长得一模一样（2026-08-27 实测：
 * 进程在跑，`/system` 却写「上次留痕已是 1 天前」）。开一个只读端口把这两件事分开。
 */
const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 8796);

/**
 * 各任务的 cron 表达式。
 *
 * 聚合放在整点后 5 分钟：让上一小时的流水先落全，避免每次都在窗口边界上
 * 少算最后几条（时区口径见 F-32-11，统一用容器的 TZ）。
 * 衰减与提醒放在凌晨低峰——衰减要全量扫 Mem0，提醒要遍历全部车辆。
 */
const SCHEDULE: Record<string, string> = {
  "usage-aggregation": "5 * * * *",
  "kb-sync": "20 * * * *",
  "memory-decay": "30 3 * * *",
  "vehicle-reminder": "0 8 * * *",
  /*
   * 空闲空会话的兜底收口（M50-03）。放 15 分：与聚合（5 分）、知识库（20 分）
   * 岔开，三个整点后的任务不要挤在同一分钟里争数据库。
   * 小时级足够——它清的是"已经没人再碰"的会话，晚一小时没有任何影响。
   */
  "session-sweeper": "15 * * * *",
};

const JOBS: JobDefinition[] = [
  usageAggregationJob,
  kbSyncJob,
  memoryDecayJob,
  vehicleReminderJob,
  sessionSweeperJob,
];

export function buildRunOptions(): RunOptions {
  const repo = createJobRepository(getPrisma());
  const alerts = createJobAlerts();
  return {
    lease: {
      acquire: (job, ttlMs) => repo.acquire(job, ttlMs, HOLDER),
      release: (job) => repo.release(job, HOLDER),
    },
    journal: {
      lastSuccessTo: (job) => repo.lastSuccessTo(job),
      record: (job, ctx, result, durationMs) =>
        repo.record({
          job,
          windowFrom: ctx.from,
          windowTo: ctx.to,
          isCatchUp: ctx.isCatchUp,
          processed: result.processed,
          changed: result.changed,
          deleted: result.deleted,
          failures: result.failures,
          durationMs,
        }),
    },
    alerts,
  };
}

/** 跑一个任务并把结果打到日志（P-09 的日志样例格式：处理/变更/删除/耗时）。 */
export async function tick(
  def: JobDefinition,
  opts: RunOptions,
  state?: SchedulerState,
): Promise<void> {
  const startedAt = Date.now();
  /**
   * 回写探活状态。
   *
   * **`runJob` 的返回值看不出失败**：窗口内抛错时它是 `break` 而不是往外抛，
   * 所以这里的结局判定要读 `getFailureState`——只看返回值会把一个连续报错的任务
   * 报成 ok，那正是"页面绿着、任务其实死了"的经典形状。
   */
  const mark = (outcome: TickOutcome, extra: Record<string, number | string | undefined> = {}): void => {
    const entry = state?.jobs.get(def.name);
    if (!entry) return;
    const f = getFailureState(def.name);
    entry.consecutiveFailures = f.n;
    entry.lastTick = {
      at: startedAt,
      outcome,
      durationMs: Date.now() - startedAt,
      error: outcome === "failed" ? f.message : undefined,
      ...extra,
    };
  };

  try {
    const { windows, skipped } = await runJob(def, opts);
    if (skipped === "locked") {
      // 不是错误：另一个实例正在跑。记一行便于回答"为什么这轮没动静"。
      console.log(`[worker] ${def.name} 跳过：另一实例持有租约`);
      mark("locked");
      return;
    }
    const total = windows.reduce(
      (acc, w) => ({
        processed: acc.processed + w.processed,
        changed: acc.changed + w.changed,
        deleted: acc.deleted + w.deleted,
        failures: acc.failures + w.failures.length,
      }),
      { processed: 0, changed: 0, deleted: 0, failures: 0 },
    );
    console.log(
      `[worker] ${def.name} 完成：窗口 ${windows.length}，处理 ${total.processed}，` +
        `变更 ${total.changed}，删除 ${total.deleted}，失败 ${total.failures}，耗时 ${Date.now() - startedAt}ms`,
    );
    mark(getFailureState(def.name).n > 0 ? "failed" : "ok", {
      windows: windows.length,
      processed: total.processed,
      changed: total.changed,
      deleted: total.deleted,
      failures: total.failures,
    });
  } catch (err) {
    // runJob 内部已按"连续失败达阈值"告警，这里只补一行可读日志。
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] ${def.name} 异常：${msg}`);
    const entry = state?.jobs.get(def.name);
    if (entry) {
      // 走到这里是租约/留痕层面的异常（不是任务本体），`getFailureState` 不会计数，
      // 所以错误原文只能从这里带上，否则探活端点会报一个没有理由的失败。
      entry.lastTick = {
        at: startedAt,
        outcome: "failed",
        durationMs: Date.now() - startedAt,
        error: msg,
      };
      entry.consecutiveFailures = Math.max(entry.consecutiveFailures, getFailureState(def.name).n, 1);
    }
  }
}

export function start(): void {
  const opts = buildRunOptions();
  const state = createSchedulerState(HOLDER, Date.now());
  const scheduled: string[] = [];

  for (const def of JOBS) {
    const expr = SCHEDULE[def.name];
    if (!expr) {
      state.skipped.push(`${def.name}（无 cron 表达式）`);
      continue;
    }
    try {
      // 装配自检：先构造一次依赖，构造不出来的任务不进调度表。
      // kb-sync 缺 RAGFLOW 配置会在这里抛出，不影响其余三个。
      void def.run;
      cron.schedule(expr, () => void tick(def, opts, state));
      state.jobs.set(def.name, { job: def.name, cron: expr, consecutiveFailures: 0 });
      scheduled.push(`${def.name} @ ${expr}`);
    } catch (err) {
      state.skipped.push(`${def.name}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }

  console.log(`[worker] 已调度 ${scheduled.length} 个任务：\n  ${scheduled.join("\n  ")}`);
  if (state.skipped.length) {
    console.warn(`[worker] 未调度 ${state.skipped.length} 个任务：\n  ${state.skipped.join("\n  ")}`);
  }

  /*
   * 探活端口放在调度登记之后起：先有 jobs 再对外应答，避免大屏在启动的头几毫秒
   * 读到一份"零任务"的 payload 而误报 risk。
   *
   * 端口被占用时**不退出进程**——定时任务本身照跑，丢的只是可观测性；
   * 但要吼一声，否则表现就是"页面永远说 worker 没起"而任务其实在跑，
   * 那比没有这个端点更误导。
   */
  const server = createHealthServer(state);
  server.on("error", (err) => {
    console.error(`[worker] ⚠️ 探活端口 :${HEALTH_PORT} 起不来（任务照常跑，但 /system 会报未启用）：${err.message}`);
  });
  server.listen(HEALTH_PORT, () => {
    console.log(`[worker] 探活端点 http://localhost:${HEALTH_PORT}/health（holder=${HOLDER}）`);
  });
}

/** 一次性手动执行（运维/演练）：`tsx src/index.ts --once <job>`。 */
export async function runOnce(name: string): Promise<void> {
  const def = JOBS.find((j) => j.name === name);
  if (!def) {
    console.error(`[worker] 未知任务：${name}。可选：${JOBS.map((j) => j.name).join(" / ")}`);
    process.exitCode = 1;
    return;
  }
  await tick(def, buildRunOptions());
}

// 直接执行本文件时启动调度；被 import 时（测试）不启动。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/services)/, ""))) {
  const onceIndex = process.argv.indexOf("--once");
  if (onceIndex >= 0) {
    void runOnce(process.argv[onceIndex + 1] ?? "").then(() => process.exit(process.exitCode ?? 0));
  } else {
    start();
  }
}

export { JOBS, SCHEDULE, HOLDER, HEALTH_PORT };
