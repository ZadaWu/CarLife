/**
 * 业务视图的「在编排图上的位置」（2026-09-15）——把 23 个节点的主链路图折成六个站点。
 *
 * # 为什么折，而不是直接给业务人员看那张图
 *
 * `RunFlow` 画的是整张图：副 lane、汇合、narrator 与 answer-agent 两条出路……
 * 这些是研发对账要的，业务人员看到的是一屏方框和箭头。业务人员要回答的只是
 * "这一轮走到了哪、在哪一步出的事"，六个站点够了：
 *
 *   听懂问题 → 安全检查 → 决定交给谁 → 专家处理 → 组织回答 → 回复车主
 *
 * # 但**不另起一份节点表**
 *
 * `RunFlow` 的文件头警告过：简版意味着第二份节点表，它会漂，而且漂的方式是
 * "这张小图上没有的那一步你以为不存在"。所以这里不重新解读轨迹——
 * 站点的亮灭**直接从 `projectRun` 的 `GraphRun` 投影**：图上哪个节点亮了，
 * 它所属的站点就亮。这里唯一的新东西是 `STATION_OF`（节点 id → 站点），
 * 而 `business-path.test.ts` 逐个核对 `WORKFLOW_NODES` 里每个 id 都在表里——
 * 上游加了节点、这里没跟，测试先红。
 */

import { WORKFLOW_NODES } from "../workflow/graph-model";
import type { GraphRun, NodeState } from "../workflow/projection";

export type StationId = "understand" | "gate" | "dispatch" | "experts" | "answer" | "reply";

export interface StationDef {
  id: StationId;
  label: string;
  /** 业务人员看的一句话："这一步在干什么"。 */
  hint: string;
}

export const STATIONS: readonly StationDef[] = [
  { id: "understand", label: "听懂问题", hint: "从这句话里抽出目标、约束，判断该交给谁" },
  { id: "gate", label: "安全检查", hint: "硬禁范畴（自动驾驶决策、车辆安全控制等）在这里拦住" },
  { id: "dispatch", label: "决定交给谁", hint: "按理解结果把这一轮派给某个专项，顺带的事派副任务" },
  { id: "experts", label: "专家处理", hint: "专项 Agent 查资料、算方案；多位专家可能同时进行" },
  { id: "answer", label: "组织回答", hint: "把求解结果讲成给车主听的话" },
  { id: "reply", label: "回复车主", hint: "本轮收口，回答推到端上" },
];

/**
 * 图节点 → 站点。**每个 `WORKFLOW_NODES` 的 id 都必须在这里**（测试守着）。
 * `deny-end` 归安全检查：被拒的那一轮停在那一站，不会再往后亮。
 */
export const STATION_OF: Record<string, StationId> = {
  start: "understand",
  observeAttachments: "understand",
  understand: "understand",
  "supervisor-intent": "understand",
  riskGate: "gate",
  "deny-end": "gate",
  dispatch: "dispatch",
  itineraryPlan: "experts",
  "drive-task": "experts",
  "hotel-task": "experts",
  "tour-task": "experts",
  "transit-task": "experts",
  "ownership-task": "experts",
  ownershipDual: "experts",
  buyingCatalog: "experts",
  testDriveFlow: "experts",
  cabinCompanion: "experts",
  "cabin-task": "experts",
  sideItineraryPlan: "experts",
  sideOwnershipDual: "experts",
  sideBuyingCatalog: "experts",
  sideTestDriveFlow: "experts",
  sideCabinCompanion: "experts",
  join: "experts",
  guard: "experts",
  tools: "experts",
  // HTTP 直触发的子图（M36 导游、M66 导航）：不经路由，但对业务人员它们就是"专家在处理"。
  "entry-http": "experts",
  navPlan: "experts",
  "nav-task": "experts",
  guideBrief: "experts",
  "guide-access-task": "experts",
  "guide-spots-task": "experts",
  "guide-comfort-task": "experts",
  answer: "answer",
  narrator: "answer",
  "answer-agent": "answer",
  end: "reply",
};

export type StationState = "done" | "failed" | "active" | "skipped";

export interface StationRun {
  id: StationId;
  label: string;
  hint: string;
  state: StationState;
  /** 这一站上亮着的节点名（研发对账用，业务视图放在 hover 里）。 */
  nodes: string[];
  /** 这一站的墙钟耗时：所属节点 span 的**并集**——并行分支不重复计。 */
  durationMs?: number;
}

/**
 * 站点耗时用并集：`itineraryPlan` 与它里面四个 `-task` 节点都归"专家处理"，
 * 求和会把 30 秒算成 90 秒。这里没有各节点的起止（`GraphRun` 只有 durationMs），
 * 所以取**同站内最大的那个**作为并集的近似——容器节点一定比它里面的任何分支长。
 */
function stationDuration(runs: Array<{ durationMs?: number }>): number | undefined {
  const known = runs.map((r) => r.durationMs).filter((d): d is number => d !== undefined);
  return known.length ? Math.max(...known) : undefined;
}

export function projectStations(run: GraphRun): StationRun[] {
  const out: StationRun[] = [];
  let denied = false;
  for (const def of STATIONS) {
    const hits = [...run.nodes.entries()].filter(([id]) => STATION_OF[id] === def.id);
    const states = hits.map(([, r]) => r.state);
    let state: StationState = "skipped";
    if (states.includes("failed")) state = "failed";
    else if (hits.some(([id]) => run.current === id)) state = "active";
    else if (states.length > 0) state = "done";
    if (def.id === "gate" && run.nodes.has("deny-end")) {
      state = "failed";
      denied = true;
    }
    // 被拒之后的站点不叫"跳过"——它们是**没资格走到**，与"这一轮不需要"要分开。
    out.push({
      id: def.id,
      label: def.label,
      hint: def.hint,
      state: denied && def.id !== "gate" ? "skipped" : state,
      nodes: hits.map(([id]) => id),
      durationMs: stationDuration(hits.map(([, r]) => r)),
    });
  }
  return out;
}

/** 测试与自检用：图上有、表里没有的节点。正常时为空数组。 */
export function unmappedGraphNodes(): string[] {
  return WORKFLOW_NODES.map((n) => n.id).filter((id) => !(id in STATION_OF));
}

export type { NodeState };
