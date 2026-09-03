/**
 * 并行 fan-out 与结构化汇聚（施工单 M5-01，FL-13）。
 *
 * # "真并行"的判据是时间轴重叠，不是代码里有 Promise.all
 *
 * 串行伪并行（等 A 完再发 B）在功能上看不出任何区别——回答一样、字段一样、
 * 用户体验只是慢一点。**唯一能抓住它的是"两条分支的 [startAt,endAt] 区间存在交集"**
 * 这条断言（AC-13-1）。因此每条分支都记录起止时间，且它是**结果的一部分**，
 * 不是可选的埋点——可选的东西迟早会被关掉。
 *
 * # 两种"并发"不能混
 *
 * 本模块管的是**跨 Agent 协作**：LangGraph 同时向多个 Agent 各发一次独立
 * `session/prompt`（§11 `par` 段）。出行规划 Agent 自己并行调天气/路线/充电是
 * **工具并发**，在 Agent 内部，不归这里（FL-13 判据表）。
 * 写错位置 `check:arch` 的 crosstalk 检查查不出来——它只能查"有没有直接互调"，
 * 查不出"该并行的地方写成了串行"。
 *
 * # 分支失败不导致整体失败
 *
 * 任一分支失败以**失败态汇聚**（F-13-04），下游据此降级并标注缺了什么。
 * 这是 §0 进程隔离收益在编排层的延续：Agent 崩溃不拖垮编排，分支失败不拖垮方案。
 */

import type { ChatStreamer, ChatStreamHooks, ChatTurnMessage } from "../llm";

/** 单条分支的定义。 */
export interface Branch {
  /** 分支标识，同时是 ACP 会话的 Agent 维度（§11：各 Agent 独立会话）。 */
  agent: string;
  /** 该分支要问的问题（已含结构化输出要求）。 */
  prompt: string;
}

/** 分支执行结果。`startedAt`/`endedAt` 是"真并行"的证据，不是可选埋点。 */
export interface BranchResult {
  agent: string;
  status: "ok" | "failed" | "timeout";
  text: string;
  startedAt: number;
  endedAt: number;
  error?: string;
  /**
   * 经提交通道到达的结论（M30-02）。有它时 `text` 是空串——分支流被提前掐掉了，
   * 消费方（merge）**先看这里**，回落才去解析 text。endedAt 在此情形下是提交落地时刻，
   * F-13-08 的耗时对比口径由此成立。
   */
  submission?: unknown;
}

