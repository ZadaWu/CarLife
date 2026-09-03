/**
 * worker 的探活端点（F-32-12 调度器心跳/看门狗）。
 *
 * # 为什么非要开一个端口
 *
 * worker 原本靠 PG 里的租约与 `job_runs` 留痕被间接判定死活。那套证据的时间粒度
 * 是**任务粒度**，而最密的 cron 也是小时级——于是"刚起来的 worker"和"根本没起的
 * worker"在留痕上完全一样：两者都是"上次留痕 N 小时前"。2026-08-27 实测正是如此，
 * 进程在跑（4 个任务已挂上调度），`/system` 却写着「上次留痕已是 1 天前」。
 *
 * **把"进程活着"和"任务跑过"分成两种证据**，这个端点只回答前者：它一定是实时的，
 * 因为答话的就是那个进程本身。后者仍由留痕回答，两者在网关那侧合成一张卡。
 *
 * # 响应了也未必健康
 *
 * 与 runtime 的 `/internal/health/runtime` 同一套契约：**200 表示"我还在"，
 * `risks` 非空表示"我在，但有问题"**。连续失败的任务、没挂上调度的任务都进 risks，
 * 由网关染黄。把它们塞进 500 会让"进程死了"和"某个任务在报错"变成同一副面孔。
 *
 * # 不引 express
 *
 * worker 的依赖表里没有 HTTP 框架，为一个只读端点加一个不该属于 cron 进程的依赖
 * 不划算。`node:http` 够用。
 */

import { createServer, type Server } from "node:http";

/** 一次 tick 的结局。`locked` 不是失败——那是另一实例在跑（并发互斥生效）。 */
export type TickOutcome = "ok" | "failed" | "locked";

export interface JobTick {
  at: number;
  outcome: TickOutcome;
  durationMs: number;
  /** 本次跑过几个窗口（含补偿）。 */
  windows?: number;
  processed?: number;
  changed?: number;
  deleted?: number;
  failures?: number;
  error?: string;
}

export interface JobHealth {
  job: string;
  cron: string;
  /** 本进程起来之后跑过的最后一次；从没跑过时是 undefined——**不许拿留痕顶替**，
      那是另一种证据（见文件头）。 */
  lastTick?: JobTick;
  /** 连续失败次数。达阈值即进 risks。 */
  consecutiveFailures: number;
}

/**
 * 调度器的实时状态。`index.ts` 建一份，挂上调度时登记、每次 tick 后回写。
 *
 * 刻意是可变对象而不是快照函数：端点要读的就是"此刻"，
 * 而快照一旦缓存就会出现"页面说在跑，其实早停了"的错觉。
 */
export interface SchedulerState {
  holder: string;
  startedAt: number;
  jobs: Map<string, JobHealth>;
  /** 装配失败、没能挂上调度的任务（名字 + 原因）。它们不会有任何 tick。 */
  skipped: string[];
}

export function createSchedulerState(holder: string, startedAt: number): SchedulerState {
  return { holder, startedAt, jobs: new Map(), skipped: [] };
}

/** 连续失败多少次算 risk。与 job-runner 的告警阈值同一个数——两处对不上会出现"报警了但页面是绿的"。 */
export const RISK_AFTER_FAILURES = 3;

export interface WorkerHealthPayload {
  ok: true;
  service: "worker";
  holder: string;
  startedAt: string;
  uptimeSec: number;
  jobs: JobHealth[];
  skipped: string[];
  /** 空数组才是"可以不用管"的状态（与 runtime 健康视图同一判据）。 */
  risks: string[];
}

export function buildHealthPayload(state: SchedulerState, now: number): WorkerHealthPayload {
  const jobs = [...state.jobs.values()];
  const risks: string[] = [];

  for (const j of jobs) {
    if (j.consecutiveFailures >= RISK_AFTER_FAILURES) {
      risks.push(`${j.job} 连续失败 ${j.consecutiveFailures} 次：${j.lastTick?.error ?? "原因见日志"}`);
    }
  }
  for (const s of state.skipped) risks.push(`未挂上调度：${s}`);
  // 一个任务都没挂上 = 进程活着但什么也不会做。这比某个任务失败更严重，且极易被
  // "端口通了"骗过去——explicitly 报出来。
  if (jobs.length === 0) risks.push("没有任何任务挂上调度（进程活着但不会做事）");

  return {
    ok: true,
    service: "worker",
    holder: state.holder,
    startedAt: new Date(state.startedAt).toISOString(),
    uptimeSec: Math.floor((now - state.startedAt) / 1000),
    jobs,
    skipped: state.skipped,
    risks,
  };
}

/**
 * 起一个只读的健康端点。`GET /health`（以及 `/` 同义）返回上面的 payload，
 * 其余路径 404。
 *
 * **不暴露任何可写动作**：手动触发任务走 `--once`，那是有副作用的命令行操作，
 * 不该挂在一个谁都能 curl 的端口上。
 */
export function createHealthServer(
  state: SchedulerState,
  now: () => number = Date.now,
): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET" || (path !== "/health" && path !== "/")) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const body = JSON.stringify(buildHealthPayload(state, now()));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
  });
}
