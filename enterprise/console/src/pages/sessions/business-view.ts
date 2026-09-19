/**
 * 业务视图的模型（2026-09-15，会话页轨迹抽屉的「业务视图」）——**纯逻辑，不 import 组件或样式**。
 *
 * # 回答的是业务人员的三个问题，不是研发的四问
 *
 * 研发视图（`TurnTrace`）回答"哪一跳慢、并行是不是真的、数据真不真"；
 * 业务人员查"大量用户反馈酒店规划不合理"时问的是另外三件事：
 *
 *   1. 系统听懂了什么、交给了谁；
 *   2. 每一步（尤其是住宿那一步）拿什么条件去查、查回来什么、交回了什么；
 *   3. 最后答了什么。
 *
 * 所以这里把同一批轨迹事件**重新组织**成"阶段 → 其中的 Agent → 它调的工具"三层，
 * 每层带人话标签与输入输出。**不是过滤**（F-29-08 的纪律照守）：
 * 事件一条不少，只是换个组织方式；研发视图仍在同一个抽屉里一键切回。
 *
 * # 为什么按时间区间归属，而不是按名字前缀
 *
 * 一个 Agent 调了哪些工具，轨迹里没有父子指针——`tool_call` 只带 canonical agent 名
 * 与时刻。同一轮里 `hotel` 分支可能跑两次（骨架后追跳），按名字归会把第二次的
 * 工具算到第一次头上。按"落在哪次 `llm.<agent>` span 的区间里"归才对得上。
 * 落不进任何 Agent 区间的（图节点直调 `invokeTool`，如双路检索），归它所在的阶段。
 *
 * # 提示词仍不在这里摊开
 *
 * `prompt` 事件的 `text` 在网关就被挖掉了（提示词 ≈ 整段对话原文，看要提权 + 审计）。
 * 这里只记它的长度与定位键（agent + at），提权后由组件按键对回文本。
 * 业务视图不是绕过那道门的后门。
 */

import type { TraceEvent } from "../trace/timeline";
import {
  agentLabel,
  agentRoleNote,
  canonicalAgent,
  cancelReasonLabel,
  isSubmitTool,
  nodeLabel,
  riskLabel,
  routeLabel,
  toolLabel,
} from "./business-labels";
import type { ConsoleMessage } from "./turns";

export type StepStatus = "ok" | "failed" | "cancelled" | "warn" | "skipped";

export interface ToolUse {
  name: string;
  label: string;
  /** 交作业（`submit_*`）与查资料分开标——业务上一个是动作、一个是数据来源。 */
  submit: boolean;
  status: "ok" | "failed";
  mock: boolean;
  /** 工具自己那一行概括（"查到 6 条"），埋点之前的轮次没有。 */
  summary?: string;
  input?: string;
  output?: string;
  inputTruncated: boolean;
  outputTruncated: boolean;
  durationMs?: number;
  at: number;
}

export interface AgentStep {
  kind: "agent";
  /** 原始名（`hotel-task`），研发对账时要用。 */
  agent: string;
  label: string;
  roleNote?: string;
  /** 同一 Agent 在本轮第几次上场（从 1 起）。 */
  seq: number;
  status: StepStatus;
  statusText: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** 提示词的定位键：提权后按 (agent, at) 对回原文。没有 = 这一轮跑在埋点之前。 */
  prompt?: { at: number; chars: number; truncated: boolean };
  tools: ToolUse[];
  /** 交回的结论：走提交通道的是结构化 JSON，否则是模型产出的文本。 */
  output?: { text: string; truncated: boolean; source: "submission" | "text" };
  /** 与本步时间区间有交集的其它 Agent（并行的证据，业务视图只说"与谁同时进行"）。 */
  parallelWith: string[];
}

