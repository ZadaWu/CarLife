/**
 * 把一轮（或一段实时流）的轨迹**投影到主链路图上**。
 *
 * # 为什么是纯函数，且与渲染分开
 *
 * "这一轮流到哪了"这件事会算错的地方全在映射规则上：span 名到节点、
 * 应答走的是直连表述还是 ACP 会话、哪条条件边真的被走了。
 * 把它从组件里拆出来，这些规则就变成可单测的——否则只能靠眼睛看，
 * 而"图上高亮了一条其实没走的路"正好是最难被发现的那类错。
 *
 * # 三个来源，缺一不可
 *
 * 1. `node.*` span —— 节点**结束**时才落。它给的是耗时与成败，
 *    但**回答不了"现在在哪"**：一个跑了 30 秒的节点，这 30 秒里一条都没有。
 * 2. 内容事件（`intent` / `risk` / `route` / `branch` / `tool_call` / `guard` …）
 *    —— 在节点**进行中**就落。实时流看的主要是它们。
 * 3. `llm.*` span 的 agent 名 —— 应答那一步到底走了哪条出路只有它知道：
 *    `llm.trip-voice` 是直连表述，`llm.trip` 是回主链路的 ACP 会话。
 *
 * # 没走到的节点压暗，不删掉
 *
 * 整张图必须还在。只画走过的那条路，读者看到的是"这一轮的路径"，
 * 而不是"这一轮在整张图上的位置"——后者才是这个视图存在的理由。
 */

import { WORKFLOW_EDGES, WORKFLOW_NODES, type WorkflowEdge } from "./graph-model";

export interface TraceLike {
  kind: string;
  at: number;
  turnId?: string;
  data: Record<string, unknown>;
}

export type NodeState = "done" | "failed" | "active";

export interface NodeRun {
  state: NodeState;
  /** 有 span 才有；进行中的节点没有。 */
  durationMs?: number;
  /** 方框上要补一行的短说明（"3 次""deny"…）。 */
  note?: string;
}

export interface GraphRun {
  nodes: Map<string, NodeRun>;
  /** 真的被走过的边（`from→to`）。 */
  edges: Set<string>;
  /** 这一轮/这一刻停在哪个节点；轮次已结束时为 undefined。 */
  current?: string;
  /** 路由落到的分支节点。取不到时 undefined——**不猜**。 */
  branch?: string;
  /** 轨迹里出现了、但图上没有这个节点（如已下线的 `tripFanout`）。 */
  unknownNodes: string[];
  /** 这一轮是否已收口（有 `turn_end`）。 */
  finished: boolean;
}

/** 应答那一步的六个业务 Agent（与 `supervisor.ts` 的 `ANSWER_AGENTS` 同一份名单）。 */
const ANSWER_AGENTS = new Set(["trip", "ownership", "service", "buying", "test-drive", "cabin"]);

/** 图上画了方框的 fan-out 分支 Agent。轨迹里的 agent 名带 `-task` 后缀，与图上的 id 相同。 */
const BRANCH_AGENTS = new Set(
  WORKFLOW_NODES.filter((n) => n.kind === "agent" && n.id.endsWith("-task")).map((n) => n.id),
);

/**
 * 分支 → 驱动它的节点。**从图的边里取，不另写一张表**：
 * 这里曾是一个三元表达式（`cabin-task ? cabinCompanion : itineraryPlan`），
 * 于是 M66 的 `nav-task` 被连到了 itineraryPlan 上——一条指向不存在节点的边，
 * 渲染层静默丢掉，谁也不知道。图上每个分支都只有一条入边（validateGraph 的叶子检查），
 * 所以这张映射是唯一的。
 */
const DRIVER_OF: Record<string, string> = Object.fromEntries(
  WORKFLOW_EDGES.filter((e) => BRANCH_AGENTS.has(e.to)).map((e) => [e.to, e.from]),
);

