/**
 * graph/compound —— 复合意图的分叉—汇合（ACR-023，施工单 M69-01，
 * FL-11 F-11-06 / F-11-04、FL-13 F-13-09）。
 *
 * # 这里只有纯函数，零 import supervisor
 *
 * 一句话里带两件事（「去杭州自驾，顺路把保养做了」）时，意图层多给一栏 `sideTasks`，
 * 图把每个分支节点经同一个 `lane()` 包装注册成**主/副两套同形态节点**，`dispatch` 的条件边
 * 返回一组 lane 节点并行派出，`join` 汇合，`answer` 表述。本文件是那条链路的全部**判定**：
 * 派哪些节点、每条 lane 看得到什么、怎么汇、怎么说——单独导出是为了能被断言
 * （与 `route.ts` 的 `branchFor` 同一条理由：塞进图装配的闭包里，缺陷就落在测不到的那一层）。
 *
 * # 两张白名单是这个模块的骨头
 *
 * - `laneChannelsOf`：每个分支节点**拥有**哪些通道。来源是 2026-09-04 对五个节点函数 `state.*`
 *   读集的 grep（`itineraryNode → intent, messages, pendingCancel, tripPlan` …）。投影只给
 *   共享上下文 + 本 lane 拥有的通道，其余一律默认值——**新节点读了表外的通道会被投影成默认值，
 *   而且不报错**，所以它是 内部开发指引「新增一个业务 Agent」的第 12 个接线点。
 * - `resultKeyOf`：路由目标 → `agentResults` / `sideResults` 的键名（`testDrive → "test-drive"`）。
 *   漏了它，该 Agent 作为副任务时结果到不了应答——第 11 个接线点。
 *
 * # 主 lane 的投影必须让单路由轮次逐键与今天相同
 *
 * 这是"不破坏既有功能"的可机械核对形式：`compound.test.ts` 对七个 `agentResults` 键各放一次，
 * 断言 `composeSolved` 与旧的固定优先级链逐字相同；`graph.test.ts` 断言 `lane → join` 之后的
 * 图状态与直接写回逐键相同。
 */

import { GraphState, type LaneResult, type RouteDecision, type SideTask } from "./state";
import { branchFor, type BranchNode } from "./route";
import { sideTasksEnabled } from "./intent";

type State = typeof GraphState.State;
type ChannelKey = keyof State;

export type LaneId = "primary" | "side";

/** 副 lane 的节点名：每个分支节点一个，静态注册（同一路由只能有一个副任务的根源）。 */
export type SideBranchNode =
  | "sideOwnershipDual"
  | "sideBuyingCatalog"
  | "sideTestDriveFlow"
  | "sideCabinCompanion"
  | "sideItineraryPlan";

/** 真会被派到的分支节点：`tripFanout` 是历史遗留（`branchFor` 不再返回它），不进 lane。 */
export type WorkNode = Exclude<BranchNode, "answer" | "tripFanout">;

/**
 * 每条 lane 都看得到的上下文：原话、意图（含约束）、路由、风险裁决、本轮同行人约束。
 * 不在这里、也不在 `laneChannelsOf` 里的通道，投影时一律给默认值。
 */
export const SHARED_CHANNELS = ["messages", "intent", "route", "risk", "companionConstraints"] as const satisfies readonly ChannelKey[];

/**
 * 分支节点拥有的通道（白名单）。**按各节点函数实际读到的 `state.*` 列**，不按"看起来相关"列：
 * 购车读 `testDrivePlan`（「约刚才比的那款」的跨 Agent 上下文）所以它在购车的表里；座舱什么都不读。
 */
const LANE_CHANNELS: Record<WorkNode, readonly ChannelKey[]> = {
  itineraryPlan: ["tripPlan", "pendingCancel"],
  ownershipDual: ["consultation", "repairBookingPlan"],
  buyingCatalog: ["buyingPlan", "costPlan", "trimPlan", "loanPlan", "insurancePlan", "testDrivePlan"],
  testDriveFlow: ["testDrivePlan"],
  cabinCompanion: [],
};

export function laneChannelsOf(node: BranchNode): readonly ChannelKey[] {
  return node === "answer" || node === "tripFanout" ? [] : LANE_CHANNELS[node];
}