export interface PhaseStep {
  kind: "phase";
  /** 图节点 id（`understand` / `itineraryPlan` …）或合成阶段的 id。 */
  id: string;
  label: string;
  status: StepStatus;
  statusText?: string;
  startedAt: number;
  endedAt: number;
  durationMs?: number;
  /** 一句话结论（意图的 goal、路由去向、体检结果…）。 */
  summary?: string;
  /** 补充说明，逐条。降级原因、约束违反数、确认等待时长都在这里。 */
  notes: string[];
  agents: AgentStep[];
  /** 阶段直调的工具（不属于任何 Agent 区间）。 */
  tools: ToolUse[];
}

export type Outcome = "ok" | "failed" | "cancelled" | "denied" | "running";

export interface BusinessTurn {
  ask?: string;
  answer?: string;
  /** 系统对这一轮的理解：目标、约束、去向。 */
  goal?: string;
  constraints: string[];
  route?: { target: string; label: string; reason?: string };
  sideTasks: Array<{ label: string; goal: string }>;
  risk?: { category: string; label: string; decision: string };
  outcome: Outcome;
  outcomeText: string;
  startedAt: number;
  totalMs: number;
  phases: PhaseStep[];
  /** 全部 Agent 步骤按时间排（"住宿那一步"直接从这里找）。 */
  agents: AgentStep[];
  answerChars?: number;
}

/* ── 小工具 ───────────────────────────────────────────────── */

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

interface LlmSpan {
  agent: string;
  startedAt: number;
  endedAt: number;
  status: string;
  detail?: string;
}

interface NodeSpan {
  id: string;
  startedAt: number;
  endedAt: number;
  status: string;
  detail?: string;
}

function spansOf(events: readonly TraceEvent[]): { llm: LlmSpan[]; nodes: NodeSpan[] } {
  const llm: LlmSpan[] = [];
  const nodes: NodeSpan[] = [];
  for (const e of events) {
    if (e.kind !== "span") continue;
    const name = str(e.data.name) ?? "";
    const startedAt = num(e.data.startedAt) ?? e.at;
    const endedAt = num(e.data.endedAt) ?? e.at;
    const status = str(e.data.status) ?? "ok";
    const detail = str(e.data.detail);
    if (name.startsWith("llm.") && !name.endsWith(".ttft")) {
      llm.push({ agent: str(e.data.agent) ?? name.slice(4), startedAt, endedAt, status, detail });
    } else if (name.startsWith("node.")) {
      nodes.push({ id: name.slice(5), startedAt, endedAt, status, detail });
    }
  }
  llm.sort((a, b) => a.startedAt - b.startedAt);
  nodes.sort((a, b) => a.startedAt - b.startedAt);
  return { llm, nodes };
}

function toolUseOf(e: TraceEvent): ToolUse {
  const d = e.data;
  const name = str(d.name) ?? "?";
  return {
    name,
    label: toolLabel(name),
    submit: isSubmitTool(name),
    status: d.status === "failed" ? "failed" : "ok",
    mock: (d.source as { kind?: string } | undefined)?.kind === "mock",
    summary: str(d.detail) ?? str(d.summary),
    input: str(d.input),
    output: str(d.output),
    inputTruncated: d.inputTruncated === true,
    outputTruncated: d.outputTruncated === true,
    durationMs: num(d.durationMs),
    at: e.at,
  };
}

/** 一个时刻是否落在区间内（闭区间；埋点时钟同源，边界相等算落在里面）。 */
const within = (at: number, s: { startedAt: number; endedAt: number }): boolean =>
  at >= s.startedAt && at <= s.endedAt;

/**
 * 两次 LLM 调用的区间有交集就算并行。
 *
 * 研发视图的 `FlowChild.parallel` 多一条"互不包含"——那是因为它比的是不同种类的
 * 跳（`acp.session_new` 套在 `llm.*` 里是嵌套不是并行）。这里只比 `llm.<agent>` 之间：
 * 一次模型调用不会套着另一次，而 fan-out 的几条腿几乎同一毫秒起跑、先后结束，
 * 短的那条必然被长的那条"包含"，加那条判据会把真并行判成没有。
 */
function overlaps(
  a: { startedAt: number; endedAt: number },
  b: { startedAt: number; endedAt: number },
): boolean {
  return a.startedAt < b.endedAt && b.startedAt < a.endedAt;
}

