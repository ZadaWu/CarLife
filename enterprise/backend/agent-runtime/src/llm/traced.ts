/**
 * LLM 调用的分跳耗时（施工单 TD-08 任务 3，FL-44 F-44-04）。
 *
 * # 为什么包在 `ChatStreamer` 这一层
 *
 * 这是**唯一**同时覆盖两条路径的接缝：ACP 实现（经 pi 子进程）与直连实现
 * （AI SDK / fake）都实现同一个接口。包在这里，"哪次 LLM 调用花了多久"
 * 对两条路径同时成立，且换掉 pi 不需要重埋。
 *
 * # 首 token 延迟必须单列（工单约束 5）
 *
 * 只记总时长，会把"8 秒流式输出完"和"8 秒才开口"画成同一根条——
 * 而这两件事的优化方向相反：前者要缩短生成，后者要缩短排队/首包。
 * 用户说的"感觉要等好久"，等的几乎总是后者。
 *
 * 因此每次调用发**两条** span：
 *   - `llm.<agent>.ttft` —— 从发起到第一个**非空** chunk
 *   - `llm.<agent>`      —— 整条流的总时长
 *
 * 空 chunk 不算首 token：ACP 侧会先推一个空的 `session/update` 占位，
 * 拿它当首字会把 TTFT 记成 20ms 而用户还在干等。
 *
 * # 已有的 `onUsage.durationMs` 不能替代它
 *
 * 那条进的是**用量表**（按 provider/model 聚合算成本），既没有 TTFT，
 * 也不按跳落进轨迹——回放页读不到。两者用途不同，都保留。
 */

import { CancelledError, type SpanStatus } from "../trace";
import { recordSpan } from "../trace/span";
import type { ChatStreamer } from "./index";

/**
 * 这次抛错是不是**调用方自己放弃**的结果。
 *
 * 三个判据缺一不可，因为两条路径的取消错误长得不一样：
 *  - ACP：`connection.ts` 的 onAbort 抛 `CancelledError`；
 *  - 直连：AI SDK 对 `abortSignal` 抛 `AbortError`（DOMException，不是我们的类）；
 *  - 兜底：只要 hooks 里的 signal 已经 aborted，此后冒出来的任何错都是取消的余波
 *    （掐流的时机不同，浮出来的错误类型也不同）。
 *
 * 分不出取消与失败的代价在 M30-02 踩过：「提交即收工」abort 分支流之后，
 * 一次**成功**的调用被记成 failed，行程 fan-out 每轮三条 llm span 全红。
 */
function isCancellation(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (err instanceof CancelledError) return true;
  return err instanceof Error && err.name === "AbortError";
}

/** 取消原因（fanout 经 `abort(reason)` 带过来：submitted / timeout / …）。 */
function cancelReason(signal: AbortSignal | undefined): string | undefined {
  return typeof signal?.reason === "string" ? signal.reason : undefined;
}

/**
 * 给任意 `ChatStreamer` 套上耗时埋点。
 *
 * **原样透传 hooks**（工单约束 3）：`threadId` / `agent` 决定 pi 侧落到哪个 ACP 会话，
 * 漏传的后果不是报错，是意图抽取与应答共用会话——用户会收到一段 `{"goal":…}` JSON。
 */
export function withLlmSpans(inner: ChatStreamer): ChatStreamer {
  return async function* (messages, hooks) {
    const agent = hooks?.agent ?? "unknown";
    const threadId = hooks?.threadId;
    const name = `llm.${agent}`;
    const startedAt = Date.now();
    let firstTokenAt: number | undefined;
    let status: SpanStatus = "ok";

    try {
      for await (const chunk of inner(messages, hooks)) {
        if (firstTokenAt === undefined && chunk.length > 0) {
          firstTokenAt = Date.now();
          recordSpan(threadId, `${name}.ttft`, startedAt, firstTokenAt, "ok", { agent });
        }
        yield chunk;
      }
    } catch (err) {
      // 取消≠失败：提交即收工 / 分支超时 / 用户打断都会掐流，调用本身没有坏。
      // 记成 failed 会让成功的行程 fan-out 每轮三条 llm span 全红（见 isCancellation）。
      status = isCancellation(err, hooks?.signal) ? "cancelled" : "failed";
      throw err;
    } finally {
      const endedAt = Date.now();
      const detail = status === "cancelled" ? cancelReason(hooks?.signal) : undefined;
      // **一个 token 都没出来也要发 ttft**，否则"模型全程没开口"这种最糟的情况
      // 在轨迹里恰好是一片空白——而空白与"没走这条路"看起来一样。
      if (firstTokenAt === undefined) {
        recordSpan(threadId, `${name}.ttft`, startedAt, endedAt,
          // 开口之前就被取消，不是"模型没开口"——别把打断记成模型的锅。
          status === "cancelled" ? "cancelled" : "failed",
          { agent, detail: detail ?? "no_token" });
      }
      recordSpan(threadId, name, startedAt, endedAt, status, {
        agent,
        ...(detail ? { detail } : {}),
      });
    }
  };
}
