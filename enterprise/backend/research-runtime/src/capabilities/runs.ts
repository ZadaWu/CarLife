/**
 * `✎` / `💬` 层能力的**运行台账**（施工单 M85-06）。进程内，不落库。
 *
 * # 为什么不复用图的检查点
 *
 * `runState` 今天读的是 LangGraph 的检查点表——那是整张研究图的状态。
 * 一次 C1 只归纳一格，它不是图的一次运行，没有 thread、没有节点、没有 `interrupt()`。
 * 硬塞进图里的代价是：`review` 面会多出一堆停不下来的线程，
 * 而 `GET review` 是人工评审的入口。
 *
 * # 为什么可以只在内存里
 *
 * 这里存的是**进度**，不是产出。产出（洞察卡）在 `research_insights` 里，
 * 重启后照样查得到。重启丢的只有"那次点击跑到哪一步了"——
 * 界面此时会看到 404 `run_not_found`（`handleRunStream` 的既有分支），
 * 那句话是准确的：这个运行记录确实没了。
 *
 * **不要为此加一张表**：一张记进度的表要被清理、要被迁移、要被备份，
 * 而它的全部价值在那 10–60 秒里。
 *
 * # 阶段名与图的 `stage` 共用一个字段，是有意的
 *
 * `RunState` 是运行流唯一认识的形状。两套形状就会有两套前端渲染分支，
 * 而面板上那几行字对用户来说没有区别——都是"它现在在干什么"。
 */

import { randomUUID } from "node:crypto";

import type { RunState } from "../internal-api/run-stream";

/** 跑完多久之后从内存里清掉。界面收到 `done` 就不再轮询，留 10 分钟够回看了。 */
export const RUN_TTL_MS = 10 * 60_000;

/** 终态阶段名。与 `run-stream.ts` 的 `isTerminalStage` 同一个字面量。 */
export const DONE_STAGE = "done";

export interface CapabilityRunRecord {
  runId: string;
  capability: string;
  stage: string;
  notes: string[];
  /** 失败原因。**原样保留服务端说的那句**，不换成「运行失败请重试」。 */
  error?: string;
  /** 产出。C1 是写进去的洞察 id 列表。 */
  result?: unknown;
  startedAt: number;
  endedAt?: number;
  usage: { totalTokens: number; models: string[] } | null;
}

export interface CapabilityRuns {
  start(capability: string): CapabilityRunRecord;
  /** 推一句人话进度。`stage` 给了就顺便换档。 */
  note(runId: string, note: string, stage?: string): void;
  addUsage(runId: string, totalTokens: number, model: string): void;
  fail(runId: string, message: string): void;
  finish(runId: string, result: unknown, note?: string): void;
  get(runId: string): CapabilityRunRecord | null;
  /** 运行流要的形状。不认识这个 id 就回 null，让它回 404。 */
  state(runId: string): RunState | null;
}

export function createCapabilityRuns(opts: { ttlMs?: number; now?: () => number } = {}): CapabilityRuns {
  const ttl = opts.ttlMs ?? RUN_TTL_MS;
  const now = opts.now ?? Date.now;
  const runs = new Map<string, CapabilityRunRecord>();

  /*
   * 每次读写顺手清一遍。起一个 setInterval 的话，这个模块就有了一条
   * 进程生命周期内一直活着的定时器——测试里必须记得关掉它，忘了就是句柄泄漏。
   */
  const prune = (): void => {
    const t = now();
    for (const [id, r] of runs) {
      if (r.endedAt !== undefined && t - r.endedAt > ttl) runs.delete(id);
    }
  };

  const touch = (runId: string): CapabilityRunRecord | null => runs.get(runId) ?? null;

  return {
    start(capability) {
      prune();
      const rec: CapabilityRunRecord = {
        runId: `cap-${randomUUID()}`,
        capability,
        stage: "starting",
        notes: [],
        startedAt: now(),
        usage: null,
      };
      runs.set(rec.runId, rec);
      return rec;
    },

    note(runId, note, stage) {
      const r = touch(runId);
      if (!r) return;
      r.notes.push(note);
      if (stage) r.stage = stage;
    },

    /**
     * 用量累加，模型名去重。
     *
     * 累加而不是覆盖：一格下有几个主题就调几次模型，
     * 只记最后一次的话界面上那个数字会比真实花费小一截，而它看起来很正常。
     */
    addUsage(runId, totalTokens, model) {
      const r = touch(runId);
      if (!r) return;
      const prev = r.usage ?? { totalTokens: 0, models: [] as string[] };
      r.usage = {
        totalTokens: prev.totalTokens + totalTokens,
        models: prev.models.includes(model) ? prev.models : [...prev.models, model],
      };
    },

    fail(runId, message) {
      const r = touch(runId);
      if (!r) return;
      r.error = message;
      r.stage = DONE_STAGE;
      r.endedAt = now();
    },

    finish(runId, result, note) {
      const r = touch(runId);
      if (!r) return;
      if (note) r.notes.push(note);
      r.result = result;
      r.stage = DONE_STAGE;
      r.endedAt = now();
    },

    get(runId) {
      prune();
      return touch(runId);
    },

    state(runId) {
      prune();
      const r = touch(runId);
      if (!r) return null;
      return { stage: r.stage, notes: r.notes, pending: [], error: r.error, result: r.result };
    },
  };
}