/* ── Agent 步骤 ───────────────────────────────────────────── */

/**
 * `agent_output` 落在 `llm.<agent>` span 的 finally 里，**紧随其后**——
 * 用"同 agent、最早一条 at ≥ endedAt − 容差"配对，每条只用一次。
 * 容差是给两个 `Date.now()` 之间的抖动留的，不是给"下一次调用"留的：
 * 同一 agent 两次调用之间至少隔一次完整的 LLM 往返，远大于它。
 */
const PAIR_TOLERANCE_MS = 50;

function buildAgentSteps(
  events: readonly TraceEvent[],
  llm: LlmSpan[],
): AgentStep[] {
  const prompts = events.filter((e) => e.kind === "prompt");
  const outputs = events.filter((e) => e.kind === "agent_output");
  const branches = events.filter((e) => e.kind === "branch");
  const tools = events.filter((e) => e.kind === "tool_call");
  const usedOutput = new Set<TraceEvent>();
  const usedTool = new Set<TraceEvent>();
  const seqOf = new Map<string, number>();

  const steps: AgentStep[] = llm.map((s) => {
    const seq = (seqOf.get(s.agent) ?? 0) + 1;
    seqOf.set(s.agent, seq);

    const prompt = prompts.find((p) => str(p.data.agent) === s.agent && within(p.at, s));
    const out = outputs.find(
      (o) => !usedOutput.has(o) && str(o.data.agent) === s.agent && o.at >= s.endedAt - PAIR_TOLERANCE_MS,
    );
    if (out) usedOutput.add(out);

    // 走提交通道的分支：结论在 branch.submission，agent_output 只有被掐前的半截。
    const branch = branches.find(
      (b) => str(b.data.agent) === s.agent && str(b.data.submission) !== undefined && within(s.endedAt, {
        startedAt: num(b.data.startedAt) ?? b.at,
        endedAt: (num(b.data.endedAt) ?? b.at) + PAIR_TOLERANCE_MS,
      }),
    );

    const canon = canonicalAgent(s.agent);
    const mine = tools.filter(
      (t) => !usedTool.has(t) && (str(t.data.agent) ?? "") === canon && within(t.at, s),
    );
    for (const t of mine) usedTool.add(t);

    const status: StepStatus =
      s.status === "failed" ? "failed" : s.status === "cancelled" ? (s.detail === "submitted" ? "ok" : "cancelled") : "ok";
    const statusText =
      s.status === "failed"
        ? "失败"
        : s.status === "cancelled"
          ? cancelReasonLabel(s.detail)
          : "完成";

    const output = branch
      ? { text: String(branch.data.submission), truncated: branch.data.submissionTruncated === true, source: "submission" as const }
      : out && str(out.data.text)
        ? { text: String(out.data.text), truncated: out.data.truncated === true, source: "text" as const }
        : undefined;

    return {
      kind: "agent",
      agent: s.agent,
      label: agentLabel(s.agent),
      roleNote: agentRoleNote(s.agent),
      seq,
      status,
      statusText,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMs: Math.max(0, s.endedAt - s.startedAt),
      prompt: prompt
        ? { at: prompt.at, chars: num(prompt.data.chars) ?? 0, truncated: prompt.data.truncated === true }
        : undefined,
      tools: mine.map(toolUseOf),
      output,
      parallelWith: [],
    };
  });

  for (const a of steps) {
    a.parallelWith = steps
      .filter((b) => b !== a && overlaps(a, b))
      .map((b) => b.label);
  }
  return steps;
}

/* ── 阶段 ─────────────────────────────────────────────────── */

/** 图节点里"容器"那几层不单独成阶段——它们的内容已经由子节点表达。 */
const SKIP_NODES = new Set<string>(["join"]);

