/**
 * 机会候选：ODS 分量与出口判定（施工单 M82-06）。
 *
 * # 分数只排序
 *
 * `ods.score` 只用于排序与显示敏感性。**仓库里没有任何计划文件被它写**
 * （analysis.md §4 / 方法本体 §13）。本模块因此不 import 任何写入路径——
 * `test/opportunity.test.ts` 有一条源码扫描钉住它。
 *
 * # 售后出口是唯一有个体后果的一条
 *
 * `outlet = 'aftersales'` 的机会会走到"对某台车发一条提醒"。那属于方法本体 §14 的
 * **高风险个体影响**，所以它在这里只是被**判定**出来，动作必须经 admin 逐条放行
 * （`review/aftersales-approve`）。判定本身不触发任何触达。
 */

import { DEFAULT_PROFILE, odsOf, type OdsComponents, type OdsResult, type OpportunityOutlet } from "@carlife/research";

/** 会走到售后出口的需求码（工单口径）。 */
export const AFTERSALES_CODES = new Set(["dtc-unclear", "service-interval", "booking-friction"]);

export interface OpportunitySignals {
  needPainCode: string;
  /** 提及率，0–1。 */
  mentionRate: number;
  /** 未解决率，0–1（表现度的补）。 */
  unresolvedRate: number;
  /** 在窗内出现的频率（命中轮次 / 窗口周数，归一到 0–1）。 */
  frequency: number;
  /** 方向：变差算差距大。 */
  direction: "up" | "down" | "flat";
  /** 落在硬禁范畴。 */
  undeliverable: boolean;
  /** 置信 C。 */
  confidence: number;
  /** 该主题的成员在行为侧有没有保养 / 故障记录——售后判定要它。 */
  hasServiceRecord: boolean;
}

/**
 * 出口判定。
 *
 * 硬禁的机会**没有出口**：它在图上有位置、标"不可交付"，但不该被派活
 * ——归到任何一个出口都会让 roadmap 反复捡起一件做不了的事。
 */
export function outletOf(s: OpportunitySignals): OpportunityOutlet | null {
  if (s.undeliverable) return null;
  if (AFTERSALES_CODES.has(s.needPainCode) && s.hasServiceRecord) return "aftersales";
  switch (s.needPainCode) {
    case "feature-discovery":
      return "kb";
    case "nav-detour":
    case "charger-availability":
      return "tool";
    case "shared-ownership":
      return "prompt";
    default:
      return "prompt";
  }
}

/** 信号 → ODS 八分量。E / S 常量 0.5：它们要人来定，编一个数比留空更糟。 */
export function componentsOf(s: OpportunitySignals): OdsComponents {
  return {
    i: Math.min(1, s.mentionRate * 2),
    u: s.unresolvedRate,
    f: Math.min(1, s.frequency),
    // 变差 = 差距在扩大；持平取中；变好说明现状在自愈。
    g: s.direction === "up" ? 0.8 : s.direction === "flat" ? 0.5 : 0.2,
    e: 0.5,
    s: 0.5,
    // 硬禁风险拉满 → 分数归零。这不是扣分，是否决。
    r: s.undeliverable ? 1 : 0,
    c: s.confidence,
  };
}

export interface ScoredOpportunity {
  outlet: OpportunityOutlet | null;
  ods: OdsResult;
}

export function scoreOpportunity(s: OpportunitySignals): ScoredOpportunity {
  return { outlet: outletOf(s), ods: odsOf(componentsOf(s), DEFAULT_PROFILE) };
}