export interface FanoutOptions {
  /** 单分支超时。超时的分支以 `timeout` 汇聚，**不拖垮其它分支**。 */
  timeoutMs?: number;
  /**
   * 并发上限（F-13-10）。超出的分支排队——避免拖垮 pi-acp 进程或触发下游限流。
   * 与网关的用户×工具限流是两层：那层管用户滥用，这层管单次请求的资源占用。
   */
  maxConcurrency?: number;
  threadId?: string;
  onUsage?: ChatStreamHooks["onUsage"];
  now?: () => number;
  /**
   * 分支起止回调（F-13-07）。
   *
   * 没有它时，两条分支跑上一分钟而端上一片空白——既看不到"在并行"，
   * 也不知道哪条已经出结果。等汇聚才下发，等于把最能体现多 Agent 协作的那一段藏起来。
   *
   * 只报**起止与耗时**，不报中间 token：分支的原始输出是给汇聚节点做结构化求解的，
   * 直接流给用户会变成两路互相打架的半成品（F-13-02：LLM 不参与约束求解）。
   */
  onBranchEvent?: (e: {
    agent: string;
    status: "started" | "ok" | "failed" | "timeout";
    durationMs?: number;
  }) => void;
  /**
   * 提交即收工（施工单 M30-02）：分支经 submit 工具交出结论时，这个 Promise 兑现。
   *
   * 兑现即分支完成——**不等模型那句"已提交"**（pi 循环要求工具调用后再产一条
   * 无工具消息才收场，那是一整轮 LLM 往返，实测 TTFT 2.7~3.2s；fanout 等最大值，
   * 四条都多这一轮就是每轮 +2~3s）。兑现后立刻 abort 分支流，触发既有的
   * cancel+sink.fail 双保险（TD-08）把收尾轮掐掉。
   *
   * 不传 = 行为与从前逐字相同。返回 undefined 表示该分支没有提交通道（同上）。
   * Promise 永不 reject（branch-submissions.waitSubmission 的契约）——
   * 它只与流/超时竞速，不承担兜底。
   */
  submissionOf?: (agent: string) => Promise<{ payload: unknown }> | undefined;
  /**
   * 本轮的取消信号（施工单 M33-01）。**上游取消要能穿过 fan-out 这一层**。
   *
   * 本函数每条分支已经有自己的 `AbortController`（超时与"提交即收工"用它），
   * 这里不是再建一个，而是把外层的取消**接到每条分支的 controller 上**：
   * 上游一 abort，四条分支同时收，触发既有的 cancel+sink.fail 双保险（TD-08）。
   *
   * 不接的话，用户打断之后 pi 那边四条流还会各自跑到 60 秒超时才收——
   * 那正是 TD-08 治过一次的"僵尸调用"，只是触发原因从超时换成了打断。
   */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * 并行驱动多个分支。
 *
 * **永不 reject**：所有失败都被收敛为 `BranchResult.status`。
 * 这是不变量 ①（任一分支失败不导致整体失败）在类型层面的保证——
 * 调用方拿不到"整体失败"这个结果，也就不可能写出让它整体失败的代码。
 */
export async function runFanout(
  streamer: ChatStreamer,
  branches: readonly Branch[],
  opts: FanoutOptions = {},
): Promise<BranchResult[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = Math.max(1, opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  const now = opts.now ?? Date.now;

  const results: BranchResult[] = new Array(branches.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= branches.length) return;
      results[index] = await runBranch(streamer, branches[index], { timeoutMs, now, opts });
    }
  };

  // 起 min(limit, n) 个 worker 并发消费——这就是"真并行"的来源。
  await Promise.all(Array.from({ length: Math.min(limit, branches.length) }, worker));
  return results;
}

