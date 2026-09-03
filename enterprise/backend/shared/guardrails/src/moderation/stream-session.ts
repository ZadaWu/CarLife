/**
 * 输出侧的**流式内容审核**会话（施工单 TD-07，FL-26 F-26-06）。
 *
 * # 与流式脱敏的分工：一个能边流边改，一个只能撤
 *
 * 脱敏（`stream-redact.ts`）可以边流边做——把号码换成掩码是**局部替换**，
 * 扣住尾巴就够了。审核不行：判"拦"的时候前面的 token 已经推到端上了，
 * 而 SSE 单向下行，收不回字节。所以只有一条路——**撤回**（`SessionUpdate::Retract`）。
 *
 * 撤回是有代价的：用户已经读到了那段内容。所以审核要**尽早**判，
 * 而不是等 turn_end——等到最后再撤，等于让人把整段读完再告诉他那不算数。
 *
 * # 尽早 = 按累计字数分片送，同一 sessionId
 *
 * 阿里云的 `sessionId` 让审核引擎把切片**在服务端拼起来判**（doc 表 1）。
 * 于是我们可以每积累 `sliceChars` 就送一片，得到的判定是**针对到目前为止全文**的，
 * 而不是孤立的一片——跨片的表述照样认得出来。
 *
 * 节奏是个取舍：送得越勤撤得越早，但调用次数越多（该接口收费，QPS 上限 50）。
 * 默认 120 字约合两三句话，是"读到第三句才被撤"这个体感的上限。
 *
 * # 输入侧不用这条
 *
 * 输入是一次性的完整文本，直接 `check()` 即可。本模块只服务输出侧。
 */

import type { ContentGuard, GuardVerdict } from "./content-guard";

/** 默认送审节奏：每累计这么多字符送一片。 */
export const DEFAULT_SLICE_CHARS = 120;

export interface ModerationSession {
  /**
   * 推入新生成的文本。累计够一片时才真正送审。
   *
   * 返回 `undefined` 表示这次没送审（还没攒够）——**不是"安全"**。
   * 把 undefined 当成通过是这个 API 最容易被误用的地方，所以它不返回布尔。
   */
  push(text: string): Promise<GuardVerdict | undefined>;
  /**
   * 收尾：**等齐所有在途送审**，再把剩下的送审并标记 done。
   *
   * 等在途是必需的：`push` 不阻塞流（阻塞就没有流式了），
   * 于是 `turn_end` 可能跑在某次裁决之前——那次裁决要是判"拦"，
   * 撤回就发在 turn_end 之后，**端上已经收口、直接丢掉**。
   * 表现是"审核判了拦但用户什么也没察觉"。
   *
   * 不调它，最后一段就没审过。
   */
  finish(): Promise<GuardVerdict | undefined>;
  /** 累计已送审的字符数。诊断用。 */
  submitted(): number;
}

export interface ModerationSessionOptions {
  sliceChars?: number;
  /**
   * 审核失败（网络/超时/配额）时的处理。
   *
   * 默认 `throw`——由上层按 output fail 模式决定（§8.2 默认 fail-closed）。
   * **不在这里默默放行**：那会让"审核挂了"和"审核通过"在调用方看来一模一样。
   */
  onError?: "throw" | "skip";
}

/**
 * 开一个输出侧审核会话。**一轮一个**——复用会把上一轮的文本拼进这一轮。
 *
 * `guard` 传 undefined 时整个会话是 no-op（审核层未接入），
 * 与 `runOutputPipeline` 的 `moderationSkipped` 同一语义：不假装审过。
 */
export function createModerationSession(
  guard: ContentGuard | undefined,
  sessionKey: string,
  opts: ModerationSessionOptions = {},
): ModerationSession {
  const sliceChars = Math.max(1, opts.sliceChars ?? DEFAULT_SLICE_CHARS);
  const onError = opts.onError ?? "throw";
  let pending = "";
  let sent = 0;
  /** 在途送审。`finish` 要等齐它们，否则裁决会晚于 turn_end 到达。 */
  const inflight = new Set<Promise<GuardVerdict | undefined>>();
  /**
   * 已发生的送审失败。
   *
   * **必须记住**：中途某一片送审抛错时，调用方多半已经 catch 掉了
   * （它不能让一次审核失败炸掉整条流），而 `inflight` 那时已经被清空。
   * 不记住的话，`finish()` 会一切正常地返回，于是"审核挂了"和"审核通过"
   * 在调用方看来完全一样——output fail-closed 就此失效，而且毫无症状。
   */
  const failures: unknown[] = [];

  const submit = async (text: string, done: boolean): Promise<GuardVerdict | undefined> => {
    if (!guard || text === "") return undefined;
    sent += text.length;
    try {
      // 整轮共用 sessionKey：判定针对"到目前为止的全文"，跨片表述不漏
      return await guard.check(text, "output", { sessionKey, done });
    } catch (err) {
      failures.push(err);
      if (onError === "skip") return undefined;
      throw err;
    }
  };

  return {
    async push(text) {
      pending += text;
      if (pending.length < sliceChars) return undefined;
      const slice = pending;
      pending = "";
      const p = submit(slice, false);
      inflight.add(p);
      try {
        return await p;
      } finally {
        inflight.delete(p);
      }
    },

    async finish() {
      // 先等齐在途——它们里可能有一个判了"拦"，那条必须赶在 turn_end 前处理
      await Promise.allSettled([...inflight]);

      const rest = pending;
      pending = "";
      let last: GuardVerdict | undefined;
      try {
        last = await submit(rest, true);
      } catch {
        /* 已记进 failures，下面统一抛 */
      }

      /*
       * 本轮**任何一片**送审失败过，就在这里如实抛出去。
       *
       * 不吞掉是关键：吞掉会让"审核挂了"看起来和"审核通过"一样，
       * 而 output fail-closed 的全部意义就是区分这两者。
       * 抛什么由上层按 fail 模式处置（撤回 / 放行），本模块不替它决定。
       */
      if (failures.length > 0 && onError === "throw") {
        throw failures[0];
      }
      return last;
    },

    submitted() {
      return sent;
    },
  };
}
