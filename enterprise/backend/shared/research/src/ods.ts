/**
 * 机会分 ODS（施工单 M82-01）。
 *
 * ```
 * ODS = 100 × C × [0.25·I + 0.20·U + 0.15·F + 0.10·G + 0.15·E + 0.15·S] × (1 − R)
 * ```
 *
 * # 它只排序
 *
 * analysis.md §4 / 方法本体 §13：**评分只输出候选，不修改 roadmap**。
 * 分数不写回任何计划文件，也不触发任何个体触达——售后线索那条出口
 * 必须走人工逐条放行（总览已定决策 10）。
 *
 * # C 与 (1 − R) 为什么在括号外
 *
 * 放进加权和里，它们就变成"可以被别的项补偿的一项"：
 * 一个证据几乎为零、风险几乎为一的机会，只要影响面够大照样能排到前面。
 * 乘在外面表达的是**否决**语义：证据没有，分数就没有；风险拉满，分数归零。
 * 这与四道门是同一条纪律的两种实现（门在算之前，这两个乘子在算之中）。
 */

import type { OdsComponents, OdsResult } from "./types";

export interface OdsProfile {
  version: string;
  weights: { i: number; u: number; f: number; g: number; s: number; e: number };
}

/**
 * 默认权重档。**改权重必须改 version**——不改的话，昨天的 72 分与今天的 72 分
 * 不是同一个东西，而机会列表上看不出任何区别。
 */
export const DEFAULT_PROFILE: OdsProfile = {
  version: "ods-v1",
  weights: { i: 0.25, u: 0.2, f: 0.15, g: 0.1, e: 0.15, s: 0.15 },
};

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function odsOf(components: OdsComponents, profile: OdsProfile = DEFAULT_PROFILE): OdsResult {
  const c = {
    i: clamp01(components.i),
    u: clamp01(components.u),
    f: clamp01(components.f),
    g: clamp01(components.g),
    e: clamp01(components.e),
    s: clamp01(components.s),
    r: clamp01(components.r),
    c: clamp01(components.c),
  };

  const w = profile.weights;
  const weighted = w.i * c.i + w.u * c.u + w.f * c.f + w.g * c.g + w.e * c.e + w.s * c.s;
  const score = 100 * c.c * weighted * (1 - c.r);

  return { ...c, score, profileVersion: profile.version };
}

/**
 * 权重和必须是 1，否则满分不是 100 而是某个说不出所以然的数。
 * 给自定义 profile 用；`DEFAULT_PROFILE` 由单测钉住。
 */
export function isValidProfile(profile: OdsProfile): boolean {
  const w = profile.weights;
  const sum = w.i + w.u + w.f + w.g + w.e + w.s;
  return Math.abs(sum - 1) < 1e-9;
}
