/**
 * 置信 C（施工单 M82-01，analysis.md §5）。
 *
 * `C = Coverage × Quality × Agreement × Triangulation × Freshness`，
 * 但实现取**几何平均**（五次方根）而不是直接连乘：连乘让五项都 0.8 的主题得 0.33，
 * 那个数在界面上读起来像"基本不可信"，而它其实是"五项都还行"。
 * 几何平均保留了"任一项趋零则整体趋零"这条要的语义，量纲又与各项一致。
 *
 * # 卡上真正有用的不是 c，是 lowest 与 suggestion
 *
 * "要到 Candidate 还缺什么"比"当前置信 0.62"有用得多。所以本函数的主要产出是
 * **哪一项最低** 与 **哪种新证据最能降低不确定性**——后者是固定映射不是模型生成：
 * 让模型来编这一句，它会写出"建议收集更多数据"。
 */

import type { ConfidenceBreakdown, ConfidenceInput } from "./types";

const FACTORS: readonly (keyof ConfidenceInput)[] = [
  "coverage",
  "quality",
  "agreement",
  "triangulation",
  "freshness",
];

/** 每一项最低时该去补什么。措辞直接上卡片，写成可执行的动作而不是形容词。 */
const SUGGESTIONS: Record<keyof ConfidenceInput, string> = {
  coverage: "覆盖不足：先扩观察窗或放宽场景筛选，让这个主题被更多台车、更多轮次覆盖",
  quality: "证据质量低：本主题多为被打断 / 空 ASR 的轮次，去调取原声核验几条再判断",
  triangulation: "只有一类证据：话语与行为缺一，去对上 trips / repair_records 的对应记录",
  agreement: "编码分歧大：拉一批到 gold set 人工复编码，必要时给这条轴补 include / exclude",
  freshness: "证据陈旧：最近的窗里几乎没有新证据，先确认这个主题是不是已经过去了",
};

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function confidenceOf(input: ConfidenceInput): ConfidenceBreakdown {
  const vals = {
    coverage: clamp01(input.coverage),
    quality: clamp01(input.quality),
    agreement: clamp01(input.agreement),
    triangulation: clamp01(input.triangulation),
    freshness: clamp01(input.freshness),
  };

  const product = FACTORS.reduce((acc, k) => acc * vals[k], 1);
  const c = Math.pow(product, 1 / FACTORS.length);

  // 平手时取 FACTORS 的顺序——稳定的输出比"随便选一个"重要，
  // 否则同一份数据两次生成的快照会不一致（Sprint 完成判定 5 要求逐字节相同）。
  let lowest: keyof ConfidenceInput = FACTORS[0];
  for (const k of FACTORS) if (vals[k] < vals[lowest]) lowest = k;

  return { ...vals, c, lowest, suggestion: SUGGESTIONS[lowest] };
}
