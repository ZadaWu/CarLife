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
import { classifyError, OUTPUT_MAX_CHARS, recordAgentOutput, recordSpan } from "../trace/span";
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
 * 失败原因（M94-01）。**前缀 `err:` 不是装饰**——取消原因里也有 `timeout`
 * （分支超时掐流），不加前缀的话"被掐"与"坏了"在回放里落成同一格，
 * 而这两件事的处置完全相反：前者是编排层的正常动作，后者要去查上游。
 *
 * 加这条之前，`failed` 的 detail 一律不填：库里 53 条 `llm.* failed` 全是空 detail，
 * 2026-09-16 那次 ACP 连接关闭因此在轨迹里没有名字，只能从别的 span 的 reason 绕着推。
 */
function failureReason(err: unknown): string {
  return `err:${classifyError(err)}`;
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
    /*
     * 产出文本顺手攒下来（2026-09-15，业务视图的"这个 Agent 答了什么"）。
     * 只攒到入库上限再多一点就停——一次应答几 KB，攒全没问题；
     * 上限是防某次流失控时把整段都留在内存里。长度仍按真实 chars 计。
     */
    let output = "";
    let outputChars = 0;
    /** catch 到的错误要在 finally 里归类，所以存进闭包（M94-01）。 */
    let failure: unknown;

    try {
      for await (const chunk of inner(messages, hooks)) {
        if (firstTokenAt === undefined && chunk.length > 0) {
          firstTokenAt = Date.now();
          recordSpan(threadId, `${name}.ttft`, startedAt, firstTokenAt, "ok", { agent });
        }
        outputChars += chunk.length;
        if (output.length <= OUTPUT_MAX_CHARS) output += chunk;
        yield chunk;
      }
    } catch (err) {
      // 取消≠失败：提交即收工 / 分支超时 / 用户打断都会掐流，调用本身没有坏。
      // 记成 failed 会让成功的行程 fan-out 每轮三条 llm span 全红（见 isCancellation）。
      status = isCancellation(err, hooks?.signal) ? "cancelled" : "failed";
      failure = err;
      throw err;
    } finally {
      const endedAt = Date.now();
      const detail =
        status === "cancelled" ? cancelReason(hooks?.signal)
        : status === "failed" ? failureReason(failure)
        : undefined;
      // **一个 token 都没出来也要发 ttft**，否则"模型全程没开口"这种最糟的情况
      // 在轨迹里恰好是一片空白——而空白与"没走这条路"看起来一样。
      if (firstTokenAt === undefined) {
        /*
         * "没开口"与"为什么没开口"是两件事（M94-01）。此前只剩前者：
         * 有错误时也只落 `no_token`，而那正是最该知道原因的一格。
         * 空流（status ok）仍是裸 `no_token`——它没有错误可归类。
         */
        const ttftDetail =
          failure !== undefined && status !== "cancelled"
            ? `no_token:${classifyError(failure)}`
            : (detail ?? "no_token");
        recordSpan(threadId, `${name}.ttft`, startedAt, endedAt,
          // 开口之前就被取消，不是"模型没开口"——别把打断记成模型的锅。
          status === "cancelled" ? "cancelled" : "failed",
          { agent, detail: ttftDetail });
      }
      recordSpan(threadId, name, startedAt, endedAt, status, {
        agent,
        ...(detail ? { detail } : {}),
      });
      // 产出与 span 并列落，成败取消都发：取消的那条带半截文本，业务视图据 status 说清楚。
      recordAgentOutput(threadId, agent, outputChars > output.length ? output + "…" : output, status);
    }
  };
}
