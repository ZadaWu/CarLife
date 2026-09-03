/**
 * 吞吐柱状图的几何与文案，与渲染分开——理由同 history.ts：**为了能被断言**。
 *
 * 它与余额曲线共用横轴（同一个 `TimeWindow`、同一个 `stepMs`），但语义上有一条
 * 根本差别，画法必须体现出来：
 *   余额历史里**缺的桶是缺口**（网关没在跑，我们不知道余额是多少）；
 *   吞吐里**缺的桶是零**（那十分钟没有一次调用）。
 * 所以余额曲线要断开，柱状图不断——没柱子就是没调用。把零画成缺口，看的人会去查
 * "那段时间埋点是不是挂了"；把缺口画成零，会把停机读成"没人用"。两边各守各的。
 *
 * 柱高是**每次请求的平均 token**（桶内 token 合计 ÷ 请求数），不是桶内合计：
 * 合计画出来的是"那十分钟有多忙"，一场评测跑一千次就把别的时段全压成平地；
 * 按请求平均画出来的才是"每次请求有多重"——上下文有没有越滚越长、哪段时间
 * 在跑超长输入，一眼能看出来。忙不忙由气泡里的次数回答。
 *
 * 另外两条会安静说假话的地方：
 *   ① **纵轴按窗口内峰值缩放**。一根顶到头的柱子可能是每次 5 千 token 也可能是 5 万，
 *      所以峰值必须显示在旁边（同余额曲线要显示极值的理由）。
 *   ② **估算与实测混在一根柱子里**。经 pi-acp 的调用按字符估 token，与直连那部分
 *      不是同一精度；数出来标在角标上，不标就是把估的当成量的。
 */

import type { AxisTick, TimeWindow } from "./history";

export interface ThroughputBucket {
  t: number;
  calls: number;
  failed: number;
  estimatedCalls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  okDurationMs: number;
  okCompletionTokens: number;
}

export interface ThroughputSeries {
  accountId: string;
  stepMs: number;
  from: number;
  to: number;
  buckets: ThroughputBucket[];
  totals: {
    calls: number;
    failed: number;
    estimatedCalls: number;
    promptTokens: number;
    completionTokens: number;
  };
  note: string;
  cached: boolean;
}

export function tokensOf(b: Pick<ThroughputBucket, "promptTokens" | "completionTokens">): number {
  return b.promptTokens + b.completionTokens;
}

/** 每次请求的平均 token——柱高与峰值都按它算。没有请求的桶给 0（调用方本来也不画它） */
export function avgTokensOf(b: Pick<ThroughputBucket, "promptTokens" | "completionTokens" | "calls">): number {
  return b.calls > 0 ? tokensOf(b) / b.calls : 0;
}

export interface ThroughputBar {
  /** 视口坐标，viewBox 为 `0 0 width height`；x 是柱子左沿，w 是柱宽 */
  x: number;
  w: number;
  /** 柱顶的 y（越小越高） */
  y: number;
  h: number;
  bucket: ThroughputBucket;
}

export interface ThroughputChart {
  bars: ThroughputBar[];
  /** 窗口内**每次请求平均 token** 最高的那个桶 */
  peak: ThroughputBucket;
  /**
   * 窗口内合计——**只算窗口内**，与服务端 totals（整个保留期）可能不同。
   * `avgTokens` 是窗口内所有请求的平均（合计 ÷ 次数），不是各桶平均值的平均：
   * 后者会让一个只跑了 1 次、恰好很重的桶与跑了 500 次的桶平起平坐。
   */
  total: { calls: number; failed: number; estimatedCalls: number; tokens: number; avgTokens: number };
  width: number;
  height: number;
}

