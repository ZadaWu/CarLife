/**
 * 上下文装载层的入口（施工单 M84-03，ACR-036 §4.9）。
 *
 * # 它是 harness 的一部分，不是图的一部分
 *
 * `TurnRunner` 在图执行**之前**把这一轮该知道的事实取好、按 Agent 摆好位置，
 * 经 `configurable.turnContext` 交给图；图节点只读，不自己去查库。
 * 这与编程 harness 每轮注入环境状态是同一件事——状态由系统给，不由 agent 自己维护。
 *
 * # 三档开关
 *
 * - `off`：不装载、不注入，三条链路的 prompt 逐字等于从前（退到底的那一档）。
 * - `inject`：装载并注入，但图状态一字不动（行程仍读 `state.tripPlan`）。
 * - `tasks`（**M84-05 起的缺省**）：行程改读任务状态、旧通道停写。
 *
 * 逐级打开、逐级可退，每一档单独能跑完一轮真实对话。
 */

import { CONTEXT_BLOCK_HEADER, type TaskKind, type TaskState, type UserContext } from "@carlife/shared";

import { holidayLine } from "../holidays";
import { AnchorPins, anchorDeltaLine } from "./anchor";
import { assembleUserContext, type UserContextReaders } from "./assemble";
import { getContextCache, type ContextCache } from "./cache";
import {
  NO_TASK_WRITER,
  createTaskWriter,
  loadActiveTasks,
  taskPendingLine,
  taskStatusLine,
  type ActiveTasks,
  type TaskReader,
  type TaskWriter,
} from "./tasks";
import { aclFor, renderTurn, type TurnFact } from "./render";

export type ContextLayerMode = "off" | "inject" | "tasks";

/**
 * 开关。**在调用时读 `process.env`**，不在模块级——`check:arch` 的 env-timing 不变量
 * 禁止服务的非入口模块在模块级读环境变量。
 *
 * 缺省自 M84-05 起是 `tasks`（此前是 `off`）：三档逐级验过之后，新机制才成为默认。
 * 退档拨这一项即可，不用发版；**退之前先跑 `release:context-downgrade --apply`**——
 * `tasks` 期间的草案只在 `working_tasks` 里，直接拨回去它们会"消失"（不是丢，是读错地方）。
 *
 * 取值非法时回落 `tasks` 而不是 `off`：拼错一个字母就悄悄退回旧机制，是那种
 * "配置手滑让整套新行为静默失效"的默认值。
 */
export function contextLayerMode(env: NodeJS.ProcessEnv = process.env): ContextLayerMode {
  const raw = (env.CARLIFE_CONTEXT_LAYER ?? "tasks").toLowerCase();
  if (raw === "off" || raw === "inject" || raw === "tasks") return raw;
  console.warn(`[context] CARLIFE_CONTEXT_LAYER=${raw} 不是合法取值（off / inject / tasks），按 tasks 处理`);
  return "tasks";
}

/** 一轮的上下文。图节点只读它，不改它。 */
export interface TurnContext {
  mode: Exclude<ContextLayerMode, "off">;
  userId?: string;
  threadId: string;
  now: number;
  user: UserContext;
  tasks: ActiveTasks;
  /**
   * 任务的写入口（M84-04）。**图节点只调它，不碰仓储**。
   * `inject` 档下是空实现——那一档只读不写。
   */
  writer: TaskWriter;
  /**
   * 本轮尾区的公共事实行（日期 / 里程新鲜度 / 任务状态行 / 追问候选）。
   * `turnFor` 在它之上再加调用方给的 extra；只读，供轨迹落点原样记下。
   */
  facts: readonly TurnFact[];
  /** 锚定块与本轮尾区的渲染器，按 Agent 取。 */
  anchorFor(agent: string): string | undefined;
  turnFor(agent: string, extra?: readonly TurnFact[]): string | undefined;
}

export interface TurnContextDeps {
  readers: UserContextReaders;
  taskReader?: TaskReader;
  cache?: ContextCache;
  pins: AnchorPins;
}

/**
 * 今天几号 + 接下来的节假日。
 *
 * **收编自 `acp-client/connection.ts` 的 `withDateline`**，位置不变（本轮尾区、原话之前）——
 * 那一处本来就放对了，只是全仓只有它放对了。
 * 放这里而不是锚定块：它每天都会变，进前缀等于每天换一次缓存。
 */
export function datelineFact(now: number): TurnFact {
  const bj = new Date(now + 8 * 3_600_000);
  const ymd = bj.toISOString().slice(0, 10);
  const weekday = "日一二三四五六"[bj.getUTCDay()];
  const holidays = holidayLine(now);
  const text = `【今天是 ${ymd}（周${weekday}），北京时间】${holidays ? `\n${holidays}` : ""}`;
  return { item: "dateline", text };
}

/**
 * 里程是多久以前的。
 *
 * **只能在本轮尾区**：它是相对时间，进锚定块就等于每天换一次前缀。
 * 空 ≠ 很久以前，是"不知道"——那一档要说出来，不能不写（§7 的「不衰减 ≠ 永远可信」）。
 */
