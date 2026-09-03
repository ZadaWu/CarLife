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
 * 恰一条终态），按 agent 去重只是防服务端重试补发。
 *
 * # 它不进历史
 *
 * 与工具进展同一纪律：桥接层不写缓存、这里只是内存态。
 * 一轮收口必须 `reset()`——上一轮的"部分结果"挂到下一轮开头会变成假警报。
 */

import { useCallback, useMemo, useState } from "react";

export interface BranchFaultEvent {
  agent: string;
  status: "started" | "ok" | "failed" | "timeout";
  /** 服务端给的人话（"酒店安排超时未返回"）；null 时退化为 agent 名。 */
  note: string | null;
}

/** 本轮已失败的分支：`agent → 人话`，按到达顺序排。 */
export type BranchFaultState = ReadonlyArray<{ agent: string; text: string }>;

export const EMPTY_FAULTS: BranchFaultState = [];

/** 纯函数，便于单测。 */
export function applyBranchFault(state: BranchFaultState, e: BranchFaultEvent): BranchFaultState {
  if (e.status !== "failed" && e.status !== "timeout") return state;
  // 服务端重试导致的重复终态不叠加。
  if (state.some((x) => x.agent === e.agent)) return state;
  return [...state, { agent: e.agent, text: e.note ?? e.agent }];
}

export function useBranchFaults(): {
  /** 本轮失败分支的人话清单；空数组 = 没有要标识的（**不要**渲染横幅）。 */
  faults: BranchFaultState;
  onBranch: (e: BranchFaultEvent) => void;
  /** 轮次收口时调用。漏了的表现是上一轮的"部分结果"挂在下一轮开头。 */
  reset: () => void;
} {
  const [state, setState] = useState<BranchFaultState>(EMPTY_FAULTS);
  const onBranch = useCallback((e: BranchFaultEvent) => {
    setState((prev) => applyBranchFault(prev, e));
  }, []);
  const reset = useCallback(() => setState(EMPTY_FAULTS), []);
  // 返回值 memo：与 useToolProgress 同一条 M28-01 事故纪律（裸字面量会让
  // 消费方的依赖链永远不稳定，订阅 effect 整段重跑直至 WebView 白屏）。
  return useMemo(() => ({ faults: state, onBranch, reset }), [state, onBranch, reset]);
}
