/**
 * 导游采集任务队列（ACR-008，pg-boss v12）。
 *
 * # 职责与边界
 *
 * 行程确认后把行程里的每个景点变成一个后台采集任务（调 M36 的 `runGuideBrief`），
 * 并回答前端的两个问题："每个景点处理到哪了"（状态/进度）与"这个点再来一次"（手动触发）。
 * 队列语义（持久化/重试/退避/超时接管）**全部归 pg-boss**——它建在独立的 `pgboss`
 * schema 里（spike 实测 96ms 建成、public 零污染、DROP SCHEMA 一句回滚）；
 * 本文件只做业务映射，不重造任何队列机制。
 *
 * # 为什么消费端在 agent-runtime 进程内
 *
 * 采集要驱动三个 pi 分支，而 pi 的工具调用经 `.pi/extensions` HTTP 回流到**本进程**的
 * tools-endpoint（M36-01 实证：standalone 进程承载不了 fanout）。所以 `boss.work()`
 * 就注册在这里，并发钉 1——三路 fanout 并发互挤在 M36-04 走查里真实发生过。
 *
 * # 状态从哪读（诚实优先）
 *
 * 逐景点状态 = ⑤缓存在场判定 + pg-boss 任务状态（`getJobById` 公开 API）。
 * jobId 的索引表在进程内存里——**它只是索引不是真相源**：重启后丢的只是"pending/
 * processing 的即时可见性"，任务本体仍在 pgboss 表里被继续执行、完成后缓存在场，
 * 状态自然回到 ready；短暂显示 unprocessed 时用户点「获取」会被 singletonKey
 * 去重挡住（send 返回 null → 如实报 pending），不会重复计费。
 */

import { guideBriefIsComplete } from "@carlife/shared";
import type {
  GuideBrief,
  GuideJobSpot,
  GuideJobState,
  GuideJobsStatus,
  TripPlanSnapshot,
} from "@carlife/shared";

/** 契约在 `contracts/src/domain/guide.ts`（ACR-008 步骤 2 抬入）；这里再导出供既有消费方。 */
export { guideBriefIsComplete };
export type { GuideJobSpot, GuideJobState, GuideJobsStatus };

// ── 与 pg-boss 的窄接口（构造注入，单测给假的） ────────────────

export interface BossJobView {
  state: "created" | "retry" | "active" | "completed" | "cancelled" | "failed";
  retryCount?: number;
}

/** 本模块用到的 pg-boss 面。字段名与 v12 公开 API 一致，不做任何改写。 */
export interface BossLike {
  start(): Promise<unknown>;
  stop(opts?: { graceful?: boolean }): Promise<void>;
  createQueue(name: string): Promise<void>;
  send(
    name: string,
    data: object,
    options?: {
      singletonKey?: string;
      retryLimit?: number;
      retryDelay?: number;
      expireInSeconds?: number;
    },
  ): Promise<string | null>;
  work(
    name: string,
    options: { batchSize?: number; pollingIntervalSeconds?: number },
    handler: (jobs: Array<{ id: string; data: unknown }>) => Promise<void>,
  ): Promise<string>;
  getJobById(name: string, id: string): Promise<BossJobView | null>;
}

export interface GuideCollectInput {
  spotName: string;
  city?: string;
  date?: string;
  selfDrive?: boolean;
  /** 同行程的其他景点名（小景点不拆 + 跨页去重，见 subgraphs/guide.ts 的 GuideInput）。 */
  siblingSpots?: string[];
  /** 行程中紧邻之前的一站（到达面写衔接不写全套出发，见 GuideInput.prevSpot）。 */
  prevSpot?: string;
  /** 是否行程最后一站（返程补能只在这里写）。 */
  isLastStop?: boolean;
  /** 强制重采（「重新采集」）：跳过持久层与缓存读取。 */
  force?: boolean;
}

export interface GuideQueueDeps {
  /** 采集本体：index.ts 注入的 `runGuideBrief` 闭包（带 ACP streamer 与计价）。 */
  collect: (input: GuideCollectInput) => Promise<{ brief: GuideBrief; cached: boolean }>;
  /** ⑤缓存在场判定：键与 `subgraphs/guide.ts` 的 `envCacheKey("guide-brief", …)` 同源。 */
  hasCached: (spotName: string, city?: string) => Promise<boolean>;
  boss: BossLike;
}

export const GUIDE_QUEUE_NAME = "guide-brief";

/**
 * 每次执行的接管上限（秒）。fanout 分支硬超时 90s + 汇聚余量；超过即视为该次
 * 执行死掉，pg-boss 按 retryLimit 决定重试或判 failed——没有它，一次进程内
 * 悬死会让任务永远显示 processing。
 */
const EXPIRE_IN_SECONDS = 180;
/** 失败自动重试一次、隔 60s（避开瞬时的搜索侧抖动）；再失败交给用户手动「获取」。 */
const RETRY_LIMIT = 1;
const RETRY_DELAY_SECONDS = 60;

/** 队列键：与⑤缓存键同一构成（城市 + 景区名），同一景区谁触发都是同一个任务。 */
function jobKey(input: GuideCollectInput): string {
  return `${input.city ?? "-"}:${input.spotName}`;
}