export interface ThroughputOptions {
  from: number;
  to: number;
  stepMs: number;
  width?: number;
  height?: number;
  /** 顶部留白：最高那根柱子不该顶到边，否则与上一行文字粘在一起 */
  pad?: number;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 把桶摆成柱子。
 *
 * 柱高 = 桶内每次请求的平均 token（见文件头），纵轴按窗口内最高的那个桶缩放。
 *
 * 只画窗口内有调用的桶（服务端本来也只下发这些）。柱宽 = 一个 stepMs 在横轴上的
 * 宽度 × 0.85，留 15% 的缝让相邻的柱子分得开；7 天窗口下一根柱子只有 0.1 个单位宽，
 * 缝已经细到看不见，此时一片连成面积图也是对的——那正是"一直在跑"。
 *
 * 有调用但 0 token 的桶（直连失败、供应商没回用量）给一根最矮的柱子：不画的话
 * "那十分钟连着失败了几十次"在图上就是一片空白。
 *
 * 返回 `null` = 窗口内一个有调用的桶都没有，调用方该说"没有调用"而不是画空图。
 */
export function buildThroughput(buckets: ThroughputBucket[], opts: ThroughputOptions): ThroughputChart | null {
  const width = opts.width ?? 100;
  const height = opts.height ?? 32;
  const pad = opts.pad ?? 3;

  const inWindow = buckets
    .filter((b) => b.calls > 0 && b.t + opts.stepMs > opts.from && b.t <= opts.to)
    .sort((a, b) => a.t - b.t);
  if (inWindow.length === 0) return null;

  const span = opts.to - opts.from || 1;
  const inner = height - pad;
  const peakAvg = Math.max(...inWindow.map(avgTokensOf));
  const slotW = (opts.stepMs / span) * width;
  const barW = slotW * 0.85;
  const minH = 0.5;

  let peak = inWindow[0];
  const total = { calls: 0, failed: 0, estimatedCalls: 0, tokens: 0, avgTokens: 0 };
  const bars: ThroughputBar[] = inWindow.map((b) => {
    const avg = avgTokensOf(b);
    if (avg > avgTokensOf(peak)) peak = b;
    total.calls += b.calls;
    total.failed += b.failed;
    total.estimatedCalls += b.estimatedCalls;
    total.tokens += tokensOf(b);
    const h = peakAvg > 0 ? Math.max(minH, (avg / peakAvg) * inner) : minH;
    // 左沿夹到 0：窗口起点落在桶中间时，那根柱子露出来的部分才是窗口内的
    const x = Math.max(0, ((b.t - opts.from) / span) * width);
    return { x: round(x), w: round(Math.max(barW, 0.1)), y: round(height - h), h: round(h), bucket: b };
  });

  total.avgTokens = total.calls > 0 ? total.tokens / total.calls : 0;

  return { bars, peak, total, width, height };
}

/** 悬浮时离光标最近的柱子。落在某根柱子的格子里就是它，否则取最近的。 */
export function nearestBar(bars: ThroughputBar[], x: number): ThroughputBar | null {
  if (bars.length === 0) return null;
  let best = bars[0];
  let bestD = Number.POSITIVE_INFINITY;
  for (const b of bars) {
    const d = x < b.x ? b.x - x : x > b.x + b.w ? x - (b.x + b.w) : 0;
    if (d < bestD) {
      best = b;
      bestD = d;
      if (d === 0) break;
    }
  }
  return best;
}

/**
 * token 数的短写法：卡片角标一行只有 300px，`1568861` 这种七位数占太宽。
 * 小于一千原样给——`0.9k` 比 `912` 更难读。
 */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs < 1_000) return String(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * 生成速度（输出 token / 秒），只按成功调用算。
 * 分母是**整次调用的耗时**（含首字延迟与工具往返），所以它偏低于供应商标称的
 * 解码速度——标签里要写"含首字延迟"。没有成功调用时给 null，不给 0：
 * 0 tok/s 是"慢到没动"，null 是"这个桶算不出来"。
 */
export function tokPerSec(b: Pick<ThroughputBucket, "okDurationMs" | "okCompletionTokens">): number | null {
  if (b.okDurationMs <= 0) return null;
  return b.okCompletionTokens / (b.okDurationMs / 1000);
}

/** 桶宽的人话（"10 分钟"），给"tokens / 10 分钟"那种标签用 */
export function stepLabel(stepMs: number): string {
  const min = Math.round(stepMs / 60_000);
  if (min < 60) return `${min} 分钟`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} 小时` : `${min} 分钟`;
}

/** 估算那部分的完整口径。角标上只写"N 次估算"，来龙去脉放悬浮说明。 */
export const estimatedTitle =
  "经 pi-acp 的调用拿不到供应商回的用量，按字符数估算 token；与直连那部分不是同一精度。";

/**
 * 给屏幕阅读器的一句话。峰值必须念出来——纵轴按峰值缩放，不说的话
 * "一根顶到头的柱子"可能是每次 5 千也可能是 5 万 token。
 */
export function throughputAriaLabel(chart: ThroughputChart, stepMs: number, spanText: string): string {
  const parts = [
    `${spanText}调用吞吐`,
    `${chart.total.calls} 次调用`,
    `平均每次 ${fmtTokens(chart.total.avgTokens)} tokens`,
    `峰值桶（每 ${stepLabel(stepMs)}一桶）平均每次 ${fmtTokens(avgTokensOf(chart.peak))} tokens`,
  ];
  if (chart.total.failed > 0) parts.push(`其中 ${chart.total.failed} 次失败`);
  if (chart.total.estimatedCalls > 0) parts.push(`${chart.total.estimatedCalls} 次为估算值`);
  return parts.join("，");
}

/** 与余额曲线共用的刻度类型，仅为了让渲染层只从一个文件 import */
export type { AxisTick, TimeWindow };
