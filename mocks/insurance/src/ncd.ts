/**
 * 保费浮动预测（施工单 M96-02，ACR-041 第 1 步）。
 *
 * # 这是模拟口径，不是任何一家险企的费率表
 *
 * 车主问"这个划痕走保险划算吗"，问的是算术：赔付净额 vs 次年保费涨多少。
 * 赔付侧 /claims/precheck 已经能算，涨价侧此前没有——本文件补这一半。
 * 规则写成常量表，响应用 `ruleNote` 逐字自述用了哪一档（照 index.ts 的 RULE_NOTE 纪律）：
 * 被追问"这个数怎么算的"时，答案就在响应里，不在代码里。
 *
 * 三条在线核实到的硬事实进了规则与话术（设计定稿附录）：
 *   - 交强险与商业险**分开浮动**，所以有两张表、两个因子；
 *   - 全国车险信息共享——换保险公司不影响上一年的出险记录（写进 ruleNote，不进算式）；
 *   - 出险次数过多会触发拒保（`renewalRisk` 只给提示，不下结论）。
 *
 * 规则确定：同输入永远同输出，无随机、无日期依赖。
 */

import type { Policy } from "./index";

/**
 * 商业险 NCD（无赔款优待）因子：按**本保单年度已出险次数 + 这一次**分档。
 * 索引 = 出险次数（含本次），超出表长取最后一档。数值是模拟口径。
 */
export const COMMERCIAL_NCD_FACTORS: readonly number[] = [
  0.85, // 0 次：连续无赔款，下浮
  1.0, //  1 次：不浮动
  1.25, // 2 次：上浮
  1.5, //  3 次：上浮更多
  1.75, // ≥4 次：接近拒保阈值
];

/** 交强险因子：单独浮动，只看"本年度是否出险"与"是否有人伤"。数值是模拟口径。 */
export const COMPULSORY_FACTORS = {
  noClaim: 0.9,
  claimNoInjury: 1.0,
  claimWithInjury: 1.3,
} as const;

/**
 * 商业险与交强险在年保费里的占比（模拟口径）：保单数据只有一个 `annualPremium`，
 * 两张表要分开浮动就得先拆。
 */
export const COMMERCIAL_SHARE = 0.8;

/** 出险次数（含本次）达到这个数，ruleNote 提示"可能被拒保或加费承保"。 */
export const RENEWAL_RISK_CLAIMS = 3;

export const NCD_DISCLAIMER = "模拟测算，实际以保险公司核定为准";

export interface ForecastInput {
  policy: Policy;
  /** 这一次要报的案是否涉及人伤——交强险因子由它决定。 */
  injury?: boolean;
}

export interface ForecastResult {
  policyId: string;
  /** 本保单年度已出险次数（不含本次）；保单没记就按 0。 */
  claimsThisPolicyYear: number;
  /** 含本次的出险次数——分档依据。 */
  claimsAfterThis: number;
  currentPremium: number;
  /** 报了这一次案，次年保费。 */
  nextYearPremium: number;
  /** 不报这一次案，次年保费——出险的代价要和它比，不是和今年比（今年的折扣本来就会变）。 */
  nextYearIfNoClaim: number;
  /** 次年保费增量：nextYearPremium − nextYearIfNoClaim，即"报这一次案多交多少"。 */
  delta: number;
  commercialFactor: number;
  compulsoryFactor: number;
  /** 出险次数到达拒保风险阈值时为 true——只是提示，不是结论。 */
  renewalRisk: boolean;
  ruleNote: string;
  disclaimer: string;
}

function factorFor(claims: number): number {
  const idx = Math.min(Math.max(0, claims), COMMERCIAL_NCD_FACTORS.length - 1);
  return COMMERCIAL_NCD_FACTORS[idx];
}

/**
 * 给定保单与"再报一次案"，算次年保费。
 *
 * 保单缺 `annualPremium` 时不编一个基数：保费按 0 算、`ruleNote` 说明"保单未记年保费，
 * 只给因子不给金额"——一个编出来的保费基数会让净收益整个数变成假的。
 */
export function forecastPremium(input: ForecastInput): ForecastResult {
  const { policy, injury = false } = input;
  const claimsBefore = Math.max(0, Math.floor(policy.claimsThisPolicyYear ?? 0));
  const claimsAfter = claimsBefore + 1;
  const hasBase = typeof policy.annualPremium === "number" && policy.annualPremium > 0;
  const current = hasBase ? (policy.annualPremium as number) : 0;

  const commercialFactor = factorFor(claimsAfter);
  const compulsoryFactor = injury ? COMPULSORY_FACTORS.claimWithInjury : COMPULSORY_FACTORS.claimNoInjury;
  // 反事实：不报这一次，次年按"已出险次数"那一档；交强险本年度没出过险才有无赔款优待。
  const commercialFactorIfNoClaim = factorFor(claimsBefore);
  const compulsoryFactorIfNoClaim = claimsBefore === 0 ? COMPULSORY_FACTORS.noClaim : COMPULSORY_FACTORS.claimNoInjury;

  // 两张表分开浮动：先按占比拆出商业险与交强险两块，各乘各的因子，再合回来。
  const commercialNow = current * COMMERCIAL_SHARE;
  const compulsoryNow = current * (1 - COMMERCIAL_SHARE);
  const nextYear = Math.round(commercialNow * commercialFactor + compulsoryNow * compulsoryFactor);
  const nextYearIfNoClaim = Math.round(commercialNow * commercialFactorIfNoClaim + compulsoryNow * compulsoryFactorIfNoClaim);
  // 出险的代价 = 报了之后的次年保费 − 不报的次年保费。第一次出险的代价主要是**丢掉本来能拿的折扣**，
  // 与今年保费比会把它算成 0——那正是车主最容易低估的那一部分。
  const delta = nextYear - nextYearIfNoClaim;
  const renewalRisk = claimsAfter >= RENEWAL_RISK_CLAIMS;

  const ruleNote =
    `本年度已出险 ${claimsBefore} 次，再报一次按 ${claimsAfter} 次档：商业险因子 ${commercialFactor}` +
    `（0 次 ${COMMERCIAL_NCD_FACTORS[0]} / 1 次 ${COMMERCIAL_NCD_FACTORS[1]} / 2 次 ${COMMERCIAL_NCD_FACTORS[2]}` +
    ` / 3 次 ${COMMERCIAL_NCD_FACTORS[3]} / 4 次及以上 ${COMMERCIAL_NCD_FACTORS[4]}），` +
    `交强险${injury ? "有人伤" : "无人伤"}因子 ${compulsoryFactor}；不报则按 ${claimsBefore} 次档（商业险 ${commercialFactorIfNoClaim}、交强险 ${compulsoryFactorIfNoClaim}）。` +
    `两者分开浮动，按商业险占年保费 ${COMMERCIAL_SHARE * 100}% 拆算；增量 = 报案后次年保费 − 不报的次年保费。` +
    (hasBase ? "" : "保单未记年保费，只给因子不给金额。") +
    "全国车险信息共享，换保险公司不改变出险记录。" +
    (renewalRisk ? `出险达 ${RENEWAL_RISK_CLAIMS} 次及以上，续保可能被拒保或加费承保。` : "");

  return {
    policyId: policy.policyId,
    claimsThisPolicyYear: claimsBefore,
    claimsAfterThis: claimsAfter,
    currentPremium: current,
    nextYearPremium: nextYear,
    nextYearIfNoClaim,
    delta,
    commercialFactor,
    compulsoryFactor,
    renewalRisk,
    ruleNote,
    disclaimer: NCD_DISCLAIMER,
  };
}
