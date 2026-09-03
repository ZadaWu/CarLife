/**
 * 导览任务面板的共享纯逻辑（M40-02 落、M40-03 复用）。
 *
 * 只有纯函数——fetch/invoke/计时器归两端接线。抽到 `clients/shared/ui` 是因为
 * 节流与乐观规则两端必须一字一样（总览约束 1/2），各写一份必然漂移。
 */

import type { GuideJobState, GuideJobsStatus } from "@carlife/shared";

const TERMINAL: ReadonlySet<GuideJobState> = new Set(["ready", "failed", "unprocessed"]);

/** 轮询间隔（毫秒）。 */
export const GUIDE_JOBS_POLL_MS = 10_000;

/**
 * 这一轮该不该继续轮询：有在途任务（pending/processing）才轮——
 * 全终态还在打的轮询是纯浪费（服务端虽是快路径，但 10s 一发永不停也是账）。
 * `jobs === null`（还没拿到第一份 / 队列关着）不轮：第一份由挂载时的一次性拉取负责。
 */
export function shouldPollGuideJobs(jobs: GuideJobsStatus | null): boolean {
  if (!jobs) return false;
  return jobs.summary.pending + jobs.summary.processing > 0;
}

/**
 * 只留"还没完事"的行：unprocessed/pending/processing/failed 留下，ready 去掉。
 *
 * 给车机 HUD 那张小卡用——它是"后台还欠我什么"的待办条，不是导览索引：
 * 采完的景点留在卡上只会把还没采的挤下去，而 ready 的入口在地图标记上本来就有。
 * **summary 原样带过**（进度头照旧显示 x/N 就绪）：过滤是显示口径，不是重算账本，
 * 服务端账本仍是唯一真相源。全都 ready 时 spots 为空，面板自己渲染成 null。
 * 没有 ready 行时返回原对象（引用相等，不触发无谓重渲染）。
 */
export function outstandingGuideJobs(jobs: GuideJobsStatus): GuideJobsStatus {
  const spots = jobs.spots.filter((s) => s.state !== "ready");
  if (spots.length === jobs.spots.length) return jobs;
  return { spots, summary: jobs.summary };
}

/**
 * 导览已就绪的景点名（state=ready）——给主页地图的景点胶囊挂「✓ 导览」角标用。
 *
 * 判据只认服务端账本里的 ready：pending/processing 是"快了"不是"能看"，
 * 标上去就是把半成品说成已就绪（与 guideBriefIsComplete 那条同一个原则）。
 * `jobs === null`（没确认的行程 / 队列关着）→ 空数组，主页一个都不标。
 * 顺序保持账本顺序；地图侧按名字查集合，顺序不影响画面。
 */
export function readyGuideSpots(jobs: GuideJobsStatus | null): string[] {
  if (!jobs) return [];
  return jobs.spots.filter((s) => s.state === "ready").map((s) => s.spotName);
}

/**
 * 点「获取导览」后的乐观置位：该行立即 pending（按了要有反应），
 * summary 同步搬账——数字与行对不上会被面板如实渲染出来（那是它的设计）。
 * 只对 unprocessed/failed 行生效；其余状态原样返回（按钮本就不该在那些行上）。
 */
export function applyGuideFetchOptimistic(
  jobs: GuideJobsStatus,
  spotName: string,
): GuideJobsStatus {
  const row = jobs.spots.find((s) => s.spotName === spotName);
  if (!row || !TERMINAL.has(row.state) || row.state === "ready") return jobs;
  const from = row.state as "failed" | "unprocessed";
  return {
    spots: jobs.spots.map((s) =>
      s.spotName === spotName ? { spotName: s.spotName, state: "pending" } : s,
    ),
    summary: {
      ...jobs.summary,
      pending: jobs.summary.pending + 1,
      [from]: jobs.summary[from] - 1,
    },
  };
}