const SIDE_NODE: Record<WorkNode, SideBranchNode> = {
  itineraryPlan: "sideItineraryPlan",
  ownershipDual: "sideOwnershipDual",
  buyingCatalog: "sideBuyingCatalog",
  testDriveFlow: "sideTestDriveFlow",
  cabinCompanion: "sideCabinCompanion",
};

export function sideNodeOf(node: WorkNode): SideBranchNode {
  return SIDE_NODE[node];
}

/** 路由目标 → 结果键名。`general` 没有结果键（它由应答直接回答）。 */
export function resultKeyOf(target: string | undefined): string | undefined {
  switch (target) {
    case "itinerary":
      return "itinerary";
    case "trip":
      return "trip";
    case "ownership":
      return "ownership";
    case "service":
      return "service";
    case "buying":
      return "buying";
    case "testDrive":
      return "test-drive";
    case "cabin":
      return "cabin";
    default:
      return undefined;
  }
}

/**
 * 本轮要起的副 lane：每项副任务映到它的分支节点，去掉 `answer`、与主节点同名的
 * （同一节点不作为两条 lane 同时进入——两者同 superstep 写同一批通道会撞 last-write）、
 * 以及重复的节点（同一路由只能一个）。顺序 = 意图顺序。开关 off 时恒为空。
 */
export function sideTaskNodesOf(route: RouteDecision | undefined): { task: SideTask; node: WorkNode }[] {
  if (!sideTasksEnabled() || !route?.secondary?.length) return [];
  const primary = branchFor(route);
  const seen = new Set<BranchNode>();
  const out: { task: SideTask; node: WorkNode }[] = [];
  for (const task of route.secondary) {
    const node = branchFor({ agent: task.route });
    if (node === "answer" || node === "tripFanout" || node === primary || seen.has(node)) continue;
    seen.add(node);
    out.push({ task, node });
  }
  return out;
}

/**
 * `dispatch` 条件边的返回值：本轮并行派出的 lane 节点。返回数组就是 LangGraph 并行派出的契约。
 * 无副任务 → `[主节点]`（与今天的 `branchFor` 逐一相等）；主路由是 general 但带副任务 → 只有副 lane（`answer` 经 `join` 到达）。
 */
export function dispatchTargets(state: { route?: RouteDecision }): (BranchNode | SideBranchNode)[] {
  const primary = branchFor(state.route);
  const sides = sideTaskNodesOf(state.route).map((s) => sideNodeOf(s.node));
  if (sides.length === 0) return [primary];
  return primary === "answer" ? sides : [primary, ...sides];
}

/** 登记给权限门的副 lane 顺序（Agent 名口径），用于同会话排队的出队优先级（M69-04）。 */
export function laneOrderOf(route: RouteDecision | undefined): string[] {
  return sideTaskNodesOf(route)
    .map((s) => resultKeyOf(s.task.route))
    .filter((k): k is string => k !== undefined);
}

function defaultOf(channel: string): unknown {
  const spec = (GraphState.spec as Record<string, { initialValueFactory?: () => unknown }>)[channel];
  return spec?.initialValueFactory ? spec.initialValueFactory() : undefined;
}

export interface LaneSpec {
  lane: LaneId;
  /** 分支节点名（主节点名；副 lane 也记主节点名，副节点名由 `sideNodeOf` 推）。 */
  node: BranchNode;
  /** 副 lane 的那件事；主 lane 不带。 */
  task?: SideTask;
}

/**
 * 给节点函数的投影 state：共享上下文 + 本 lane 拥有的通道取原值，其余取该通道的默认值。
 * 副 lane 另把 `route.agent` 换成副目标、`intent.goal` 换成副任务 goal，并去掉 `intent.sideTasks`
 * （子节点不该再看到"还有别的事"）。
 *
 * 返回的是新对象，不改入参。
 */
