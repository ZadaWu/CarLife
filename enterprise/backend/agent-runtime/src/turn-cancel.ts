/**
 * 轮次取消登记表（施工单 M33-01，F-08-08 / F-14-04）。
 *
 * # 为什么要一张表
 *
 * 取消请求从 HTTP 端点进来，手上只有 `sessionId`（可能还有 `turnId`）；
 * 而能真正掐掉执行的是那一轮的 `AbortController` 与 `CancellationToken`，
 * 它们活在 `TurnRunner.run()` 的闭包里。中间缺的就是这张表。
 *
 * # 为什么不复用 `interrupt-bus` 的 `routes`
 *
 * 那张表按 **threadId** 键，语义是"权限门的挂起往哪条流里推"。
 * 混进来的话，两件毫不相干的事会开始互相牵连：改中断出口的注销时机
 * 会顺手改掉取消能不能命中，而这两处的正确性判据完全不同。
 * 少一处耦合就少一处"改了 A 坏了 B"的地方——这是 `interrupt-bus`
 * 自己文件头里已经写过一次的取向（"少一次映射就少一处会错的地方"）。
 *
 * # 取消是"停止推进"，不是"回滚"
 *
 * 沿用 FL-08 F-08-08 与 FL-14 F-14-05 的既定语义：已经发出去的副作用不撤回。
 * 落在副作用窗口内（`CancellationToken.withSideEffect`）的取消，
 * **如实告诉调用方"已经发出去了"**（`sideEffectInFlight: true`），
 * 而不是假装取消成功——外部 API 一旦发出就收不回来，骗用户比不取消更糟。
 *
 * # 幂等，且对"已经结束的轮"也返回成功
 *
 * 端上无法知道服务端刚好在这一毫秒收口了。对未命中的取消报 404，
 * 表现就是"打断这个动作时灵时不灵"——而打断恰恰是那种必须每次都有反应的动作。
 * 所以未命中返回 `{ cancelled: true, turnId: null }`：**语义是"现在没有在跑的轮了"**，
 * 这与调用方想要的结果一致。
 */

import type { CancellationToken } from "./trace";

export interface CancelResult {
  /** 恒为 true——见文件头"对已经结束的轮也返回成功"。 */
  cancelled: boolean;
  /** 实际被掐掉的轮；未命中为 null。 */
  turnId: string | null;
  /**
   * 取消落在副作用窗口内 = **动作已经发出，取消不了**。
   * 调用方（最终是端上）据此把话说清楚，不要显示"已取消"。
   */
  sideEffectInFlight: boolean;
}

interface Entry {
  sessionId: string;
  turnId: string;
  controller: AbortController;
  token: CancellationToken;
  /** 登记时刻。同一会话有多条时取最新的那一条（正常情况下只会有一条）。 */
  at: number;
}

/** turnId → 这一轮的取消把手。 */
const entries = new Map<string, Entry>();

const counters = { registered: 0, cancelled: 0, missed: 0, sideEffectInFlight: 0 };

export function cancelCounters(): Readonly<typeof counters> {
  return { ...counters };
}

/**
 * 本轮开始时登记；返回注销函数。
 *
 * **必须在 `finally` 里注销**，理由与 `interrupt-bus.registerTurnSink` 一模一样：
 * 漏掉的话表会一直长，而且下一次"取消当前轮"会命中一个早就结束的 controller，
 * 现象是"打断了但什么都没发生"。
 */
export function registerTurnCancel(
  sessionId: string,
  turnId: string,
  controller: AbortController,
  token: CancellationToken,
  now: number,
): () => void {
  const entry: Entry = { sessionId, turnId, controller, token, at: now };
  entries.set(turnId, entry);
  counters.registered += 1;
  return () => {
    // 只删自己那条：同一会话可能已经开始下一轮。
    if (entries.get(turnId) === entry) entries.delete(turnId);
  };
}

/** 这个会话此刻在跑哪一轮（有多条时取最新登记的）。 */
function currentOf(sessionId: string): Entry | undefined {
  let best: Entry | undefined;
  for (const e of entries.values()) {
    if (e.sessionId !== sessionId) continue;
    if (!best || e.at >= best.at) best = e;
  }
  return best;
}

/**
 * 取消一轮。`turnId` 省略时取消该会话当前在跑的那一轮。
 *
 * **幂等**：同一轮连取消两次，第二次照样返回成功，但 `controller.abort()`
 * 由 AbortController 自身保证只生效一次（第二次是空操作，监听器不会再触发）。
 */
export function cancelTurn(
  sessionId: string,
  turnId?: string,
  reason = "用户打断",
): CancelResult {
  const entry = turnId ? entries.get(turnId) : currentOf(sessionId);
  // 传了 turnId 但它属于别的会话：当作未命中。跨会话取消是越权，不是笔误。
  if (!entry || entry.sessionId !== sessionId) {
    counters.missed += 1;
    return { cancelled: true, turnId: null, sideEffectInFlight: false };
  }

  // `cancel()` 返回 false = 落在副作用窗口内（动作已发出）。
  const clean = entry.token.cancel(reason);
  entry.controller.abort();
  counters.cancelled += 1;
  if (!clean) counters.sideEffectInFlight += 1;

  return { cancelled: true, turnId: entry.turnId, sideEffectInFlight: !clean };
}

/** 这一轮被取消了吗。`turn-runner` 收口时用它区分"被打断"与"跑挂了"。 */
export function isTurnCancelled(turnId: string): boolean {
  return entries.get(turnId)?.token.isCancelled() ?? false;
}

/** 单测清场用。生产路径不该调它——那意味着有人在绕过 `finally`。 */
export function resetTurnCancelRegistry(): void {
  entries.clear();
  counters.registered = 0;
  counters.cancelled = 0;
  counters.missed = 0;
  counters.sideEffectInFlight = 0;
}
