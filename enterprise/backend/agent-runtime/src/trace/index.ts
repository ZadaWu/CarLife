/**
 * 运行轨迹采集（施工单 M5-06，§4.1 X2 / FL-14 F-14-06）。
 *
 * # 粒度基准：能回答罗启明的四个问题，不是"尽可能全"
 *
 * 1. 真的是多 Agent 吗 → `agent_session`（各 Agent 的独立会话可分别观察）
 * 2. 并行是真的吗 → `branch` 的 startedAt/endedAt（时间轴重叠）
 * 3. 中断恢复是真的吗 → `interrupt` / `resume` 的时间差
 * 4. 数据是真的吗 → `tool_call` 的入参出参摘要 + `source.kind`
 *
 * 记太粗"跟看日志有什么区别"，记太细存不起——四个问题就是那条线。
 *
 * # 排期上的要点
 *
 * 回放页在 M9，但**采集必须从现在开始埋**（FL-29 排期警告）：
 * 等到做回放时才加埋点，会发现历史会话一条都放不出来。
 *
 * # 写入永不阻塞主链路
 *
 * 与审计同一取向（FL-10 F-10-12）：轨迹是旁路，
 * 采集失败**绝不能**让对话失败。所有写入都是 fire-and-forget。
 */

export type TraceKind =
  | "turn_start"
  | "intent"
  /** 风险边界门的判定与处置（AC-11-7）——被拒的那一轮在回放里不能看起来像"没说话"。 */
  | "risk"
  | "route"
  | "agent_session"
  | "branch"
  | "merge"
  | "tool_call"
  | "guard"
  | "interrupt"
  | "resume"
  | "cancel"
  /** 行程确认/取消的裁决与结果（M13-02）——回放页要能看到"这一轮定下来了没有"。 */
  | "commit"
  | "turn_end"
  | "span";

/**
 * 一跳的耗时（施工单 TD-08 / FL-44 F-44-04）。
 *
 * # 为什么只加**一个** kind，而不是每种外部依赖各一个
 *
 * 每种依赖各开一个 kind，`timeline.ts` 的 `POINT_LABELS` 就会无限膨胀，
 * 而回放页想"按耗时倒排"时得先认识每一种。一个 `span` + `name` 前缀分组，
 * 页面只认前缀（`llm.` / `tool.` / `node.` / `acp.` / `guard.`）。
 *
 * # 已有事件的形状一律不动
 *
 * `intent` / `route` / `merge` / `branch` 记的是**内容**不是耗时，它们照旧；
 * 需要耗时的地方**额外**发一条 span。这样现有回放页与单测不破。
 *
 * # detail 里绝不放用户原文（AC-44-10）
 *
 * 指标系统不是绕过审计脱敏的后门。允许放的只有结构性信息：
 * 工具名、agent、命中块数、失败原因分类。
 */
/**
 * `cancelled` 与 `failed` 是两回事（M30-02 的教训在 span 层重演过一次）：
 * 「提交即收工」会主动掐掉分支流、分支超时与用户打断也会 abort 底层调用——
 * 这些流都以 CancelledError 收场，但**调用本身没有坏**。
 * 记成 failed 的话，行程 fan-out 每一轮三条 llm span 全红，
 * 轨迹页看起来像模型故障（fanout.ts 在分支层修过同一形态：
 * "功能全对、大屏失败率 100%"）。`detail` 里带取消原因（submitted / timeout / …）。
 */
export type SpanStatus = "ok" | "failed" | "cancelled";

export interface SpanData extends Record<string, unknown> {
  /** 形如 `llm.supervisor` / `tool.ragflow_retrieve` / `node.answer` / `acp.connect`。 */
  name: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: SpanStatus;
  agent?: string;
  /** **结构性信息**，不含用户原文。 */
  detail?: string;
  /**
   * 换算不到真会话 id 时置位（thread 已注销、异步回调迟到）。
   * **仍然写入**——丢掉的话，"为什么少了一跳"就再也查不出来了。
   */
  keyFallback?: true;
}

export function spanData(
  name: string,
  startedAt: number,
  endedAt: number,
  status: SpanStatus,
  extra?: { agent?: string; detail?: string; keyFallback?: true },
): SpanData {
  return {
    name,
    startedAt,
    endedAt,
    // 单调时钟不保证，负数会让页面画出反向的条——夹到 0 并如实保留两端时间戳。
    durationMs: Math.max(0, endedAt - startedAt),
    status,
    ...(extra?.agent !== undefined ? { agent: extra.agent } : {}),
    ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra?.keyFallback ? { keyFallback: true as const } : {}),
  };
}

export interface TraceEvent {
  sessionId: string;
  turnId?: string;
  kind: TraceKind;
  at: number;
  /** 结构化载荷；**展示前须经 PII 脱敏**（§8.3，M9 的回放页负责）。 */
  data: Record<string, unknown>;
}

export interface TraceSink {
  write(e: TraceEvent): void;
}

/** 内存实现：单测与离线路径用。生产装配注入落库实现（M9-01 接轨迹表）。 */
export class MemoryTraceSink implements TraceSink {
  private events: TraceEvent[] = [];
  constructor(private cap = 5_000) {}

  write(e: TraceEvent): void {
    this.events.push(e);
    // 有上限，避免长跑进程被轨迹吃满内存。丢弃最早的而不是拒绝新的——
    // 排障看的总是最近发生的事。
    if (this.events.length > this.cap) this.events.splice(0, this.events.length - this.cap);
  }

  bySession(sessionId: string): TraceEvent[] {
    return this.events.filter((e) => e.sessionId === sessionId);
  }

  all(): readonly TraceEvent[] {
    return this.events;
  }
}

