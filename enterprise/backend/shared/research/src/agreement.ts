/**
 * 编码一致率（施工单 M82-01）。
 *
 * # 为什么两个指标都要
 *
 * **percent agreement** 好读但会骗人：一条轴上 95% 的单元都该打同一个码时，
 * 两个乱猜的编码者也能拿到 0.9——它没有扣掉"碰巧一致"。
 * **Krippendorff α** 扣掉了，代价是不直观（0.743 是什么感觉？）。
 * 所以界面上给 percent，门（`measurement`）看的也是 percent（阈值 0.7，
 * Sprint 完成判定 4），但报告里两个都出——α 掉下去而 percent 没掉，
 * 说明这条轴已经退化成"永远打同一个码"。
 *
 * # 不引依赖
 *
 * α 的公式（Krippendorff 2011，名义尺度）不长，引一个包换来的是一个
 * 没人读过的实现和一条供应链。用教科书样例（Hayes & Krippendorff 2007 表 1，
 * α = 0.743）在单测里钉住，比信一个 star 数更牢靠。
 */

/** 码值。缺测用 `null`——不是空串（空串是一个合法的码）。 */
export type Code = string | null;

/**
 * 两个编码者在同一批单元上的简单一致率。
 * 只统计两边都有值的单元；两边都缺的单元不算"一致"。
 */
export function percentAgreement(a: readonly Code[], b: readonly Code[]): number {
  if (a.length !== b.length) {
    throw new Error("research_agreement_length_mismatch: 两个编码序列长度必须相同");
  }
  let comparable = 0;
  let same = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === null || b[i] === null) continue;
    comparable += 1;
    if (a[i] === b[i]) same += 1;
  }
  // 没有可比单元时返回 0 而不是 1：“没测过”不该长得像“完全一致”。
  return comparable === 0 ? 0 : same / comparable;
}

/**
 * 信度数据矩阵：**外层是编码者，内层按单元索引**，与教科书表格的排版一致
 * （一行一个 observer），这样样例数据能逐字粘进单测。
 */
export type ReliabilityMatrix = readonly (readonly Code[])[];

/**
 * Krippendorff α（名义尺度，任意编码者数、允许缺测）。
 *
 * 算法（Krippendorff 2011）：
 *  1. 只保留**至少两个编码者给了值**的单元——单人打的码无从判断一致性。
 *  2. 重合矩阵 `o[c][k] = Σ_u (单元 u 内 (c,k) 有序对数) / (m_u − 1)`，
 *     除以 `m_u − 1` 是为了让每个单元的权重与编码者数无关。
 *  3. `n_c = Σ_k o[c][k]`，`n = Σ_c n_c`。
 *  4. 名义尺度下 `D_o = Σ_{c≠k} o[c][k]`，
 *     `D_e = Σ_c n_c(n − n_c) / (n − 1)`。
 *  5. `α = 1 − D_o / D_e`。
 *
 * 返回 1 的两种边界：全部单元只有一个码值（无分歧可言）、或没有可用单元。
 * 后者调用方应当先看 `pairableUnits`——`α = 1` 与"没测"必须能分开。
 */
export function krippendorffAlphaNominal(matrix: ReliabilityMatrix): number {
  return krippendorffAlphaDetail(matrix).alpha;
}

export interface AlphaDetail {
  alpha: number;
  /** 参与计算的单元数（至少两人给了值的那些）。 */
  pairableUnits: number;
  /** 可配对值总数 n。 */
  pairableValues: number;
  observedDisagreement: number;
  expectedDisagreement: number;
}

export function krippendorffAlphaDetail(matrix: ReliabilityMatrix): AlphaDetail {
  const observers = matrix.length;
  if (observers === 0) {
    return { alpha: 1, pairableUnits: 0, pairableValues: 0, observedDisagreement: 0, expectedDisagreement: 0 };
  }
  const units = matrix[0].length;
  for (const row of matrix) {
    if (row.length !== units) {
      throw new Error("research_agreement_ragged_matrix: 每个编码者的单元数必须相同（缺测用 null）");
    }
  }

  // o[c][k] 用 Map 而不是二维数组：码值是字符串，且事先不知道有多少种。
  const o = new Map<string, Map<string, number>>();
  const bump = (c: string, k: string, w: number): void => {
    let row = o.get(c);
    if (!row) {
      row = new Map();
      o.set(c, row);
    }
    row.set(k, (row.get(k) ?? 0) + w);
  };

  let pairableUnits = 0;

  for (let u = 0; u < units; u += 1) {
    const values: string[] = [];
    for (let r = 0; r < observers; r += 1) {
      const v = matrix[r][u];
      if (v !== null) values.push(v);
    }
    const m = values.length;
    if (m < 2) continue; // 单人打的码不参与——这正是 α 允许缺测的地方
    pairableUnits += 1;
    // 单元内所有**有序**对，权重 1/(m−1)。有序对让 o 对称，后面按 c≠k 求和才对得上。
    for (let i = 0; i < m; i += 1) {
      for (let j = 0; j < m; j += 1) {
        if (i === j) continue;
        bump(values[i], values[j], 1 / (m - 1));
      }
    }
  }

  if (pairableUnits === 0) {
    return { alpha: 1, pairableUnits: 0, pairableValues: 0, observedDisagreement: 0, expectedDisagreement: 0 };
  }

  const codes = [...o.keys()];
  const nOf = new Map<string, number>();
  let n = 0;
  for (const c of codes) {
    const row = o.get(c) ?? new Map<string, number>();
    let sum = 0;
    for (const v of row.values()) sum += v;
    nOf.set(c, sum);
    n += sum;
  }

  let observedDisagreement = 0;
  for (const c of codes) {
    const row = o.get(c) ?? new Map<string, number>();
    for (const [k, v] of row) if (c !== k) observedDisagreement += v;
  }

  // D_e = Σ_c n_c (n − n_c) / (n − 1)
  let expectedDisagreement = 0;
  for (const c of codes) {
    const nc = nOf.get(c) ?? 0;
    expectedDisagreement += nc * (n - nc);
  }
  expectedDisagreement = n > 1 ? expectedDisagreement / (n - 1) : 0;

  // 全体一致于单一码值时 D_e = 0：没有分歧的可能，α 定义为 1。
  const alpha = expectedDisagreement === 0 ? 1 : 1 - observedDisagreement / expectedDisagreement;

  return { alpha, pairableUnits, pairableValues: n, observedDisagreement, expectedDisagreement };
}
