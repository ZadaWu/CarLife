/**
 * 任务告警出口（施工单 M7-05，FL-32 F-32-07）。
 *
 * **不为 worker 单建一套监控**（FL-32 技术选型原文）：告警复用 `trace/` 的事件流，
 * 与在线链路的埋点落在同一张表、同一个回放入口。运营查"守夜人昨晚出过什么事"
 * 和查"某轮对话为什么降级"用的是同一个地方。
 *
 * # 为什么 stderr 也要写一份
 *
 * trace 是异步入队的（`write` 承诺永不抛错，失败自己吞掉）。如果数据库正是
 * 故障源，告警会连同故障一起消失——**一个不会报警的定时任务比没有这个任务更危险**，
 * 那么一个在数据库挂掉时静默的告警通道同样危险。stderr 这条兜底不依赖任何组件。
 */

import { getPrisma, createTraceRepository, type TraceRepository } from "@carlife/db";

export interface JobAlerts {
  fire(job: string, message: string): void;
}

/** trace 事件里 worker 告警统一用这个 kind，回放页按它筛。 */
export const WORKER_ALERT_KIND = "worker.alert";

/**
 * worker 没有 sessionId（它不服务于某一轮对话），但 trace 表要求这个字段。
 * 用固定值而不是空串：回放页按 sessionId 分组，空串会和其它无主事件混在一起。
 */
export const WORKER_TRACE_SESSION = "system:worker";

export function createJobAlerts(trace?: TraceRepository): JobAlerts {
  const sink = trace ?? createTraceRepository(getPrisma());
  return {
    fire(job, message) {
      // 兜底通道先走，确保即使 trace 写入失败也留下了痕迹
      console.error(`[worker:alert] ${job} — ${message}`);
      sink.write({
        sessionId: WORKER_TRACE_SESSION,
        kind: WORKER_ALERT_KIND,
        at: Date.now(),
        data: { job, message },
      });
    },
  };
}

/** 测试与本地演练用：只打 stderr，不碰数据库。 */
export function createConsoleAlerts(): JobAlerts {
  return {
    fire(job, message) {
      console.error(`[worker:alert] ${job} — ${message}`);
    },
  };
}
