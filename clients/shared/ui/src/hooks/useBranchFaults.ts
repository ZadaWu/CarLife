/**
 * 分支失败的端上聚合（M37-01，F-13-03/F-13-07）。
 *
 * # 它解决什么
 *
 * fanout 的某条分支 failed/timeout 时，服务端会发 `update.branch`（带人话 `note`），
 * 但此前端上没人消费——失败信息只可能出现在应答正文里，**用户看不看得到取决于
 * 模型自觉**。这里把 failed/timeout 聚合成本轮的"部分结果"清单，交给对话层
 * 渲染成结构化横幅；真相源是事件里的结构化 status，不是正文文字。
 *
 * # 为什么只留 failed/timeout
 *
 * started/ok 是进展信息，进展的呈现是另一件事（且分支一多会刷屏）；
 * 本 hook 只管"哪些没拿到"。同一分支先 failed 后不会再来事件（fanout 每分支
 * 恰一条终态），按 (轮, agent) 去重只是防服务端重试补发。
 *
 * # 归属于哪一轮由 `turnId` 决定，不由清理时机决定（M94-02）
 *
 * `UpdateBranch.turnId` 一直都在、一路透传到端上，而这里曾经把它丢掉——
 * 于是横幅成了"屏幕级"的东西，只能靠两个 `reset()`（换会话 / 用户发言）猜轮次边界。
 * 猜不中的那一刻正是最糟的那一刻：用户既没发下一句也没换会话，屏幕上摆着
 * 第一轮的回答，横幅说的却是第二轮的失败（sess-67477977-b21，2026-09-16——
 * 那一轮五条分支全 ok、零失败，而横幅列着三条）。
 *
 * 现在 `faults` 只给**最新一轮**那组；`reset()` 保留，但它的职责退化成内存卫生
 * （换会话时别把上个会话的东西留着），不再承担正确性。
 *
 * # 它不进历史
 *
 * 与工具进展同一纪律：桥接层不写缓存、这里只是内存态。
 */

import { useCallback, useMemo, useState } from "react";

export interface BranchFaultEvent {
  /** 这条失败属于哪一轮（`UpdateBranch.turnId`，服务端一直都带着）。 */
  turnId: string;
  agent: string;
  status: "started" | "ok" | "failed" | "timeout";
  /** 服务端给的人话（"酒店安排超时未返回"）；null 时退化为 agent 名。 */
  note: string | null;
}

/** 已失败的分支：`(轮, agent) → 人话`，按到达顺序排。 */
export type BranchFaultState = ReadonlyArray<{ turnId: string; agent: string; text: string }>;

export const EMPTY_FAULTS: BranchFaultState = [];

/** 纯函数，便于单测。 */
export function applyBranchFault(state: BranchFaultState, e: BranchFaultEvent): BranchFaultState {
  if (e.status !== "failed" && e.status !== "timeout") return state;
  /*
   * 去重键是 **(轮, agent)** 而不是 agent（M94-02）：体检修复轮会对同一个
   * Agent 在同一轮里再发一次，那是同一轮的重复终态，该去重；而跨轮的同名分支
   * 是两件事——只按 agent 去重会把后一轮那条**整条丢掉**，横幅于是说着上一轮的话。
   */
  if (state.some((x) => x.agent === e.agent && x.turnId === e.turnId)) return state;
  return [...state, { turnId: e.turnId, agent: e.agent, text: e.note ?? e.agent }];
}

/**
 * 只留最新一轮那组（M94-02）。横幅讲的是"**这轮**答案缺了什么"，
 * 上一轮的缺失挂在这一轮的回答上方就是假警报。
 *
 * 全同一轮时返回原引用——少一次重渲染，与 `applyBranchFault` 同一条纪律。
 */
export function faultsOfCurrentTurn(state: BranchFaultState): BranchFaultState {
  if (state.length === 0) return state;
  const turnId = state[state.length - 1].turnId;
  if (state.every((f) => f.turnId === turnId)) return state;
  return state.filter((f) => f.turnId === turnId);
}

export function useBranchFaults(): {
  /**
   * **最新一轮**失败分支的人话清单；空数组 = 没有要标识的（**不要**渲染横幅）。
   * 过滤在这里做，消费方拿到的就是能直接渲染的那一组——组件不该再判断轮次归属。
   */
  faults: BranchFaultState;
  /** 本会话收到的全部（含更早的轮次）。排障与测试用，渲染别用它。 */
  all: BranchFaultState;
  onBranch: (e: BranchFaultEvent) => void;
  /** 换会话时调用。别的会话的缺失不该留在内存里；轮次归属已由 turnId 保证。 */
  reset: () => void;
} {
  const [state, setState] = useState<BranchFaultState>(EMPTY_FAULTS);
  const onBranch = useCallback((e: BranchFaultEvent) => {
    setState((prev) => applyBranchFault(prev, e));
  }, []);
  const reset = useCallback(() => setState(EMPTY_FAULTS), []);
  const faults = useMemo(() => faultsOfCurrentTurn(state), [state]);
  // 返回值 memo：与 useToolProgress 同一条 M28-01 事故纪律（裸字面量会让
  // 消费方的依赖链永远不稳定，订阅 effect 整段重跑直至 WebView 白屏）。
  return useMemo(() => ({ faults, all: state, onBranch, reset }), [faults, state, onBranch, reset]);
}