/**
 * HTTP 触发的子图节点（M36 导游、M66 导航）。它们**没有 `node.*` span、没有 `route` 事件**：
 * 不是图节点，也不经路由。轨迹里能看到的只有分支自己（`llm.nav-task`、`branch`）——
 * 所以驱动节点与点击入口要由分支**反推**着亮起来，否则一轮导航规划画出来
 * 只有右下角一个方框亮着，左边的入口与策略节点全暗，像是它凭空出现的。
 */
const HTTP_NODES = new Set(WORKFLOW_NODES.filter((n) => n.viaHttp).map((n) => n.id));
const HTTP_ENTRY = "entry-http";

const GRAPH_NODE_IDS = new Set(WORKFLOW_NODES.map((n) => n.id));

/**
 * 路由目标 → 图节点。**与 `route.ts` 的 `branchFor` 是同一张表**，
 * 只是这边吃的是轨迹里已经落下来的 `route.agent`。
 *
 * 两处各写一份的风险是真实的（`service` 漏接 `ownershipDual` 那次就是），
 * 所以 `graph-drift.test.ts` 会拿源码里的 `branchFor` 校验这张表的值域。
 */
const BRANCH_OF: Record<string, string> = {
  itinerary: "itineraryPlan",
  // 历史检查点里还有旧值 `trip`，一并映过来——否则老会话的回放会说"没路由到任何分支"。
  trip: "itineraryPlan",
  ownership: "ownershipDual",
  service: "ownershipDual",
  buying: "buyingCatalog",
  testDrive: "testDriveFlow",
  cabin: "cabinCompanion",
  general: "answer",
};

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * `live` 决定要不要给 `current`。
 *
 * **默认 false，这不是保守而是不说谎**：会话页看的是早已结束的一轮，
 * 对着它说"此刻在这里"是一句假话。而轨迹里**根本没有轮次边界**——
 * `turn_start` / `turn_end` 两个 kind 声明了却从来没有人写（2026-08-26 实测
 * 一条真实会话：37 条事件里 span 27 / prompt 4 / intent 2 / risk 2 / route 2，
 * 一条轮次事件都没有），所以"结束了没有"这件事投影自己判不出来，
 * 只能由调用方告诉它。
 */