export function odometerFreshnessFact(user: UserContext, now: number): TurnFact | undefined {
  const v = user.vehicle;
  if (!v || typeof v !== "object" || "unavailable" in v) return undefined;
  if (typeof v.odometerKm !== "number") return undefined;
  if (v.odometerAsOf === undefined) {
    return {
      item: "odometer-freshness",
      text: `里程 ${Math.round(v.odometerKm)} km，但**不知道这个数是什么时候的**——按"可能已过时"处理，别拿它当近期实测。`,
    };
  }
  const days = Math.max(0, Math.floor((now - v.odometerAsOf) / 86_400_000));
  const src = v.odometerSource ? `，来源 ${v.odometerSource}` : "";
  return {
    item: "odometer-freshness",
    text:
      days <= 14
        ? `里程 ${Math.round(v.odometerKm)} km，${days} 天前更新${src}。`
        : `里程 ${Math.round(v.odometerKm)} km，已经 ${days} 天没更新${src}——推算保养周期时要说明这一点。`,
  };
}

/** 本轮尾区里与任务有关的那几行（不含 `task-draft`，正文由调用方按路由给）。 */
export function taskFacts(tasks: ActiveTasks): TurnFact[] {
  const out: TurnFact[] = [];
  const status = taskStatusLine(tasks);
  if (status) out.push({ item: "task-status", text: status });
  const pending = taskPendingLine(tasks);
  if (pending) out.push({ item: "task-pending", text: pending });
  return out;
}

/**
 * 装载这一轮的上下文。`off` 档返回 `undefined`——调用方据此走老路径，零开销。
 *
 * 用户长期状态先读快照，miss 才投影并回写；**读失败不阻塞**（那一段标"读不到"，见 assemble）。
 */
export async function loadTurnContext(
  deps: TurnContextDeps,
  args: { userId?: string; threadId: string; now: number },
  mode: ContextLayerMode = contextLayerMode(),
): Promise<TurnContext | undefined> {
  if (mode === "off") return undefined;

  const cache = deps.cache ?? getContextCache();
  let user: UserContext | undefined;
  if (args.userId) {
    user = await cache.get(args.userId);
    if (!user) {
      user = await assembleUserContext(deps.readers, args.userId);
      void cache.set(args.userId, user);
    }
  }
  const resolvedUser: UserContext = user ?? { userId: args.userId ?? "unknown" };
  const tasks = await loadActiveTasks(deps.taskReader, args.userId, args.now);
  /*
   * 写入口只在 `tasks` 档给真的：`inject` 档的承诺是"只加注入、图状态一字不动"，
   * 给了写入口就等于偷偷把那一档也变成了 tasks 档，而那正是"逐级可退"要防的。
   */
  const writer =
    mode === "tasks"
      ? createTaskWriter({
          reader: deps.taskReader,
          userId: args.userId,
          tasks,
          now: () => args.now,
          newId: () => `wt-${args.now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        })
      : NO_TASK_WRITER;

  const baseFacts: TurnFact[] = [datelineFact(args.now)];
  const fresh = odometerFreshnessFact(resolvedUser, args.now);
  if (fresh) baseFacts.push(fresh);
  baseFacts.push(...taskFacts(tasks));

  return {
    mode,
    userId: args.userId,
    threadId: args.threadId,
    now: args.now,
    user: resolvedUser,
    tasks,
    writer,
    facts: baseFacts,
    anchorFor(agent: string): string | undefined {
      if (!args.userId) return undefined;
      const { text } = deps.pins.resolve(args.threadId, agent, resolvedUser);
      return text;
    },
    turnFor(agent: string, extra: readonly TurnFact[] = []): string | undefined {
      const changed = args.userId
        ? deps.pins.resolve(args.threadId, agent, resolvedUser).changed
        : false;
      const delta = anchorDeltaLine(changed);
      const facts: TurnFact[] = [...baseFacts, ...extra];
      if (delta) facts.push({ item: "task-status", text: delta });
      return renderTurn(facts, aclFor(agent).turn);
    },
  };
}

export { AnchorPins, fingerprintContext } from "./anchor";
export { assembleUserContext, ASSEMBLE_BUDGET_MS, type UserContextReaders } from "./assemble";
export {
  createContextCache,
  contextCacheTtlSeconds,
  getContextCache,
  invalidateUserContext,
  setContextCache,
  NO_CONTEXT_CACHE,
  type ContextCache,
  type ContextCacheBackend,
} from "./cache";
export {
  aclFor,
  CONTEXT_ACL,
  renderAnchor,
  renderTurn,
  ANCHOR_BUDGET_CHARS,
  TURN_BUDGET_CHARS,
  type ContextAgent,
  type TurnFact,
  type TurnItem,
} from "./render";
export {
  createTaskWriter,
  loadActiveTasks,
  taskPendingLine,
  taskStatusLine,
  NO_TASK_WRITER,
  type ActiveTasks,
  type TaskReader,
  type TaskWriter,
} from "./tasks";
export {
  buildContextTrace,
  contextTraceNotLoaded,
  observeServed,
  tasksForTrace,
  DRAFT_MAX_CHARS,
  type ContextTraceData,
  type ServedBlock,
  type TaskTraceState,
} from "./trace";
export { CONTEXT_BLOCK_HEADER };
export type { TaskKind, TaskState };