export function projectLane(state: State, spec: LaneSpec): State {
  const keep = new Set<string>([...SHARED_CHANNELS, ...laneChannelsOf(spec.node)]);
  const out: Record<string, unknown> = {};
  for (const channel of Object.keys(GraphState.spec)) {
    out[channel] = keep.has(channel) ? (state as Record<string, unknown>)[channel] : defaultOf(channel);
  }
  if (spec.lane === "side" && spec.task) {
    out.route = { agent: spec.task.route, reason: "副任务（ACR-023）" };
    const base = state.intent ?? { goal: "", constraints: [], context: "", riskBoundary: "" };
    const { sideTasks: _omit, ...rest } = base;
    void _omit;
    out.intent = { ...rest, goal: spec.task.goal };
  }
  return out as State;
}

/** 副 lane 的 patch 里永远不写回主状态的键。 */
const NEVER_FROM_SIDE = new Set<string>(["agentResults", "solverDegraded", "route", "intent"]);

/**
 * 汇合规则（ACR-023 设计要点 6）：
 *  - 主 lane 的 patch **原样**应用（今天的语义，逐键相同）；
 *  - 副 lane 按意图顺序逐条：`agentResults` 改道到 `sideResults`（键不变，失败文本也在这里），
 *    `solverDegraded` / `route` / `intent` 丢弃，其余键只在本 lane 白名单内、且此前没有 lane 写过时应用；
 *  - 冲突主 lane 赢、副之间先序先写，冲突键记进 `conflicts`（`join` 节点把它写进 trace）。
 * 没有副任务时返回的 patch 与主 patch 逐键相同（不多出 `sideResults`）。
 */
export function joinLanes(state: {
  route?: RouteDecision;
  primaryLane?: LaneResult;
  sideLanes?: Record<string, LaneResult>;
}): { patch: Record<string, unknown>; conflicts: string[] } {
  const primary = state.primaryLane?.patch ?? {};
  const patch: Record<string, unknown> = { ...primary };
  const written = new Set(Object.keys(primary));
  const conflicts: string[] = [];
  const sides = sideTaskNodesOf(state.route);
  if (sides.length === 0) return { patch, conflicts };

  const sideResults: Record<string, string> = {};
  for (const { node } of sides) {
    const lane = state.sideLanes?.[sideNodeOf(node)];
    if (!lane) continue;
    const allowed = new Set<string>(laneChannelsOf(node));
    for (const [key, value] of Object.entries(lane.patch ?? {})) {
      if (key === "agentResults") {
        Object.assign(sideResults, value as Record<string, string>);
        continue;
      }
      if (NEVER_FROM_SIDE.has(key) || !allowed.has(key)) continue;
      if (written.has(key)) {
        conflicts.push(key);
        continue;
      }
      patch[key] = value;
      written.add(key);
    }
  }
  patch.sideResults = sideResults;
  return { patch, conflicts };
}

/** 副 lane 失败时写进本 lane 结果、经 join 到 `sideResults` 的文本前缀——应答据此如实说"没办成"。 */
export const SIDE_TASK_FAILED_PREFIX = "【副任务失败】";

export interface RunLaneArgs {
  lane: LaneId;
  node: WorkNode;
  state: State;
  /** 节点函数（已绑好 config）。收到的是投影后的 state。 */
  run: (view: State) => Promise<Partial<State>>;
  now?: () => number;
  onBranch?: (e: { agent: string; status: "started" | "ok" | "failed"; durationMs?: number }) => void;
  onTrace?: (e: { kind: string; data: Record<string, unknown> }) => void;
}

/**
 * lane 包装器的主体（ACR-023 设计要点 4）：**进来投影、出去写本 lane 的通道**。
 * 主副两条 lane 走同一段代码，差别只有 lane id 与投影时用哪个路由 / goal。
 *
 * - 主 lane 抛错**不吞**（与今天相同）；副 lane 抛错记成 `failed` + 失败文本，不拖垮主 lane；
 *   `AbortError` 两者都原样抛出（M33-01 取消语义）。
 * - branch 事件与 trace 只在**真分叉**的轮次发（`route.secondary` 非空）：单路由轮次不多发事件，HUD 的"并行分支"不误亮。
 * - 副 lane 按本节点名在 `route.secondary` 里找自己的那件事；找不到记 `skipped`（`route.secondary` 来自检查点，可能是老版本写的）。
 */