function phaseOfNode(n: NodeSpan): PhaseStep {
  const status: StepStatus = n.status === "failed" ? "failed" : n.status === "cancelled" ? "cancelled" : "ok";
  return {
    kind: "phase",
    id: n.id,
    label: nodeLabel(n.id),
    status,
    statusText: status === "failed" ? "失败" : status === "cancelled" ? cancelReasonLabel(n.detail) : undefined,
    startedAt: n.startedAt,
    endedAt: n.endedAt,
    durationMs: Math.max(0, n.endedAt - n.startedAt),
    notes: [],
    agents: [],
    tools: [],
  };
}

/** 把内容事件（merge / audit / guard …）翻成阶段上的一行说明。 */
function noteOf(e: TraceEvent): string | undefined {
  const d = e.data;
  switch (e.kind) {
    case "merge": {
      if (d.personalized === false) {
        const caveats = Array.isArray(d.caveats) ? (d.caveats as string[]).join("；") : "";
        return `降级为通用回答${caveats ? `：${caveats}` : ""}`;
      }
      if (d.personalized === true) return "两路资料齐备，给出针对这辆车的结论";
      if (d.agent === "itinerary") {
        const parts = [
          d.mode === "refine" ? "在现有草案上修改" : d.mode === "skeleton" ? "从骨架起新排" : undefined,
          num(d.days) !== undefined ? `排出 ${String(d.days)} 天` : undefined,
          Array.isArray(d.violations) && d.violations.length > 0 ? `违反约束 ${d.violations.length} 条` : undefined,
          Array.isArray(d.missing) && d.missing.length > 0 ? `缺 ${(d.missing as string[]).join("、")}` : undefined,
          str(d.hotelSource) ? `酒店结论来自${d.hotelSource === "submission" ? "提交通道" : "文本解析"}` : undefined,
        ].filter(Boolean);
        return parts.length ? `汇总：${parts.join(" · ")}` : "汇总完成";
      }
      if (d.fallback === true) return "座舱指令走了兜底路径";
      return undefined;
    }
    case "audit":
      return typeof d.passed === "number"
        ? `行程体检：验 ${d.passed} 项 · 修 ${Number(d.repaired ?? 0)} 处 · 剩 ${Number(d.blockers ?? 0)} 条要人看${d.budgetExhausted ? " · 修复预算用尽" : ""}`
        : undefined;
    case "guard": {
      const tool = str(d.tool) ? toolLabel(String(d.tool)) : "动作";
      const decision = d.decision === "deny" ? "拒绝" : d.decision === "confirm" ? "需车主确认" : "放行";
      return `权限门：${tool} → ${decision}${str(d.reason) ? `（${String(d.reason)}）` : ""}`;
    }
    case "commit":
      return str(d.op) ? `行程处置：${String(d.op)}${str(d.decision) ? ` → ${String(d.decision)}` : ""}` : undefined;
    case "vision":
      return "已看照片并做受控观察";
    case "video":
      return "已抽取视频帧与转写";
    case "cancel":
      return "本轮被取消";
    default:
      return undefined;
  }
}

/** 人工确认：interrupt → resume 配对成一条"等了多久"。 */
function confirmNotes(events: readonly TraceEvent[]): string[] {
  const opened = new Map<string, TraceEvent>();
  const notes: string[] = [];
  for (const e of events) {
    const id = str(e.data.interruptId);
    if (!id) continue;
    if (e.kind === "interrupt") opened.set(id, e);
    if (e.kind === "resume" && opened.has(id)) {
      const from = opened.get(id)!;
      notes.push(`车主确认「${toolLabel(str(from.data.tool) ?? "动作")}」，等待 ${e.at - from.at}ms`);
      opened.delete(id);
    }
  }
  for (const from of opened.values()) {
    notes.push(`「${toolLabel(str(from.data.tool) ?? "动作")}」仍在等车主确认（本轮内没等到）`);
  }
  return notes;
}