/** 从行程快照提取要采集的景点（跨天去重，保序）。 */
export function planSpots(plan: TripPlanSnapshot): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const day of plan.skeleton ?? []) {
    for (const s of day.spots ?? []) {
      const name = s.name?.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

export interface GuideQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 行程确认/变更后调用：逐景点入队（已缓存的跳过——那正是"确认即预采集"要省下的钱）。 */
  enqueuePlan(plan: TripPlanSnapshot): Promise<{ enqueued: number; skipped: number }>;
  /** 手动「获取」：单景点入队。返回入队后该点的即时状态。 */
  enqueueSpot(input: GuideCollectInput): Promise<GuideJobSpot>;
  /** 前端的进度/状态：按行程逐景点回答。 */
  statusForPlan(plan: TripPlanSnapshot): Promise<GuideJobsStatus>;
}

export function createGuideQueue(deps: GuideQueueDeps): GuideQueue {
  const { boss, collect, hasCached } = deps;
  /** jobKey → jobId 的进程内索引（见文件头：索引不是真相源）。 */
  const jobIndex = new Map<string, string>();
  let started = false;

  async function ensureStarted(): Promise<void> {
    if (started) return;
    await boss.start();
    await boss.createQueue(GUIDE_QUEUE_NAME);
    await boss.work(GUIDE_QUEUE_NAME, { batchSize: 1, pollingIntervalSeconds: 2 }, async (jobs) => {
      // batchSize=1：一次一个任务、一个任务内部才是三分支并行——并发 fanout 互挤
      // 是 M36-04 真实病例，这里是第二道闸（第一道是 runGuideBrief 的同键单飞）。
      for (const job of jobs) {
        const input = job.data as GuideCollectInput;
        const { brief } = await collect(input);
        if (!guideBriefIsComplete(brief)) {
          // 抛错让 pg-boss 记 retry/failed——半成品不许静默算完成。
          throw new Error(`采集不完整（${input.spotName}）：有分支缺席或无必玩点`);
        }
      }
    });
    started = true;
  }

  async function stateOf(input: GuideCollectInput): Promise<GuideJobSpot> {
    const spotName = input.spotName;
    const id = jobIndex.get(jobKey(input));
    if (id) {
      const job = await boss.getJobById(GUIDE_QUEUE_NAME, id);
      if (job) {
        switch (job.state) {
          case "created":
          case "retry":
            return { spotName, state: "pending" };
          case "active":
            return { spotName, state: "processing" };
          case "completed":
            return { spotName, state: "ready", cached: true };
          case "cancelled":
          case "failed":
            return { spotName, state: "failed", note: "这次没查成，可点「获取」再试" };
        }
      }
    }
    // 没有（或已失去）任务索引：以⑤缓存在场为准——它才是"点开有没有东西"的真相。
    if (await hasCached(spotName, input.city)) {
      return { spotName, state: "ready", cached: true };
    }
    return { spotName, state: "unprocessed" };
  }

  return {
    async start() {
      await ensureStarted();
    },

    async stop() {
      if (!started) return;
      started = false;
      await boss.stop({ graceful: false });
    },

    async enqueuePlan(plan) {
      await ensureStarted();
      let enqueued = 0;
      let skipped = 0;
      const names = planSpots(plan);
      for (const [idx, spotName] of names.entries()) {
        const input: GuideCollectInput = {
          spotName,
          ...(plan.destination ? { city: plan.destination } : {}),
          ...(plan.startDate ? { date: plan.startDate } : {}),
          selfDrive: true,
          // 兄弟景点与行程位置随任务入库：worker 重启后从 pgboss 表捞出的任务也带着
          siblingSpots: names.filter((n) => n !== spotName),
          ...(idx > 0 ? { prevSpot: names[idx - 1]! } : {}),
          ...(idx === names.length - 1 ? { isLastStop: true } : {}),
        };
        if (await hasCached(spotName, input.city)) {
          skipped += 1; // 已有缓存内容（TTL 见 ENV_TTL.guideBrief）——预采集要省的正是这笔按次计费
          continue;
        }
        const id = await boss.send(GUIDE_QUEUE_NAME, input, {
          singletonKey: jobKey(input),
          retryLimit: RETRY_LIMIT,
          retryDelay: RETRY_DELAY_SECONDS,
          expireInSeconds: EXPIRE_IN_SECONDS,
        });
        if (id) {
          jobIndex.set(jobKey(input), id);
          enqueued += 1;
        } else {
          skipped += 1; // singletonKey 去重：同景区已在队里
        }
      }
      return { enqueued, skipped };
    },

    async enqueueSpot(input) {
      await ensureStarted();
      const key = jobKey(input);
      const prior = await stateOf(input);
      // ready/processing/pending 时不重复入队：手动「获取」语义只补"没有或失败"。
      if (prior.state === "ready" || prior.state === "processing" || prior.state === "pending") {
        return prior;
      }
      const id = await boss.send(GUIDE_QUEUE_NAME, input, {
        singletonKey: key,
        retryLimit: RETRY_LIMIT,
        retryDelay: RETRY_DELAY_SECONDS,
        expireInSeconds: EXPIRE_IN_SECONDS,
      });
      if (id) {
        jobIndex.set(key, id);
        return { spotName: input.spotName, state: "pending" };
      }
      // send=null：singletonKey 撞上（重启后索引丢失但任务还在队里的病例）——如实报 pending。
      return { spotName: input.spotName, state: "pending" };
    },

    async statusForPlan(plan) {
      await ensureStarted();
      const spots: GuideJobSpot[] = [];
      for (const spotName of planSpots(plan)) {
        spots.push(
          await stateOf({
            spotName,
            ...(plan.destination ? { city: plan.destination } : {}),
          }),
        );
      }
      const summary = { total: spots.length, ready: 0, processing: 0, pending: 0, failed: 0, unprocessed: 0 };
      for (const s of spots) {
        if (s.state === "ready") summary.ready += 1;
        else if (s.state === "processing") summary.processing += 1;
        else if (s.state === "pending") summary.pending += 1;
        else if (s.state === "failed") summary.failed += 1;
        else summary.unprocessed += 1;
      }
      return { spots, summary };
    },
  };
}
