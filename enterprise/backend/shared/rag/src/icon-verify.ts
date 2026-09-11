/**
 * 候选 → 是不是这个符号：两道闸门 + 成对核验（施工单 M71-03，ACR-025）。
 *
 * 低幻觉系统里「不该匹配时没匹配」比「该匹配时匹配上了」更值钱，所以：
 *
 * 1. **分数闸门**：top-1 的最高相似度（图像路或文本路）≥ τ；
 * 2. **边际闸门**：top-1 与 top-2 的**相似度**之差 ≥ δ（两个候选不相上下时不选边）。
 *    边际不能量 RRF 融合分：两名之差只有 1/61 − 1/62 ≈ 0.0003，量不出任何东西（2026-09-08 第一版就是这么错的，
 *    tesla-01 四个符号全被拦）。
 *
 *    **相似度与边际都必须在同一条路上算**（2026-09-09 修）：第一版对每个候选先跨模态取 max 再相减，
 *    于是「分不开的那条路」会把「分得开的那条路」盖掉——手册图标图片入库后，驻车灯 vs 近光灯的
 *    图像相似度是 0.70 vs 0.57（分得很开），文本相似度却都是 0.96（描述子同形，分不开）；
 *    跨模态取 max 选中文本的 0.96，边际算出 0.00 被拦。表现是**融合路比只用图像路还差**（4/4 → 2/4），
 *    而融合的意义恰恰是不该比它的任何一条分路差。现在改为逐路算 sim 与 margin，任一路同时过 τ 与 δ 就算过，
 *    取边际更大的那一路作为证据。
 * 3. **成对核验**：把用户 crop 与手册图标图片并排给视觉模型，只答 same / different / unsure；
 *    `unsure` 与 `different` 都算未匹配。没有图标图片时**核验不了**，结果标 `verified: false`，
 *    下游只能说「疑似」，不能说「是」。
 *
 * τ、δ 的初值来自 2026-09-08 单张探针（同符号图-文 0.36–0.48、错配 0.09–0.15），
 * 在 ≥30 张 + 负样本上标定后改这里并同步 README。
 */

import type { IconClass, IconSeverity } from "./icon-catalog";
import type { Candidate } from "./icon-index";

export const DEFAULT_TAU = 0.3;
/** 相似度边际：top-1 与 top-2 的最高相似度之差。0.03 是单张上的初值（清晰可分的 0.14，同形的 0.00–0.01）。 */
export const DEFAULT_DELTA = 0.03;

export interface GateOptions {
  tau?: number;
  delta?: number;
}

export type GateResult =
  | { pass: true; top: Candidate; sim: number; margin: number }
  | { pass: false; reason: "no_candidates" | "below_tau" | "below_delta"; top?: Candidate; sim?: number; margin?: number };

type Modality = "image" | "text";
const simOf = (c: Candidate, m: Modality): number | null => (m === "image" ? c.imageSim : c.textSim);

/** 某一路上的 top-1 相似度与它到同一路 top-2 的边际；这一路上没有分数就返回 null。 */
function perModality(candidates: readonly Candidate[], m: Modality): { sim: number; margin: number } | null {
  const sim = simOf(candidates[0], m);
  if (sim === null) return null;
  const others = candidates.slice(1).map((c) => simOf(c, m)).filter((v): v is number => v !== null);
  return { sim, margin: others.length ? sim - Math.max(...others) : Number.POSITIVE_INFINITY };
}

export function gate(candidates: readonly Candidate[], opts: GateOptions = {}): GateResult {
  const tau = opts.tau ?? DEFAULT_TAU;
  const delta = opts.delta ?? DEFAULT_DELTA;
  if (candidates.length === 0) return { pass: false, reason: "no_candidates" };
  const top = candidates[0];
  const lanes = (["image", "text"] as const).map((m) => perModality(candidates, m)).filter((v): v is { sim: number; margin: number } => v !== null);
  if (lanes.length === 0) return { pass: false, reason: "below_tau", top };

  // 任一路同时过两道门就算过；有多条过时取边际更大的那条（分得更开的证据更可信）。
  const passed = lanes.filter((l) => l.sim >= tau && l.margin >= delta).sort((a, b) => b.margin - a.margin);
  if (passed.length > 0) return { pass: true, top, sim: passed[0].sim, margin: passed[0].margin };

  // 没过：报最有希望那条路的数字——够高但拉不开是 below_delta，连高都不够是 below_tau。
  const reachedTau = lanes.filter((l) => l.sim >= tau).sort((a, b) => b.margin - a.margin);
  const best = (reachedTau[0] ?? [...lanes].sort((a, b) => b.sim - a.sim)[0]);
  return { pass: false, reason: reachedTau.length > 0 ? "below_delta" : "below_tau", top, sim: best.sim, margin: best.margin };
}

export interface IconSemantics {
  symbolId: string;
  name: string;
  class: IconClass;
  severity: IconSeverity;
  manualAnchor: string | null;
  descriptorSource?: string;
}

export type MatchResult =
  | { matched: true; verified: boolean; semantics: IconSemantics; sim: number; margin: number; evidence: string }
  | { matched: false; reason: string; top?: IconSemantics; sim?: number };

export interface MatchDeps {
  /** 成对核验；没有就只能给 verified=false 的匹配 */
  verifyPair?: (userCrop: Buffer, catalogIcon: Buffer) => Promise<"same" | "different" | "unsure">;
  /** 取手册图标图片；没有图片返回 null */
  iconImage?: (symbolId: string) => Buffer | null;
}

const semanticsOf = (c: Candidate): IconSemantics => {
  const d = (c.row.descriptor ?? {}) as Partial<IconSemantics> & { name?: string };
  return {
    symbolId: c.symbolId,
    name: d.name ?? c.symbolId,
    class: (d.class ?? "status") as IconClass,
    severity: (d.severity ?? "info") as IconSeverity,
    manualAnchor: c.row.manualAnchor,
    descriptorSource: d.descriptorSource,
  };
};

/** 闸门 → 核验 → 语义。crop 为空时跳过核验（只有描述子的文本路），结果必然 verified=false。 */
export async function decideMatch(candidates: readonly Candidate[], crop: Buffer | null, deps: MatchDeps, opts: GateOptions = {}): Promise<MatchResult> {
  const g = gate(candidates, opts);
  if (!g.pass) {
    return { matched: false, reason: g.reason, top: g.top ? semanticsOf(g.top) : undefined, sim: g.sim };
  }
  const semantics = semanticsOf(g.top);
  const icon = crop && deps.iconImage ? deps.iconImage(g.top.symbolId) : null;
  if (crop && icon && deps.verifyPair) {
    const verdict = await deps.verifyPair(crop, icon);
    if (verdict !== "same") return { matched: false, reason: `verify_${verdict}`, top: semantics, sim: g.sim };
    return { matched: true, verified: true, semantics, sim: g.sim, margin: g.margin, evidence: `sim ${g.sim.toFixed(3)} · margin ${g.margin.toFixed(4)} · 成对核验 same` };
  }
  return {
    matched: true,
    verified: false,
    semantics,
    sim: g.sim,
    margin: g.margin,
    evidence: `sim ${g.sim.toFixed(3)} · margin ${g.margin.toFixed(4)} · 未核验（${icon ? "无核验器" : "手册无该图标图片"}）`,
  };
}