/**
 * 采集器。**所有方法都不抛错**——轨迹是旁路，它坏了不该让对话坏。
 */
export class TraceCollector {
  constructor(
    private sink: TraceSink,
    private now: () => number = Date.now,
  ) {}

  record(sessionId: string, kind: TraceKind, data: Record<string, unknown>, turnId?: string): void {
    try {
      this.sink.write({ sessionId, turnId, kind, at: this.now(), data });
    } catch {
      // 吞掉：采集失败绝不能影响主链路（F-10-12 同源）。
    }
  }
}

/**
 * 取消令牌（FL-14 F-14-04/05 / FL-08 F-08-08）。
 *
 * # 副作用边界是本模块真正难的地方
 *
 * 只读工具的结果可以随便丢；**有副作用的工具，取消必须发生在权限门放行之前**
 * ——外部 API 一旦发出就无法收回（F-14-05）。
 * 缓解手段是把危险窗口收窄：`markSideEffectWindow` 标记"从这里到 API 返回之间不可取消"，
 * 取消请求落在窗口内时**如实告诉用户"已经发出去了"**，而不是假装取消成功。
 */
export class CancellationToken {
  private cancelled = false;
  private inSideEffect = false;
  private reason?: string;

  isCancelled(): boolean {
    return this.cancelled;
  }

  /** 返回 false 表示落在副作用窗口内——**动作已经发出，取消不了**。 */
  cancel(reason = "用户取消"): boolean {
    this.reason = reason;
    this.cancelled = true;
    return !this.inSideEffect;
  }

  cancelReason(): string | undefined {
    return this.reason;
  }

  /**
   * 进入/离开副作用窗口。窗口应尽可能窄——
   * 从权限门放行到外部 API 返回之间的那一小段（§11 时序的 `GC-->>Trip: allow` → `Trip->>Cal: 写入`）。
   */
  async withSideEffect<T>(fn: () => Promise<T>): Promise<T> {
    this.inSideEffect = true;
    try {
      return await fn();
    } finally {
      this.inSideEffect = false;
    }
  }

  /** 在安全点检查：已取消则抛出，让图停止推进。 */
  throwIfCancelled(): void {
    if (this.cancelled) throw new CancelledError(this.reason ?? "已取消");
  }
}

export class CancelledError extends Error {
  readonly cancelled = true;
}

/**
 * 回放数据读取（施工单 M9-01，FL-29 F-29-02/03）。
 *
 * **不触发任何真实 LLM / 外部 API 调用**（AC-14-7）——它只读已留存的轨迹，
 * 物理上绕开 `agent-runtime` 的执行路径。这条不是承诺，是结构：
 * 本函数拿不到 streamer、拿不到工具注册表，想调也调不了。
 */
export interface ReplayView {
  sessionId: string;
  /** 按时间排序的事件。 */
  timeline: TraceEvent[];
  /** 罗启明四问的直接答案。 */
  answers: {
    /** ① 真的是多 Agent 吗——出现过的 Agent 会话数。 */
    agentCount: number;
    /** ② 并行是真的吗——是否存在时间区间重叠的分支。 */
    hasParallelOverlap: boolean;
    /** ③ 中断恢复是真的吗——最长的一次挂起时长（ms）；无中断为 null。 */
    longestInterruptMs: number | null;
    /** ④ 数据是真的吗——工具调用次数与真实/模拟占比。 */
    toolCalls: { total: number; real: number; mock: number };
  };
}

export function buildReplay(events: readonly TraceEvent[], sessionId: string): ReplayView {
  const timeline = events.filter((e) => e.sessionId === sessionId).slice().sort((a, b) => a.at - b.at);

  const agents = new Set<string>();
  for (const e of timeline) {
    const a = (e.data as { agent?: string }).agent;
    if (a && (e.kind === "agent_session" || e.kind === "branch")) agents.add(a);
  }

  // 并行判据与 fanout.ts 保持一致：区间有交集才算（AC-13-1）。
  const branches = timeline
    .filter((e) => e.kind === "branch")
    .map((e) => e.data as { startedAt?: number; endedAt?: number })
    .filter((b): b is { startedAt: number; endedAt: number } =>
      typeof b.startedAt === "number" && typeof b.endedAt === "number");
  let overlap = false;
  for (let i = 0; i < branches.length && !overlap; i += 1) {
    for (let j = i + 1; j < branches.length; j += 1) {
      if (branches[i].startedAt < branches[j].endedAt && branches[j].startedAt < branches[i].endedAt) {
        overlap = true;
        break;
      }
    }
  }

  // 挂起时长：interrupt 与同 id 的 resume 之间的真实间隔。
  let longestInterruptMs: number | null = null;
  const opened = new Map<string, number>();
  for (const e of timeline) {
    const id = (e.data as { interruptId?: string }).interruptId;
    if (!id) continue;
    if (e.kind === "interrupt") opened.set(id, e.at);
    if (e.kind === "resume" && opened.has(id)) {
      const ms = e.at - opened.get(id)!;
      longestInterruptMs = Math.max(longestInterruptMs ?? 0, ms);
      opened.delete(id);
    }
  }

  const calls = timeline.filter((e) => e.kind === "tool_call");
  const real = calls.filter((e) => (e.data as { source?: { kind?: string } }).source?.kind === "real").length;
  const mock = calls.filter((e) => (e.data as { source?: { kind?: string } }).source?.kind === "mock").length;

  return {
    sessionId,
    timeline,
    answers: {
      agentCount: agents.size,
      hasParallelOverlap: overlap,
      longestInterruptMs,
      toolCalls: { total: calls.length, real, mock },
    },
  };
}
