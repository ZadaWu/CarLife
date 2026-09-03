/**
 * 中断出口：把权限门的挂起送进**当前这一轮的事件流**（施工单 M5-03，§3 HITL 中转）。
 *
 * # 为什么需要一条"出口"
 *
 * 权限门（`guard/http-endpoint.ts`）挂起的是一次**工具调用的 HTTP 请求**，
 * 它发生在图执行的深处，手上没有本轮的事件流句柄。
 * 而网关那一侧已经把 turn 流里的每一个 `SessionEvent` 原样转发到 SSE——
 * 所以只要把 `permission` 事件推进这条流，下行半程就自然通了，**不需要新通道**（§3 不用 WS）。
 *
 * 中间缺的就是这张表：`threadId → 本轮的 push`。
 *
 * # 为什么按 threadId 而不是 sessionId
 *
 * 权限门拿到的 `sessionId` 来自工具调用上下文，那是**图的 thread_id**（形如 `sess-xxx#<ts>`）。
 * 按它登记，`onInterrupt` 直接命中，不必再做一次映射——
 * 少一次映射就少一处"映射错了但看起来正常"的地方。
 *
 * # 送不出去时不能静默
 *
 * 一次挂起如果没人收，用户永远等不到确认弹窗，而工具调用会一直挂到超时收敛。
 * 那时的现象是"助手不说话了"，排查方向完全不指向权限门。所以未命中要计数并告警。
 */

import type { SessionEvent } from "@carlife/shared";

type Push = (event: SessionEvent) => void;

const routes = new Map<string, { push: Push; turnId: string; sessionId: string }>();
let undelivered = 0;

/** 本轮开始时登记出口；返回注销函数（必须在 finally 里调，否则表会漏）。 */
export function registerTurnSink(
  threadId: string,
  turnId: string,
  push: Push,
  /**
   * **真会话 id**（不是 threadId）。见 `currentTurnOf` —— 深处的旁路
   * （权限门、工具观察者）手上只有 threadId，而轨迹必须按真会话 id 落库。
   */
  sessionId: string,
): () => void {
  const entry = { push, turnId, sessionId };
  routes.set(threadId, entry);
  return () => {
    // 只删自己那条：同一个会话可能已经开始下一轮并覆盖了这一条。
    if (routes.get(threadId) === entry) routes.delete(threadId);
  };
}

/**
 * 该会话当前跑到哪一轮。
 *
 * 权限门的拒绝记忆要按**轮次**收敛："这一轮里这个工具已经被否过"。
 * 按入参指纹太窄——模型重试时会换措辞，四次重试就是四个不同指纹、四个弹窗（实测）；
 * 按会话又太宽——用户两分钟后重新开口要求写日历，不该被自动否掉。
 */
export function currentTurnId(threadId: string): string | undefined {
  return routes.get(threadId)?.turnId;
}

/**
 * threadId → **真会话 id + 轮次**（施工单 TD-08 任务 1）。
 *
 * # 这条换算是为了修一个"页面上看不出来"的缺陷
 *
 * ACP 那侧把 threadId 当作 `carlifeSessionId` 一路传下去
 * （`index.ts` 的 `carlifeSessionId: hooks?.threadId`），于是权限门拿到的
 * `sessionId` 其实是 `sess-xxx#<ts>`。它照原样写进轨迹，而图节点写的是
 * 真会话 id `sess-xxx` —— 回放页按真会话 id 查，**`guard` / `interrupt` /
 * `resume` 三类事件因此一条都查不出来**，且会话下拉框里同一次对话裂成两条。
 *
 * 症状是"这次没有安全裁决"，与"确实没裁决"长得一模一样，所以它能一直活着。
 *
 * **不改本模块按 threadId 登记的语义**（理由见文件头：少一次映射就少一处会错的地方），
 * 只在需要落轨迹时换算一次。
 */
export function currentTurnOf(
  threadId: string,
): { sessionId: string; turnId: string } | undefined {
  const entry = routes.get(threadId);
  return entry ? { sessionId: entry.sessionId, turnId: entry.turnId } : undefined;
}

/**
 * 二级兜底：从 threadId 的**格式**反推真会话 id（`sess-xxx#<ts>` → `sess-xxx`）。
 *
 * # 为什么光有 `currentTurnOf` 不够
 *
 * 那张表只在**本轮进行中**有条目。而权限门的裁决可能在轮次结束很久之后才落——
 * 实测有一条 `decision=deny reason=等待确认超时 durationMs=600003`：
 * 用户十分钟没点确认，裁决在轮次早已关闭后才产生。
 *
 * 此时一级换算必然落空，事件会回落到 threadId 键，于是**回放页照样看不到它**。
 * 而"确认超时导致动作被拒"恰恰是 F-29-07 最该被看见的那类安全事件——
 * 它比放行更需要留痕，却正好是最容易漏掉的一条。
 *
 * # 这是格式耦合，所以写在这里而不是散在调用点
 *
 * threadId 由 `turn-runner.threadFor` 生成，形如 `${sessionId}#${nowMs}`，
 * 而 sessionId 自身不含 `#`（`sess-<uuid8>-<3>`）。按**最后一个** `#` 切是可靠的。
 * 这份格式知识只应存在于一处；改了生成规则，改这里。
 * 认不出格式时返回 undefined —— **不猜**，由调用方按 keyFallback 如实标注。
 */
export function sessionIdFromThread(threadId: string): string | undefined {
  const i = threadId.lastIndexOf("#");
  if (i <= 0) return undefined;
  const head = threadId.slice(0, i);
  // 尾巴必须是纯数字时间戳，否则那个 `#` 不是我们加的。
  return /^\d+$/.test(threadId.slice(i + 1)) ? head : undefined;
}

/**
 * 把事件送进对应会话本轮的流。
 *
 * 返回是否送达。**送不出去要让调用方知道**——把它吞掉，
 * 表现就是"权限门挂起了但用户什么都没看到"，而这两件事看起来毫无关联。
 */
export function publishToTurn(threadId: string, event: SessionEvent): boolean {
  const entry = routes.get(threadId);
  if (!entry) {
    undelivered += 1;
    return false;
  }
  entry.push(event);
  return true;
}

export function getInterruptBusStats(): { openTurns: number; undelivered: number } {
  return { openTurns: routes.size, undelivered };
}
