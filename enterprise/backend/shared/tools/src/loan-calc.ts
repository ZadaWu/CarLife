/**
 * `loan_calc` —— 车贷测算（施工单 M21-04，FL-48 F-48-01/02/04）。
 *
 * # 它补的是 `cost_calc` 文件头里写着、代码里一行都没有的那一半
 *
 * §5 工具表给 `cost_calc` 的职责原文是"**保险 / 贷款 / 五年使用成本**，数据来源：规则计算"。
 * 贷款那一半从来没实现，而 `subgraphs/buying.ts` 的 `OUT_OF_SCOPE` 又把
 * `首付|分期|贷款利率` 整条归进"实时价格与优惠行情"，于是问月供得到的是"我答不了"。
 *
 * **利率是行情，月供是算术。** 两者被混成一件事，是这个工具存在的理由：
 *  - 利率随银行、随时间、随金融方案变，我们确实不知道，也不猜；
 *  - 给定本金、利率、期数，等额本息的月供是一个确定的数，算错就是错。
 *
 * # 没给利率就给**区间**，不给一个编出来的点值
 *
 * `resolveVehiclePrice` 的注释写着"绝不用一个居中的猜测值先算出来再说明——
 * 那个总数会被记住，说明不会"。利率是同一类数字，而且郑明会拿月供去店里对账。
 * 所以未给利率时按一个**明确标注为示例档位**的区间两端各算一次，
 * 返回的月供本身就是一个区间——它长得就不像一个报价。
 *
 * # 纯规则计算，一行 LLM 调用都没有
 *
 * 与 `cost-calc.ts` 同形态，可脱离 Agent 与 LLM 单测（AC-34-4）。
 */

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

/** 一个数是**用户给的**还是**我们假设的**。这个标记不允许缺省。 */
export type RateSource = "user" | "assumed";

/** 区间。利率由用户指定时 `low === high`——形状统一，调用方不用分支。 */
export interface Range {
  low: number;
  high: number;
}

/**
 * 未给利率时使用的**示例档位**。
 *
 * 不是报价，也不是"市场平均"——我们没有那个数据。取一个够宽的带，
 * 让结果一眼看上去就是估算：区间中点**不允许**被当成点值再四舍五入。
 */
export const ASSUMED_RATE_BAND: Range = { low: 3.5, high: 5.5 };

export interface LoanCalcArgs {
  /** 车价（元）。 */
  vehiclePrice: number;
  /** 首付金额（元）。与 `downPaymentRatio` 二选一。 */
  downPayment?: number;
  /** 首付比例（0~1）。与 `downPayment` 二选一。 */
  downPaymentRatio?: number;
  /** 期数（月）。 */
  months: number;
  /** 年利率（百分数，如 4.5）。**不给就走 `ASSUMED_RATE_BAND` 并标注为假设。** */
  annualRate?: number;
}

export interface EqualInstallment {
  monthlyPayment: Range;
  totalInterest: Range;
  totalPayment: Range;
}

export interface EqualPrincipal {
  firstMonthPayment: Range;
  lastMonthPayment: Range;
  totalInterest: Range;
  totalPayment: Range;
}

