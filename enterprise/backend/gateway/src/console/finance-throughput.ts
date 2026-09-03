/**
 * 账户的调用吞吐 —— 财务卡片底部那条"每个时刻跑了多少 token"的柱状图的数据源。
 *
 * # 它是余额曲线的另一半
 *
 * 余额曲线回答"钱怎么走到这儿的"，但一道陡坡说明不了是谁在花：是一场评测跑了
 * 一千次，还是一次超长上下文？把同一时间轴上的调用量摆在余额下面，两张图对着看
 * 才能回答。所以这里的桶宽与窗口**必须**与 `finance-history.ts` 同一口径
 * （`intervalMs()` / `RETENTION_MS` / 从 epoch 起算的桶边界）——各用各的横轴，
 * 两张图上同一个横坐标就不是同一个时刻。
 *
 * # 数据来自我们自己记的账，不是供应商
 *
 * 这一页别处的数字都是对方接口给的，这一条是例外：`llm_usage` 表是 agent-runtime
 * 自己的埋点。两点后果要在页面上说出来：
 *   1. **有一部分是估算**。经 pi-acp 的调用拿不到供应商回的用量，按字符数估
 *      （见 `acp-client/connection.ts`），与直连那部分不是同一精度。所以响应里
 *      按 provider 分开数了 `estimatedCalls`，页面要标出来。
 *   2. **埋点异步写、失败不阻塞**（AC-44-12），少记一条不会报错。所以这张图
 *      只能说"至少跑了这么多"，不能拿它去对供应商的账单。
 *
 * # 判定"哪些行算这家账户的"
 *
 * 按 `provider` **或** `model` 前缀，取并集：DeepSeek 直连行 `provider=deepseek`，
 * 经 pi-acp 的行 `provider=pi-acp` 但 `model=deepseek-v4-flash`。只看 provider
 * 会漏掉后者——而后者在多 Agent 图里占了调用量的近三分之一。
 */

import type { UsageThroughputRow } from "@carlife/db";

import { MINUTE_MS } from "./finance-history";

export interface ThroughputAccountSpec {
  /** `provider` 精确匹配的集合 */
  providers: string[];
  /** `model` 前缀匹配；与 providers 取并集 */
  modelPrefix?: string;
  /** 这些 provider 记的 token 是估算值，页面要单独标出来 */
  estimatedProviders: string[];
  note: string;
}

/**
 * 哪些账户有吞吐可看。只有 LLM 账户才有这一栏：高德按次、RAGFlow 订阅制、
 * 阿里云护栏与火山 ASR/TTS 的埋点走的是别的表或压根没有，不在这里硬凑。
 */
export const THROUGHPUT_ACCOUNTS: Record<string, ThroughputAccountSpec> = {
  deepseek: {
    providers: ["deepseek"],
    modelPrefix: "deepseek",
    estimatedProviders: ["pi-acp"],
    note:
      "来自我们自己的 llm_usage 埋点（直连按供应商回的用量记，经 pi-acp 的按字符估算）；埋点异步写、失败不补，只能说「至少跑了这么多」，别拿它对账单",
  },
};

export function throughputSupported(accountId: string): boolean {
  return Object.prototype.hasOwnProperty.call(THROUGHPUT_ACCOUNTS, accountId);
}

export interface ThroughputApiBucket {
  /** 桶起点（epoch ms），与余额历史的 `t` 同一口径 */
  t: number;
  calls: number;
  failed: number;
  /** 其中按字符估算的调用数（经 pi-acp） */
  estimatedCalls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  /** 成功调用的耗时与输出 token 之和——算生成速度用 */
  okDurationMs: number;
  okCompletionTokens: number;
}

export interface ThroughputTotals {
  calls: number;
  failed: number;
  estimatedCalls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ThroughputApiResponse {
  accountId: string;
  /** 桶宽。与余额历史同一个旋钮，页面上"tokens / N 分钟"从它推 */
  stepMs: number;
  from: number;
  to: number;
  /** 只含有调用的桶，按 t 升序；缺的桶就是 0——这是真零（没有调用），不是缺口 */
  buckets: ThroughputApiBucket[];
  totals: ThroughputTotals;
  note: string;
  cached: boolean;
}

/**
 * 把仓储给的 桶 × provider 行折成每桶一行，顺手把估算那部分数出来。
 * 输入不要求有序，输出按 t 升序——页面按顺序找"最早的桶"定横轴窗口。
 */
export function foldThroughput(rows: UsageThroughputRow[], spec: ThroughputAccountSpec): ThroughputApiBucket[] {
  const estimated = new Set(spec.estimatedProviders);
  const byT = new Map<number, ThroughputApiBucket>();
  for (const r of rows) {
    const b =
      byT.get(r.t) ??
      {
        t: r.t,
        calls: 0,
        failed: 0,
        estimatedCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        okDurationMs: 0,
        okCompletionTokens: 0,
      };
    b.calls += r.calls;
    b.failed += r.failed;
    if (estimated.has(r.provider)) b.estimatedCalls += r.calls;
    b.promptTokens += r.promptTokens;
    b.completionTokens += r.completionTokens;
    b.cacheHitTokens += r.cacheHitTokens;
    b.okDurationMs += r.okDurationMs;
    b.okCompletionTokens += r.okCompletionTokens;
    byT.set(r.t, b);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

export function totalsOf(buckets: ThroughputApiBucket[]): ThroughputTotals {
  const t: ThroughputTotals = { calls: 0, failed: 0, estimatedCalls: 0, promptTokens: 0, completionTokens: 0 };
  for (const b of buckets) {
    t.calls += b.calls;
    t.failed += b.failed;
    t.estimatedCalls += b.estimatedCalls;
    t.promptTokens += b.promptTokens;
    t.completionTokens += b.completionTokens;
  }
  return t;
}

export function toThroughputApi(
  accountId: string,
  spec: ThroughputAccountSpec,
  rows: UsageThroughputRow[],
  win: { stepMs: number; from: number; to: number },
): ThroughputApiResponse {
  const buckets = foldThroughput(rows, spec);
  return {
    accountId,
    stepMs: win.stepMs,
    from: win.from,
    to: win.to,
    buckets,
    totals: totalsOf(buckets),
    note: `每 ${win.stepMs / MINUTE_MS} 分钟一个桶，没有调用的桶不下发（是零，不是缺口）。${spec.note}`,
    cached: false,
  };
}