export function projectRun(
  events: readonly TraceLike[],
  opts: { live?: boolean } = {},
): GraphRun {
  const nodes = new Map<string, NodeRun>();
  const edges = new Set<string>();
  const unknown = new Set<string>();
  let branch: string | undefined;
  let finished = false;
  let answerAgentPath: "narrator" | "answer-agent" | undefined;
  /** 最后一次"我们知道自己在哪"的节点。实时视图的 `current` 从它来。 */
  let last: string | undefined;

  const mark = (id: string, run: NodeRun): void => {
    if (!GRAPH_NODE_IDS.has(id)) {
      unknown.add(id);
      return;
    }
    const prev = nodes.get(id);
    // 失败**永远盖过**成功：一个节点里既有失败又有成功时，
    // 显示成功等于把最该看见的那一条藏起来（回放页同一取向：不做过滤）。
    const state: NodeState =
      prev?.state === "failed" || run.state === "failed"
        ? "failed"
        : prev?.state === "done" || run.state === "done"
          ? "done"
          : "active";
    nodes.set(id, {
      state,
      durationMs: run.durationMs ?? prev?.durationMs,
      note: run.note ?? prev?.note,
    });
    if (run.state !== "active" || !prev) last = id;
  };

  /**
   * 一个 fan-out 分支有了动静（`branch` 事件或 `llm.<agent>` span）。
   *
   * 分支由驱动它的节点拉起，不是自己往下走：连的是"谁发的"这条边。
   * HTTP 触发的那两条子图没有别的事件能让驱动节点与点击入口亮起来，
   * 所以在这里一并反推：入口 → 驱动节点是条件边（一次点击只触发一条），
   * 必须显式加，最后那轮"两端都走过就补边"不会替它补。
   */
  const httpBranches = new Map<string, Map<string, NodeState>>();
  const touchBranch = (agent: string, state: NodeState, durationMs?: number): void => {
    const driver = DRIVER_OF[agent];
    if (driver && HTTP_NODES.has(driver)) {
      // 先亮入口与驱动节点、再亮分支：`last`（实时视图的"此刻在这里"）要停在分支上。
      mark(HTTP_ENTRY, { state: "done" });
      edges.add(`${HTTP_ENTRY}→${driver}`);
      if (!nodes.has(driver)) mark(driver, { state: "active" });
      let branches = httpBranches.get(driver);
      if (!branches) httpBranches.set(driver, (branches = new Map()));
      branches.set(agent, state);
    }
    mark(agent, { state, durationMs });
    if (driver) edges.add(`${driver}→${agent}`);
  };

  for (const e of events) {
    const d = e.data;

    if (e.kind === "turn_start") {
      mark("start", { state: "done" });
      continue;
    }
    if (e.kind === "turn_end") {
      finished = true;
      mark("end", { state: "done" });
      continue;
    }

    /*
     * "进了哪个节点"——**只有实时通道有这条**（运行时的 `noteNodeStart`）。
     *
     * 它存在的唯一理由：`node.*` 的 span 是节点结束时才落的，
     * 一个跑 30 秒的应答节点，那 30 秒里落库那边一条都没有，
     * 而那正好是最需要知道"它在哪"的 30 秒。
     */
    if (e.kind === "node_start") {
      const name = str(d.name) ?? "";
      if (name.startsWith("node.")) {
        const id = name.slice(5);
        mark(id, { state: "active" });
        // `mark` 不会为 active 覆盖 `last`（它优先记"确定完成过"的那些），
        // 但进节点这件事就是最新的确切位置，必须盖上去。
        if (GRAPH_NODE_IDS.has(id)) last = id;
      }
      continue;
    }

    if (e.kind === "span") {
      const name = str(d.name) ?? "";
      const status = d.status === "failed" ? "failed" : "done";
      const durationMs = typeof d.durationMs === "number" ? d.durationMs : undefined;

      if (name.startsWith("node.")) {
        mark(name.slice(5), { state: status, durationMs });
        continue;
      }
      if (name.startsWith("tool.")) {
        mark("tools", { state: status });
        continue;
      }
      if (name.startsWith("llm.")) {
        // `llm.x.ttft` 是首 token 的计时，不是另一次调用——算进去会重复。
        if (name.endsWith(".ttft")) continue;
        const agent = name.slice(4);
        if (agent.endsWith("-intent")) mark("supervisor-intent", { state: status, durationMs });
        else if (BRANCH_AGENTS.has(agent)) touchBranch(agent, status, durationMs);
        else if (agent.endsWith("-voice")) {
          answerAgentPath = "narrator";
          mark("narrator", { state: status, durationMs });
        } else if (ANSWER_AGENTS.has(agent) || agent === "supervisor") {
          answerAgentPath = "answer-agent";
          mark("answer-agent", { state: status, durationMs });
        }
        continue;
      }
      // `guard.action` 是动作权限门；`guard.input` 是**内容管线**，不在这张图上
      // （图上的 guard 方框指的是 /internal/guard/check）。混为一谈会让人以为
      // 每轮对话都过了动作权限门。
      if (name === "guard.action") mark("guard", { state: status, durationMs });
      continue;
    }

    switch (e.kind) {
      case "intent":
        mark("understand", { state: "done" });
        mark("supervisor-intent", { state: "done" });
        break;
      case "risk": {
        const decision = str(d.decision);
        mark("riskGate", { state: "done", note: decision ? `判定 ${decision}` : undefined });
        // 两支都要显式记：它们是条件边，靠"两端都走过"推断不出走的是哪一支——
        // 而"图上亮起一条其实没走的路"看起来完全正常。
        if (decision === "deny") {
          mark("deny-end", { state: "done" });
          edges.add("riskGate→deny-end");
          finished = true;
        } else {
          edges.add("riskGate→dispatch");
        }
        break;
      }
      case "route": {
        const agent = str(d.agent);
        mark("dispatch", { state: "done", note: agent });
        const target = agent ? BRANCH_OF[agent] : undefined;
        if (target) {
          branch = target;
          edges.add(`dispatch→${target}`);
          // 路由已定但分支还没落任何事件时，"在哪"就是这个分支——
          // 实时视图最需要的正是这一步。
          mark(target, { state: "active" });
          last = target;
        }
        break;
      }
      case "branch": {
        const agent = str(d.agent);
        if (!agent) break;
        const status = str(d.status);
        const state: NodeState = status === "ok" ? "done" : status ? "failed" : "active";
        // `started` 是 SSE 分支事件的状态之一；轨迹里的 branch 只在收口后落（有 startedAt/endedAt），
        // 但实时通道会把 started 也送过来——那时分支还在跑。
        touchBranch(agent, status === "started" ? "active" : state);
        break;
      }
      case "merge":
        if (branch) mark(branch, { state: "done" });
        break;
      case "tool_call": {
        const status = str(d.status);
        mark("tools", { state: status === "failed" ? "failed" : "done", note: str(d.name) });
        break;
      }
      case "guard":
      case "commit": {
        const decision = str(d.decision);
        mark("guard", { state: "done", note: decision });
        break;
      }
      case "interrupt":
        mark("guard", { state: "active", note: "等待确认" });
        break;
      case "resume":
        mark("guard", { state: "done", note: "已确认" });
        break;
      default:
        break;
    }
  }

  /*
   * HTTP 子图的驱动节点跟着它的分支走：有一支还在跑它就还在跑，全部收口才算 done。
   * 分支失败它也是 done 不是 failed——那是"降级"：导航无提交会退化成起终点直连，
   * 导游少一支照样出简报。直接写 `nodes` 而不经 `mark`：这一步不该改 `last`，
   * 否则实时视图的"此刻在这里"会从分支跳回驱动节点。
   */
  for (const [driver, branches] of httpBranches) {
    if ([...branches.values()].some((s) => s === "active")) continue;
    const prev = nodes.get(driver);
    if (prev) nodes.set(driver, { ...prev, state: "done" });
  }

  // 应答：`node.answer` 的 span 只有结束时才有，但只要出现过 `llm.*` 的应答会话，
  // 说明已经走到这一步了。
  if (answerAgentPath) {
    if (!nodes.has("answer")) mark("answer", { state: "active" });
    edges.add(`answer→${answerAgentPath}`);
  }

  // 走过的节点之间，把图上真实存在的边补齐（条件边只补上面显式判定过的那些）。
  const explicit = new Set(edges);
  for (const e of WORKFLOW_EDGES) {
    const key = `${e.from}→${e.to}`;
    if (explicit.has(key)) continue;
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    // 条件边不靠"两端都走过"推断：`dispatch` 与 `answer` 都走过并不意味着
    // 走的是 `dispatch → answer` 那一支——它可能绕了整条分支再回来。
    if (e.conditional) continue;
    edges.add(key);
  }

  // 最后一件已知的事已经做完、轮次却没收口时仍然给 current：
  // **说"停在这一步之后"比说"不知道"有用**，但节点状态保持 done，不假装它还在跑。
  const current = opts.live && !finished ? last : undefined;

  return {
    nodes,
    edges,
    current,
    branch,
    unknownNodes: [...unknown],
    finished,
  };
}

/** 这条边在这一轮走过没有。 */
export function edgeWalked(run: GraphRun, e: WorkflowEdge): boolean {
  return run.edges.has(`${e.from}→${e.to}`);
}