export interface LoanBreakdown {
  vehiclePrice: number;
  downPayment: number;
  /** 首付比例，保留四位。用户给的是金额时由代码换算，并在 notes 里说明用的是哪一种。 */
  downPaymentRatio: number;
  principal: number;
  months: number;
  /** 年利率（百分数）。`source` 一律非空——**不存在无标注的利率**。 */
  annualRate: Range & { source: RateSource };
  equalInstallment: EqualInstallment;
  equalPrincipal: EqualPrincipal;
  /** 全款 vs 贷款的口径对照。**只给量，不给结论。** */
  cashVsLoan: {
    /** 贷款比全款多付的利息（等额本息口径）。 */
    extraInterest: Range;
    /** 不掏出去的那笔钱（＝本金）。它的机会成本取决于车主的资金成本，我们不知道。 */
    cashKept: number;
    note: string;
  };
  /** 每个数怎么来的，供车主逐条质疑。 */
  notes: string[];
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 等额本息月供。利率为 0 时公式除零，退化成本金均摊。 */
export function equalInstallmentMonthly(principal: number, months: number, annualRate: number): number {
  if (principal === 0) return 0;
  const i = annualRate / 100 / 12;
  if (i === 0) return principal / months;
  return (principal * i) / (1 - (1 + i) ** -months);
}

function equalInstallmentAt(principal: number, months: number, rate: number) {
  const monthly = equalInstallmentMonthly(principal, months, rate);
  const total = monthly * months;
  return { monthly, total, interest: total - principal };
}

/** 等额本金：本金均摊，利息按剩余本金逐月递减；总利息有闭式解。 */
function equalPrincipalAt(principal: number, months: number, rate: number) {
  const i = rate / 100 / 12;
  const base = principal / months;
  return {
    first: base + principal * i,
    last: base + base * i,
    interest: principal * i * ((months + 1) / 2),
    total: principal + principal * i * ((months + 1) / 2),
  };
}

const rangeOf = (low: number, high: number): Range => ({ low: round(low), high: round(high) });

export function calcLoan(args: LoanCalcArgs): LoanBreakdown {
  if (!(args.vehiclePrice > 0)) {
    throw new ToolError("loan_calc", "invalid", "车价必须为正数", false);
  }
  if (!Number.isInteger(args.months) || args.months <= 0) {
    throw new ToolError("loan_calc", "invalid", "期数必须为正整数（单位：月）", false);
  }
  if (args.downPayment !== undefined && args.downPaymentRatio !== undefined) {
    throw new ToolError("loan_calc", "invalid", "首付金额与首付比例只能给一个", false);
  }
  if (args.annualRate !== undefined && (!Number.isFinite(args.annualRate) || args.annualRate < 0)) {
    throw new ToolError("loan_calc", "invalid", "年利率不能为负", false);
  }

  const notes: string[] = [];
  let downPayment: number;
  if (args.downPayment !== undefined) {
    if (!(args.downPayment >= 0) || args.downPayment > args.vehiclePrice) {
      throw new ToolError("loan_calc", "invalid", "首付要在 0 到车价之间", false);
    }
    downPayment = args.downPayment;
    notes.push(`首付按**金额** ${downPayment} 元计（车主给的是金额，不是比例）`);
  } else if (args.downPaymentRatio !== undefined) {
    if (!(args.downPaymentRatio > 0) || args.downPaymentRatio > 1) {
      throw new ToolError("loan_calc", "invalid", "首付比例要在 0~1 之间", false);
    }
    downPayment = args.vehiclePrice * args.downPaymentRatio;
    notes.push(
      `首付按**比例** ${round(args.downPaymentRatio * 100, 2)}% 换算为 ${round(downPayment)} 元（车主给的是比例）`,
    );
  } else {
    throw new ToolError(
      "loan_calc",
      "invalid",
      "必须给首付金额或首付比例之一——**不假设一个首付**，那个数会被记住",
      false,
    );
  }

  const principal = args.vehiclePrice - downPayment;
  const months = args.months;
  const userRate = args.annualRate !== undefined;
  const band: Range = userRate
    ? { low: args.annualRate as number, high: args.annualRate as number }
    : ASSUMED_RATE_BAND;

  if (userRate) {
    notes.push(`年利率 ${band.low}% 是**车主给的**`);
    if (band.low === 0) {
      notes.push("按 0 利率算＝**车主转述的免息方案**。我们不掌握任何品牌的贴息政策，这个前提以他说的为准");
    }
  } else {
    notes.push(
      `年利率**没有给，下面用的是示例档位 ${band.low}%~${band.high}%**——` +
        "这是假设不是报价，真实利率以银行/金融方案为准。给我一个确切利率我就按它重算",
    );
  }

  const eiLow = equalInstallmentAt(principal, months, band.low);
  const eiHigh = equalInstallmentAt(principal, months, band.high);
  const epLow = equalPrincipalAt(principal, months, band.low);
  const epHigh = equalPrincipalAt(principal, months, band.high);

  if (principal === 0) {
    notes.push("首付等于车价，本金为 0——这其实就是全款，没有利息");
  }
  notes.push("等额本息每月还款额固定；等额本金第一个月最高、逐月递减，**总利息更少但前期压力更大**");
  notes.push("以上是纯规则计算（不是模型估的），不含手续费、GPS 费、保证金等各家不同的名目");

  return {
    vehiclePrice: round(args.vehiclePrice),
    downPayment: round(downPayment),
    downPaymentRatio: round(downPayment / args.vehiclePrice, 4),
    principal: round(principal),
    months,
    annualRate: { ...band, source: userRate ? "user" : "assumed" },
    equalInstallment: {
      monthlyPayment: rangeOf(eiLow.monthly, eiHigh.monthly),
      totalInterest: rangeOf(eiLow.interest, eiHigh.interest),
      totalPayment: rangeOf(eiLow.total, eiHigh.total),
    },
    equalPrincipal: {
      firstMonthPayment: rangeOf(epLow.first, epHigh.first),
      lastMonthPayment: rangeOf(epLow.last, epHigh.last),
      totalInterest: rangeOf(epLow.interest, epHigh.interest),
      totalPayment: rangeOf(epLow.total, epHigh.total),
    },
    cashVsLoan: {
      extraInterest: rangeOf(eiLow.interest, eiHigh.interest),
      cashKept: round(principal),
      note:
        "全款省下的就是这笔利息；贷款留在手上的就是这笔本金。" +
        "**哪个划算取决于你这笔钱的资金成本与风险偏好——这个我不知道，也不该问你的收入。**",
    },
    notes,
  };
}

/** 纯规则计算，无外部依赖——与 `cost_calc` 同形态。 */
export const loanCalcTool: ExternalTool<LoanCalcArgs, LoanBreakdown> = defineExternalTool({
  name: "loan_calc",
  provider: "rule-engine",
  sensitive: false,
  timeoutMs: 1_000,
  retries: 0,
  real: async (args) => calcLoan(args),
});