function buildPhases(events: readonly TraceEvent[], nodes: NodeSpan[], agents: AgentStep[]): PhaseStep[] {
  const phases = nodes.filter((n) => !SKIP_NODES.has(n.id)).map(phaseOfNode);

  // Agent 归阶段：取包含它的**最窄**节点区间（副 lane 与主节点会嵌套）。
  const homeless: AgentStep[] = [];
  for (const a of agents) {
    const hosts = phases.filter((p) => a.startedAt >= p.startedAt && a.endedAt <= p.endedAt);
    const host = hosts.sort((x, y) => (x.endedAt - x.startedAt) - (y.endedAt - y.startedAt))[0];
    if (host) host.agents.push(a);
    else homeless.push(a);
  }
  if (homeless.length > 0) {
    // 没有节点 span 的轮次（埋点之前，或 HTTP 直触发的子图）：合成一个阶段兜住，不丢。
    phases.push({
      kind: "phase",
      id: "agents",
      label: "Agent 处理",
      status: homeless.some((a) => a.status === "failed") ? "failed" : "ok",
      startedAt: Math.min(...homeless.map((a) => a.startedAt)),
      endedAt: Math.max(...homeless.map((a) => a.endedAt)),
      notes: [],
      agents: homeless,
      tools: [],
    });
  }

  // 阶段直调的工具：不在任何 Agent 区间里的那些。
  const usedByAgents = new Set(agents.flatMap((a) => a.tools.map((t) => t.at)));
  const orphanTools: ToolUse[] = [];
  for (const e of events) {
    if (e.kind !== "tool_call" || usedByAgents.has(e.at)) continue;
    const t = toolUseOf(e);
    const host = phases
      .filter((p) => within(e.at, p))
      .sort((x, y) => (x.endedAt - x.startedAt) - (y.endedAt - y.startedAt))[0];
    if (host) host.tools.push(t);
    else orphanTools.push(t);
  }
  if (orphanTools.length > 0) {
    phases.push({
      kind: "phase",
      id: "tools",
      label: "其它数据查询",
      status: orphanTools.some((t) => t.status === "failed") ? "warn" : "ok",
      startedAt: Math.min(...orphanTools.map((t) => t.at)),
      endedAt: Math.max(...orphanTools.map((t) => t.at)),
      notes: [],
      agents: [],
      tools: orphanTools,
    });
  }

  // 内容事件 → 所在阶段的说明行；落不进任何阶段的挂到最近一个已开始的阶段。
  for (const e of events) {
    const note = noteOf(e);
    if (!note) continue;
    const host =
      phases.filter((p) => within(e.at, p)).sort((x, y) => (x.endedAt - x.startedAt) - (y.endedAt - y.startedAt))[0] ??
      [...phases].filter((p) => p.startedAt <= e.at).sort((x, y) => y.startedAt - x.startedAt)[0];
    if (host) {
      host.notes.push(note);
      if (e.kind === "merge" && e.data.personalized === false && host.status === "ok") host.status = "warn";
      if (e.kind === "guard" && e.data.decision === "deny" && host.status === "ok") host.status = "warn";
    }
  }
  const confirm = confirmNotes(events);
  if (confirm.length > 0) {
    const host = phases.find((p) => p.notes.some((n) => n.startsWith("权限门"))) ?? phases[phases.length - 1];
    if (host) host.notes.push(...confirm);
  }

  for (const p of phases) {
    p.agents.sort((a, b) => a.startedAt - b.startedAt);
    p.tools.sort((a, b) => a.at - b.at);
  }
  return phases.sort((a, b) => a.startedAt - b.startedAt);
}

/* ── 概览 ─────────────────────────────────────────────────── */

function outcomeOf(events: readonly TraceEvent[]): { outcome: Outcome; text: string; answerChars?: number } {
  const risk = events.find((e) => e.kind === "risk");
  if (risk && risk.data.decision === "deny") {
    return { outcome: "denied", text: `被安全边界门拒绝：${riskLabel(str(risk.data.category) ?? "unknown")}` };
  }
  const end = events.find((e) => e.kind === "turn_end");
  if (!end) return { outcome: "running", text: "本轮没有收口记录（仍在进行，或轨迹不完整）" };
  const answerChars = num(end.data.answerChars);
  switch (end.data.outcome) {
    case "cancelled":
      return { outcome: "cancelled", text: "车主中途打断，本轮取消", answerChars };
    case "failed":
      return { outcome: "failed", text: "执行失败，车主收到的是失败说明", answerChars };
    case "input_denied":
      return { outcome: "denied", text: "输入内容未通过审核" };
    default:
      return {
        outcome: "ok",
        text: answerChars !== undefined ? `正常回答（${answerChars} 字）` : "正常回答",
        answerChars,
      };
  }
}

