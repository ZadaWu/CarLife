/**
 * 上下文的轨迹落点（2026-09-15，控制台会话页的「查看上下文」）。
 *
 * # 为什么要单独一条 `context` 事件
 *
 * ACR-036 之后，模型每轮看到的事实分两级：用户长期状态（Z1 锚定块的来源）与任务工作状态
 * （`working_tasks`，跨会话共享）。它们**不在图状态里**——`TurnRunner` 装好经 `configurable`
 * 交给节点，轨迹上只留了一条 `context.load` 的耗时 span。于是排障时想回答
 * "这一轮模型到底知道车主手上有几份行程"，只能提权去翻提示词原文，而那一步要写审计。
 *
 * 这条事件把三样东西按轮落下来：装载到的两级状态、本轮尾区的公共事实行、
 * 以及**各 Agent 实际拿到的**锚定块与尾区（经 `anchorFor` / `turnFor` 的调用记下来，
 * 不是重新渲染一遍——重渲染会把 `AnchorPins` 钉上本轮没用到的 Agent）。
 *
 * # 隐私口径
 *
 * 与会话页的消息正文同一档：不含对话原文（那是提示词要提权的原因），只含投影层已经
 * 截断过隐私的档案（无 phone、无明文地址），展示前再经网关 `redact`。草案正文按
 * `DRAFT_MAX_CHARS` 截断——行程草案实测可达数 KB，整份塞进 `trace_events` 只会让回放变慢。
 */

import type { TaskKind, TaskState, UserContext } from "@carlife/shared";

import type { ContextLayerMode, TurnContext } from "./index";
import type { ActiveTasks } from "./tasks";
import type { TurnFact } from "./render";

/** 单份草案入库上限。与工具入参同一档（`TOOL_IO_MAX_CHARS`）。 */
export const DRAFT_MAX_CHARS = 8_000;

/**
 * 把草案截成入库文本。对象走 JSON；字符串原样；超限截断并带标记。
 * 序列化失败（循环引用等）不抛——埋点坏了不该让对话坏，退回 `String(v)`。
 * 与 `trace/span.ts` 的 `clipForTrace` 同形；这里自带一份是为了让本模块只依赖契约类型。
 */