export async function runLane(args: RunLaneArgs): Promise<Partial<State>> {
  const now = args.now ?? Date.now;
  const forked = (args.state.route?.secondary?.length ?? 0) > 0;
  const task =
    args.lane === "side"
      ? args.state.route?.secondary?.find((t) => branchFor({ agent: t.route }) === args.node)
      : undefined;
  const agent = args.lane === "side" ? (task?.route ?? "?") : (args.state.route?.agent ?? "general");
  const tag = `${args.lane}:${agent}`;
  const startedAt = now();

  const pack = (result: LaneResult): Partial<State> =>
    args.lane === "primary" ? { primaryLane: result } : ({ sideLanes: { [sideNodeOf(args.node)]: result } } as Partial<State>);
  const trace = (status: LaneResult["status"], endedAt: number): void => {
    if (!forked) return;
    args.onTrace?.({ kind: "branch", data: { agent: tag, status, startedAt, endedAt } });
  };

  if (args.lane === "side" && !task) {
    const endedAt = now();
    trace("skipped", endedAt);
    return pack({ lane: "side", node: args.node, agent, status: "skipped", patch: {}, startedAt, endedAt });
  }

  if (forked) args.onBranch?.({ agent: tag, status: "started" });
  try {
    const view = projectLane(args.state, { lane: args.lane, node: args.node, task });
    const patch = (await args.run(view)) ?? {};
    const endedAt = now();
    if (forked) args.onBranch?.({ agent: tag, status: "ok", durationMs: endedAt - startedAt });
    trace("ok", endedAt);
    return pack({
      lane: args.lane,
      node: args.node,
      agent,
      ...(task ? { goal: task.goal } : {}),
      status: "ok",
      patch: patch as Record<string, unknown>,
      startedAt,
      endedAt,
    });
  } catch (err) {
    const endedAt = now();
    if (forked) args.onBranch?.({ agent: tag, status: "failed", durationMs: endedAt - startedAt });
    trace("failed", endedAt);
    if ((err as { name?: string })?.name === "AbortError" || args.lane === "primary") throw err;
    const message = err instanceof Error ? err.message : String(err);
    const key = resultKeyOf(task!.route) ?? task!.route;
    return pack({
      lane: "side",
      node: args.node,
      agent,
      goal: task!.goal,
      status: "failed",
      patch: { agentResults: { [key]: `${SIDE_TASK_FAILED_PREFIX}${message}` } },
      startedAt,
      endedAt,
      error: message,
    });
  }
}

const LEGACY_ORDER = ["trip", "itinerary", "ownership", "service", "buying", "test-drive", "cabin"] as const;

/**
 * 应答要表述的求解结果。
 *
 * `primary`：主路由的结果（`agentResults[resultKeyOf(route.agent)]`），取不到时回落到今天那条固定优先级链——
 * 单路由时 `text === primary` 且与旧表达式逐字相同。`useNarrator` 只看 `primary`。
 * 有副任务结果时 `text` 拼成「主要诉求 / 顺带的诉求」各一段并附一句连贯回答的要求（AC-11-5：不产生两段互不相干的输出）。
 */
export function composeSolved(state: {
  route?: RouteDecision;
  agentResults?: Record<string, string>;
  sideResults?: Record<string, string>;
}): { text?: string; primary?: string } {
  const results = state.agentResults ?? {};
  const legacy = LEGACY_ORDER.map((k) => results[k]).find((v) => v !== undefined);
  const key = resultKeyOf(state.route?.agent);
  const primary = (key ? results[key] : undefined) ?? legacy;

  const parts: { goal: string; text: string }[] = [];
  for (const task of state.route?.secondary ?? []) {
    const k = resultKeyOf(task.route);
    const text = k ? state.sideResults?.[k] : undefined;
    if (text) parts.push({ goal: task.goal, text });
  }
  if (parts.length === 0) return { text: primary, primary };

  const lines = ["【主要诉求】", primary ?? "（本轮主要诉求由应答直接回答）", ""];
  for (const p of parts) lines.push(`【顺带的诉求：${p.goal}】`, p.text, "");
  lines.push("以上各部分要写成一段连贯回答，先主后副，不要分成几段互不相干的话；顺带的诉求若没办成要如实说。");
  return { text: lines.join("\n"), primary };
}
