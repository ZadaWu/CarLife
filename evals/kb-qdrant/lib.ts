/**
 * `eval:kb-qdrant` 的纯判定函数（施工单 M81-02）。
 *
 * 抽出来是为了能离线单测：报告里那几个数字（hit@3、分位、两档一致性）一旦算错，
 * 结论会朝着错误的方向自信地下——而评测脚本本身不产生断言，没人会发现。
 */

export interface Hit {
  page: number;
  sim: number;
  figureId: string;
}

/** 最近秩分位，与 `evals/lib/report.ts` 的 `latencyPercentiles` 同口径（样本小，不做插值）。入参须已排序。 */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** top-1 命中：首条的页在真值集合里。 */
export const isHit1 = (top: readonly Hit[], expected: readonly number[]): boolean =>
  top.length > 0 && expected.includes(top[0].page);

/** top-3 命中：前三条里有任一页在真值集合里（调用方已截到 3 条）。 */
export const isHit3 = (top: readonly Hit[], expected: readonly number[]): boolean =>
  top.some((t) => expected.includes(t.page));

/**
 * 两档结果算不算不一致。
 *
 * **相似度不同即为缺陷**：同一批向量、同一个查询向量，余弦算出来必须一样，不一样通常是口径没对齐
 * （Qdrant 的 Cosine 给相似度、pgvector 的 `<=>` 给距离）。容差 1e-4 是给浮点序列化留的，不是给"引擎差异"留的。
 */
export function differs(a: readonly Hit[], b: readonly Hit[], tol = 1e-4): boolean {
  if (a.length !== b.length) return true;
  return a.some((x, i) => x.page !== b[i].page || Math.abs(x.sim - b[i].sim) > tol);
}