export function clipDraft(v: unknown, max: number = DRAFT_MAX_CHARS): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    text = String(v);
  }
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…（已截断，原长 ${text.length} 字符）`, truncated: true };
}

/** 一份任务状态的轨迹形态：`draft` 换成截断后的 JSON 文本，其余照抄。 */
export type TaskTraceState = Omit<TaskState, "draft"> & {
  draftText: string;
  draftTruncated?: true;
};

/** 某个 Agent 实际拿到的块。两项都可能缺席（该 Agent 只取过其中一种）。 */
export interface ServedBlock {
  agent: string;
  anchor?: string;
  turn?: string;
}

/** `kind = "context"` 的载荷。 */
export interface ContextTraceData extends Record<string, unknown> {
  /** 三档开关当时的取值。`off` 时其余字段都不会有。 */
  mode: ContextLayerMode;
  /** `loaded=false` 且 `mode≠off`：装载抛错，本轮走了老路径。 */
  loaded: boolean;
  threadId?: string;
  userId?: string;
  loadMs?: number;
  /** 用户长期状态（Z1 的来源）。 */
  user?: UserContext;
  /** 本轮开始时的活跃任务（模型看到的那份）。 */
  tasksBefore?: Partial<Record<TaskKind, TaskTraceState>>;
  /** 轮末的活跃任务（本轮写穿之后）。与 `tasksBefore` 逐字相同时不重复落。 */
  tasksAfter?: Partial<Record<TaskKind, TaskTraceState>>;
  /** 本轮各任务发生过的事件类型（写入口的账）。 */
  taskEvents?: Partial<Record<TaskKind, string[]>>;
  /** 本轮尾区的公共事实行（日期 / 里程新鲜度 / 任务状态行 / 追问候选）。 */
  facts?: TurnFact[];
  /** 各 Agent 实际拿到的块。 */
  served?: ServedBlock[];
}

/**
 * 记录 `anchorFor` / `turnFor` 的调用结果。
 *
 * 返回的对象**替代**原 `TurnContext` 交给图：两个渲染器之外的字段原样透传，
 * `writer` 仍是同一个实例（它闭包着本轮的 `tasks` 副本，换掉会让写穿对不上）。
 */
export function observeServed(ctx: TurnContext): { ctx: TurnContext; served: () => ServedBlock[] } {
  const blocks = new Map<string, ServedBlock>();
  const slot = (agent: string): ServedBlock => {
    let b = blocks.get(agent);
    if (!b) {
      b = { agent };
      blocks.set(agent, b);
    }
    return b;
  };
  const observed: TurnContext = {
    ...ctx,
    anchorFor(agent) {
      const text = ctx.anchorFor(agent);
      if (text !== undefined) slot(agent).anchor = text;
      return text;
    },
    turnFor(agent, extra) {
      const text = ctx.turnFor(agent, extra);
      // 同一 Agent 多次取尾区时留最后一次——后一次带的 extra 更全（求解结果在图执行后期才有）。
      if (text !== undefined) slot(agent).turn = text;
      return text;
    },
  };
  return { ctx: observed, served: () => [...blocks.values()] };
}

function toTraceState(task: TaskState): TaskTraceState {
  const { draft, ...rest } = task;
  const clipped = clipDraft(draft);
  return { ...rest, draftText: clipped.text, ...(clipped.truncated ? { draftTruncated: true as const } : {}) };
}

/** 把活跃任务表转成轨迹形态。空表返回 `undefined`，载荷里就不出现这一栏。 */
export function tasksForTrace(tasks: ActiveTasks | undefined): Partial<Record<TaskKind, TaskTraceState>> | undefined {
  if (!tasks) return undefined;
  const out: Partial<Record<TaskKind, TaskTraceState>> = {};
  let any = false;
  for (const [kind, task] of Object.entries(tasks) as Array<[TaskKind, TaskState | undefined]>) {
    if (!task) continue;
    out[kind] = toTraceState(task);
    any = true;
  }
  return any ? out : undefined;
}

/** 装载成功那一轮的输入。 */
export interface ContextTraceInput {
  ctx: TurnContext;
  /** 装载完成时立刻做的快照（写穿会就地改 `ctx.tasks`，轮末读到的已经是新值）。 */
  tasksBefore: ActiveTasks;
  served: ServedBlock[];
  loadMs: number;
}

/**
 * 拼一条 `context` 事件的载荷。纯函数，便于单测。
 *
 * `tasksAfter` 只在与 `tasksBefore` 不同时出现——多数轮次任务没变，重复一份只是让载荷翻倍。
 */
export function buildContextTrace(input: ContextTraceInput): ContextTraceData {
  const { ctx } = input;
  const before = tasksForTrace(input.tasksBefore);
  const after = tasksForTrace(ctx.tasks);
  const changed = JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);

  const taskEvents: Partial<Record<TaskKind, string[]>> = {};
  for (const kind of Object.keys({ ...input.tasksBefore, ...ctx.tasks }) as TaskKind[]) {
    const evs = ctx.writer.eventsOf(kind);
    if (evs.length > 0) taskEvents[kind] = [...evs];
  }

  return {
    mode: ctx.mode,
    loaded: true,
    threadId: ctx.threadId,
    ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
    loadMs: Math.max(0, input.loadMs),
    user: ctx.user,
    ...(before ? { tasksBefore: before } : {}),
    ...(changed && after ? { tasksAfter: after } : {}),
    ...(Object.keys(taskEvents).length > 0 ? { taskEvents } : {}),
    facts: [...ctx.facts],
    served: input.served,
  };
}

/** 装载层关着、或装载抛错时的载荷——这两种在页面上要分得开。 */
export function contextTraceNotLoaded(mode: ContextLayerMode, threadId: string, loadMs?: number): ContextTraceData {
  return {
    mode,
    loaded: false,
    threadId,
    ...(loadMs !== undefined ? { loadMs: Math.max(0, loadMs) } : {}),
  };
}
