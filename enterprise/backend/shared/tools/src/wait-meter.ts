/**
 * 「这一跳里有多少时间是在**排我们自己的队**」——限速闸的等待计量（M77 走查追修）。
 *
 * # 它回答的是轨迹图上答不了的那个问题
 *
 * 真跑 turn-d3372ed7：fan-out 起跑的 1.3 秒内九个高德请求一起发出，
 * 而闸门是 350ms/桶 2（`amap.ts` 的 `createAmapRateGate`），于是
 * `tool.spot_search` 一条写着 4770ms。那 4.77 秒里**有多少是高德在算、
 * 多少是它在我们的队里干等**，轨迹上看不出来——而两者的处置完全相反：
 * 前者只能等上游，后者是我们自己的并发策略，调得动。
 *
 * # 为什么是 AsyncLocalStorage，而不是把 ctx 一路传下去
 *
 * 等待发生在 `amap.ts` 的 `get()` 里，离 `invokeTool` 隔着
 * `defineExternalTool` → 各工具的 `real()` → 后端接口（`PoiSearchBackend` 之流）
 * → `AmapClient` 四层，而**这些接口都只收 signal，没有 ctx**
 * （`PoiSearchBackend.textSearch(params, signal)`）。为了一个计量数字
 * 给四层接口各加一个参数，等于把观测的成本摊到每一个实现上，
 * 以后谁新写一个后端都得记得传——漏传不报错，只是数字悄悄变小。
 *
 * 异步上下文天然按"一次调用链"隔离：并发的四条分支各有各的账，互不串。
 *
 * # 合并区间，不是累加
 *
 * 一次工具调用可能并发打好几个高德请求（`map_route` 的两端地理编码就是），
 * 它们的等待**在时间上重叠**。累加会得出比这一跳总时长还大的等待，
 * 画出来就是一条超出边界的条。所以记区间、取并集。
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface WaitLedger {
  /** 每次等待的 [起, 止]，最后取并集（见文件头）。 */
  spans: Array<{ s: number; e: number }>;
}

const store = new AsyncLocalStorage<WaitLedger>();

/**
 * 开一本新账；`run()` 里发生的排队都记进去，`waitMs()` 随时可读。
 *
 * 分成两个动作而不是 `withWaitMeter(fn)` 一把梭，是因为**失败也要拿到数**：
 * 一次被限流退避到超时的调用，恰恰是最该看清"等了多久"的那一条，
 * 而它是从 catch 里出去的。
 *
 * 不必支持嵌套：`invokeTool` 是工具的唯一执行入口，一次调用一本账。
 * 真嵌套了（工具里再调工具）内层自己开一本，外层因此**不含**内层的等待——
 * 这是对的，那笔时间该记在内层那一跳上。
 */
export function openWaitMeter(): { waitMs: () => number; run: <T>(fn: () => Promise<T>) => Promise<T> } {
  const ledger: WaitLedger = { spans: [] };
  return {
    waitMs: () => unionMs(ledger.spans),
    run: (fn) => store.run(ledger, fn),
  };
}

/**
 * 记一段排队。**闸门自己调它**，调用点不必知道有这回事。
 *
 * 不在任何一本账里（没经 `invokeTool` 的直调、单测）时静默丢弃——
 * 计量不该让被计量的代码多一条分支。
 */
export function recordWait(startedAt: number, endedAt: number): void {
  if (!(endedAt > startedAt)) return;
  store.getStore()?.spans.push({ s: startedAt, e: endedAt });
}

function unionMs(spans: Array<{ s: number; e: number }>): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a.s - b.s);
  let total = 0;
  let cur = { ...sorted[0]! };
  for (const sp of sorted.slice(1)) {
    if (sp.s > cur.e) {
      total += cur.e - cur.s;
      cur = { ...sp };
      continue;
    }
    cur.e = Math.max(cur.e, sp.e);
  }
  return Math.round(total + (cur.e - cur.s));
}
