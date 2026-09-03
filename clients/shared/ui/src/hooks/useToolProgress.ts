/**
 * 工具进展的端上聚合（FL-08 F-08-05）。
 *
 * # 为什么需要聚合，而不是"收到什么显示什么"
 *
 * 一轮出行规划里工具是**并发跑**的：实测同一轮 `weather` 调了五次、
 * `poi_search` 三次，起止交错。照单显示最后一条的话，
 * 屏幕上那句话会在"正在查天气/正在找地点"之间来回跳，
 * 而且某一条先返回时会把还在跑的那些一起抹掉——**看起来像卡住了**。
 *
 * 所以按 `toolCallId` 记在飞的调用，显示其中最新开始的那个；
 * 全部结束才回到"没有进展可说"。
 *
 * # 为什么按 id 而不是按工具名
 *
 * 同一个工具同一轮会被调好几次。按名字配对时，第一次的"完成"会把
 * 第五次的"进行中"也一并销掉，于是进度提前消失而链路还在跑。
 *
 * # 它不进历史
 *
 * 这些句子是"此刻"信息：桥接层不写缓存（`fanout::project` 不碰 `acc`）、
 * 网关不进补发窗口（`isEphemeral`）、这里也只是一个内存态。
 * 一轮结束必须 `reset()`——否则上一轮的尾巴会挂在下一轮开头。
 */

import { useCallback, useMemo, useState } from "react";

export interface ToolProgressEvent {
  toolCallId: string;
  toolName: string;
  displayName: string;
  status: "started" | "succeeded" | "failed";
}

/** 在飞的调用：`toolCallId → 人话`，按到达顺序排（后面的更新）。 */
export type ToolProgressState = ReadonlyArray<{ id: string; text: string }>;

export const EMPTY_PROGRESS: ToolProgressState = [];

/** 纯函数，便于单测——这里会算错的地方全在并发那几条上。 */
export function applyToolProgress(
  state: ToolProgressState,
  e: ToolProgressEvent,
): ToolProgressState {
  if (e.status === "started") {
    // 重复的 started（重连补发不会发生，但服务端重试会）不叠加。
    if (state.some((x) => x.id === e.toolCallId)) return state;
    return [...state, { id: e.toolCallId, text: e.displayName }];
  }
  const next = state.filter((x) => x.id !== e.toolCallId);
  // 没变化就返回原数组：让 React 少一次重渲染，也让"结束了一个不存在的调用"
  // 这种情况不产生任何副作用（轮次已收口后迟到的回调会这样）。
  return next.length === state.length ? state : next;
}

/** 当前该显示哪一句；没有在飞的调用时为 null。 */
export function currentProgress(state: ToolProgressState): string | null {
  return state.length === 0 ? null : state[state.length - 1].text;
}

export function useToolProgress(): {
  /** 直接交给对话层显示；null = 没有进展可说（**不要**在这时编一句）。 */
  progress: string | null;
  onToolCall: (e: ToolProgressEvent) => void;
  /** 轮次收口时调用。漏了的表现是上一轮的尾巴挂在下一轮开头。 */
  reset: () => void;
} {
  const [state, setState] = useState<ToolProgressState>(EMPTY_PROGRESS);
  const onToolCall = useCallback((e: ToolProgressEvent) => {
    setState((prev) => applyToolProgress(prev, e));
  }, []);
  const reset = useCallback(() => setState(EMPTY_PROGRESS), []);
  /*
   * 返回值必须 memo（M28-01 事故）。裸对象字面量每次渲染都是新身份，
   * 消费方一旦把整个返回值放进 useCallback/useEffect 的依赖数组，
   * 那条依赖链就永远不稳定——cockpit 的订阅 + bootstrap effect 曾因此每次渲染
   * 都整段重跑，最终指数增殖到 WebView 白屏。memo 后身份只随 progress 变。
   */
  const progress = currentProgress(state);
  return useMemo(() => ({ progress, onToolCall, reset }), [progress, onToolCall, reset]);
}