/**
 * 把一轮的轨迹与对话组织成业务视图。
 *
 * `messages` 是这一轮的对话（车主问 / 助手答），来自会话消息表而不是轨迹——
 * 最终回答的全文只在那里；`turn_end.answerChars` 只有长度。
 */
export function buildBusinessTurn(
  events: readonly TraceEvent[],
  messages: readonly ConsoleMessage[] = [],
): BusinessTurn {
  const { llm, nodes } = spansOf(events);
  const agents = buildAgentSteps(events, llm);
  const phases = buildPhases(events, nodes, agents);

  const intent = events.find((e) => e.kind === "intent")?.data;
  const route = events.find((e) => e.kind === "route")?.data;
  const risk = events.find((e) => e.kind === "risk")?.data;
  const outcome = outcomeOf(events);

  const understand = phases.find((p) => p.id === "understand");
  if (understand && str(intent?.goal)) understand.summary = String(intent!.goal);
  if (understand && intent?.degraded === true) {
    understand.notes.unshift("理解层降级：模型没给出可用的意图 JSON，走了规则兜底");
    if (understand.status === "ok") understand.status = "warn";
  }
  const dispatch = phases.find((p) => p.id === "dispatch");
  if (dispatch && str(route?.agent)) {
    dispatch.summary = `交给「${routeLabel(String(route!.agent))}」${str(route!.reason) ? `——${String(route!.reason)}` : ""}`;
  }
  const gate = phases.find((p) => p.id === "riskGate");
  if (gate && risk) {
    const category = str(risk.category) ?? "unknown";
    gate.summary = `${riskLabel(category)} → ${risk.decision === "deny" ? "拒绝" : risk.decision === "note" ? "放行并附提醒" : "放行"}`;
    if (risk.decision === "deny") gate.status = "failed";
    else if (category === "unknown") gate.status = "warn";
  }

  const times = [
    ...events.map((e) => e.at),
    ...llm.flatMap((s) => [s.startedAt, s.endedAt]),
    ...nodes.flatMap((s) => [s.startedAt, s.endedAt]),
  ];
  const startedAt = times.length ? Math.min(...times) : 0;
  const endedAt = times.length ? Math.max(...times) : 0;

  const sideTasks = Array.isArray(route?.secondary)
    ? (route!.secondary as Array<{ route?: unknown; goal?: unknown }>)
        .filter((t) => str(t.route))
        .map((t) => ({ label: routeLabel(String(t.route)), goal: str(t.goal) ?? "" }))
    : [];

  return {
    ask: messages.find((m) => m.role === "user")?.content,
    answer: messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n\n") || undefined,
    goal: str(intent?.goal),
    constraints: Array.isArray(intent?.constraints) ? (intent!.constraints as unknown[]).filter((c): c is string => typeof c === "string") : [],
    route: str(route?.agent)
      ? { target: String(route!.agent), label: routeLabel(String(route!.agent)), reason: str(route!.reason) }
      : undefined,
    sideTasks,
    risk: risk && str(risk.category)
      ? { category: String(risk.category), label: riskLabel(String(risk.category)), decision: String(risk.decision ?? "?") }
      : undefined,
    outcome: outcome.outcome,
    outcomeText: outcome.text,
    startedAt,
    totalMs: Math.max(0, endedAt - startedAt),
    phases,
    agents,
    answerChars: outcome.answerChars,
  };
}

/** 业务视图的耗时写法：毫秒级给 ms，秒级给一位小数——"12.3 秒"比 "12345ms" 好读。 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}