async function runBranch(
  streamer: ChatStreamer,
  branch: Branch,
  ctx: { timeoutMs: number; now: () => number; opts: FanoutOptions },
): Promise<BranchResult> {
  const startedAt = ctx.now();
  const messages: ChatTurnMessage[] = [{ role: "user", content: branch.prompt }];

  // 起：端上据此知道"现在有几条腿在并行跑"。**在真正发起之前报**——
  // 报晚了就退化成"事后告诉你刚才并行过"，那正是此前一片空白的原因。
  ctx.opts.onBranchEvent?.({ agent: branch.agent, status: "started" });

  const finish = (r: BranchResult): BranchResult => {
    ctx.opts.onBranchEvent?.({
      agent: r.agent,
      status: r.status,
      durationMs: r.endedAt - r.startedAt,
    });
    return r;
  };

  /*
   * 超时**同时取消底层调用**（施工单 TD-08，FL-14 F-14-04）。
   *
   * 此前只有 `Promise.race`：超时赢了，编排层不再等，但被丢下的那一半没人去停——
   * `collect()` 的循环还在拉，ACP 的 `session/prompt` 从没被取消。
   * 实测的后果是一个 **60 秒的僵尸调用**：分支在 60s 判 timeout，
   * 底层一路跑到 pi 侧的 120s 超时才收，这 60 秒里 token 照烧、结果没有任何人会用。
   *
   * 光 `break` 退循环解决不了：**流静默时根本拿不到下一个 chunk**，
   * 永远走不到那个 break——而实测那次恰恰是静默的。所以要主动的取消信号。
   */
  const abort = new AbortController();
  /*
   * 外层取消 → 本分支取消（M33-01）。用 `once` 并在 finally 里摘掉：
   * fan-out 一轮会建 N 个 controller，不摘的话监听器挂在同一个上游 signal 上越积越多。
   */
  /*
   * abort 一律带 reason（字符串），`withLlmSpans` 把它落进 span 的 detail——
   * 三种掐流（提交收工 / 超时 / 上游打断）在轨迹上因此分得开。
   * 不带的话 span 只能记一个笼统的 cancelled，"为什么被掐"查不出来。
   */
  const outerReason = (): string =>
    typeof ctx.opts.signal?.reason === "string" ? ctx.opts.signal.reason : "cancelled";
  const onOuterAbort = () => abort.abort(outerReason());
  if (ctx.opts.signal) {
    if (ctx.opts.signal.aborted) abort.abort(outerReason());
    else ctx.opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    const collected = collect(
      streamer(messages, {
        threadId: ctx.opts.threadId,
        agent: branch.agent,
        onUsage: ctx.opts.onUsage,
        signal: abort.signal,
      }),
    );
    /*
     * 提交即收工（M30-02）：提交、流、超时三路竞速。
     *
     * 提交赢了就立刻 abort——触发 connection.ts 的 cancel+sink.fail 双保险（TD-08），
     * pi 那句"已提交"的收尾轮被掐掉，不占用户一秒。被掐的 `collected` 稍后会以
     * CancelledError 收场：race 已经 settle，那次 reject 由 race 自己消化，
     * **绝不能**流进下面的 catch 记成 failed——功能全对、大屏失败率 100% 就是那么来的。
     *
     * 没有提交通道（submissionOf 未传/返回 undefined）时，这段就是原来的两路竞速，逐字等价。
     */
    const submitted = ctx.opts.submissionOf?.(branch.agent);
    const outcome = await withTimeout(
      submitted
        ? Promise.race([
            collected.then((text) => ({ kind: "text" as const, text })),
            submitted.then((s) => ({ kind: "submission" as const, payload: s.payload })),
          ])
        : collected.then((text) => ({ kind: "text" as const, text })),
      ctx.timeoutMs,
      () => abort.abort("timeout"),
    );
    if (outcome.kind === "submission") {
      abort.abort("submitted");
      return finish({
        agent: branch.agent,
        status: "ok",
        text: "",
        submission: outcome.payload,
        startedAt,
        endedAt: ctx.now(),
      });
    }
    return finish({ agent: branch.agent, status: "ok", text: outcome.text, startedAt, endedAt: ctx.now() });
  } catch (err) {
    const isTimeout = err instanceof BranchTimeout;
    return finish({
      agent: branch.agent,
      status: isTimeout ? "timeout" : "failed",
      text: "",
      startedAt,
      endedAt: ctx.now(),
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // 监听器摘干净（M33-01）：一轮 fan-out 建 N 个 controller，
    // 不摘就会在同一个上游 signal 上越挂越多。
    ctx.opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

class BranchTimeout extends Error {}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

/**
 * 超时竞速，**并在超时时执行 `onTimeout`**。
 *
 * `Promise.race` 只决定"谁先返回"，它**不会停下输的那一方**——
 * 那正是僵尸调用的来源（见 `runBranch` 里的说明）。
 * `onTimeout` 就是补上"去把它停掉"这一步；它自己抛错不该盖掉超时错误。
 */
async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* 取消失败不改变超时这个事实 */
      }
      rej(new BranchTimeout(`分支超时 ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** 两条分支的时间区间是否重叠——"真并行"的可断言判据（AC-13-1）。 */
export function overlaps(a: BranchResult, b: BranchResult): boolean {
  return a.startedAt < b.endedAt && b.startedAt < a.endedAt;
}

/** 结果集中是否存在任意一对重叠区间。 */
export function hasParallelOverlap(results: readonly BranchResult[]): boolean {
  for (let i = 0; i < results.length; i += 1) {
    for (let j = i + 1; j < results.length; j += 1) {
      if (overlaps(results[i], results[j])) return true;
    }
  }
  return false;
}
