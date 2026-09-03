/**
 * `insurance_quote` —— 车险分项估算（施工单 M21-05，FL-48 F-48-06~08）。
 *
 * # 它替换不了 `cost_calc` 里那个 0.035，它回答的是另一个问题
 *
 * `cost-calc.ts` 用单一 `insuranceRate` 逐年按当年车值计费。那个口径在
 * "五年总成本"里是够用的近似，但车主直接问"保险一年多少、都包含什么"时，
 * 它**既拆不开也说不清**——给一个 8000 出来，他会问"这 8000 里三者买的是多少万"，
 * 而我们答不上。
 *
 * # 每一项都是**区间**，不给点值
 *
 * 地区系数、无赔款优待系数、驾驶记录——这三样我们都拿不到，
 * 而它们能把同一台车的保费拉开一倍。给点值是把"不知道"伪装成"知道"。
 * **区间中点不允许被当成点值再四舍五入**（这条在返回值形状上就堵死了：
 * 没有任何一个字段是单个金额）。
 *
 * # 宽到没有信息量时，说"给不了"
 *
 * 一个 3000~30000 的区间不是估算，是废话。`USELESS_RANGE_RATIO` 越线时
 * `usable: false` 且**不给合计**——与 `runCostEstimate` 在车价未定时
 * "这一段不能出现任何总额"是同一条纪律。
 *
 * # 系数集中一处并带生效日期
 *
 * 新能源专属险的构成随监管调整。系数散落在函数里会**静默过期**——
 * 没有任何报错，只是数字慢慢变得不对。
 */

import { defineExternalTool, ToolError, type ExternalTool } from "./external";
import type { Range } from "./loan-calc";

export type QuoteSource = "user" | "assumed";

/** 一项系数：值 + **它是谁给的**。`source` 不允许缺省。 */
export interface QuotedAssumption {
  low: number;
  high: number;
  source: QuoteSource;
}

/** 第三者责任险的保额档位（万元）。**必须按档位给**，不给一个笼统数。 */
export const THIRD_PARTY_TIERS = [100, 200, 300] as const;
export type ThirdPartyTier = (typeof THIRD_PARTY_TIERS)[number];

/**
 * 全部系数集中在这里，**带生效日期**。
 *
 * 数值是公开口径下的**经验区间**，不是任何一家保险公司的报价。
 * 改这里就要同时改 `effectiveFrom`，否则没人知道它是什么时候的口径。
 */
export const INSURANCE_COEFFICIENTS = {
  effectiveFrom: "2026-01-01",
  /** 交强险：家用车按座位分两档，是固定值不是区间。 */
  compulsory: { under6Seats: 950, sixSeatsAndAbove: 1100 },
  /** 车损险费率（占车价比例）。 */
  damageRate: { low: 0.011, high: 0.016 },
  /** 三者险按保额档位的保费区间（元/年）。 */
  thirdParty: {
    100: { low: 900, high: 1400 },
    200: { low: 1100, high: 1700 },
    300: { low: 1300, high: 2000 },
  } as Record<ThirdPartyTier, Range>,
  /** 座位险（元/座/年）。 */
  passengerPerSeat: { low: 40, high: 80 },
  /** 新能源专属附加：电池 + 自用充电桩（元/年）。**非新能源不出现这两项。** */
  newEnergy: { battery: { low: 300, high: 700 }, charger: { low: 100, high: 300 } },
} as const;

/**
 * 区间宽到什么程度就该说"给不了有用的估算"。
 *
 * 2.5 倍：上界是下界的两倍半以上时，这个数对决策没有任何帮助。
 * 同一台车不同城市能差一倍，所以门槛不能定得太紧——但也不能没有。
 */
export const USELESS_RANGE_RATIO = 2.5;

export interface InsuranceQuoteArgs {
  vehiclePrice: number;
  energy: "bev" | "phev" | "icev";
  /** 座位数，决定交强险档位。缺省按 5 座。 */
  seats?: number;
  /** 只看某一个三者档位。不给就三档都给。 */
  thirdPartyCoverage?: ThirdPartyTier;
  /** 可覆盖的系数。给了就标 `source: "user"`。 */
  assumptions?: {
    compulsory?: number;
    damageRateLow?: number;
    damageRateHigh?: number;
    passengerPerSeatLow?: number;
    passengerPerSeatHigh?: number;
  };
}

export interface InsuranceItem {
  key: string;
  label: string;
  amount: Range;
  note?: string;
}

export interface InsuranceQuote {
  /** 分项。三者险按档位各占一项。 */
  items: InsuranceItem[];
  /**
   * 合计（首年）。**`usable: false` 时不存在**——
   * 给了，车主记住的就是那个数。
   */
  total?: Range;
  /** 这份估算有没有信息量。false 时 `total` 缺省且 `notes` 说明为什么。 */
  usable: boolean;
  /** 全部系数，**每项带来源标记**。 */
  assumptions: {
    compulsory: QuotedAssumption;
    damageRate: QuotedAssumption;
    passengerPerSeat: QuotedAssumption;
    /** 系数口径的生效日。**它不是系数**，所以没有 source 标记。 */
    coefficientsEffectiveFrom: string;
  };
  /** 撑开区间的变量与口径说明。 */
  notes: string[];
}

const round = (n: number): number => Math.round(n);
const rng = (low: number, high: number): Range => ({ low: round(low), high: round(high) });

/** 三者险用哪一档来进合计。不指定时取**中间档**，并在 notes 里说明。 */
const DEFAULT_TIER: ThirdPartyTier = 200;

export function quoteInsurance(args: InsuranceQuoteArgs): InsuranceQuote {
  if (!(args.vehiclePrice > 0)) {
    throw new ToolError("insurance_quote", "invalid", "车价必须为正数", false);
  }
  const seats = args.seats ?? 5;
  if (!Number.isInteger(seats) || seats < 1 || seats > 9) {
    throw new ToolError("insurance_quote", "invalid", "座位数要在 1~9 之间", false);
  }
  if (args.thirdPartyCoverage !== undefined && !THIRD_PARTY_TIERS.includes(args.thirdPartyCoverage)) {
    throw new ToolError(
      "insurance_quote",
      "invalid",
      `三者险保额只支持 ${THIRD_PARTY_TIERS.join(" / ")} 万这几档`,
      false,
    );
  }

  const C = INSURANCE_COEFFICIENTS;
  const ov = args.assumptions ?? {};
  const sourced = (low: number, high: number, user: boolean): QuotedAssumption => ({
    low,
    high,
    source: user ? "user" : "assumed",
  });

  const compulsoryValue = ov.compulsory ?? (seats >= 6 ? C.compulsory.sixSeatsAndAbove : C.compulsory.under6Seats);
  const damageLow = ov.damageRateLow ?? C.damageRate.low;
  const damageHigh = ov.damageRateHigh ?? C.damageRate.high;
  const seatLow = ov.passengerPerSeatLow ?? C.passengerPerSeat.low;
  const seatHigh = ov.passengerPerSeatHigh ?? C.passengerPerSeat.high;

  const items: InsuranceItem[] = [
    {
      key: "compulsory",
      label: "交强险",
      amount: rng(compulsoryValue, compulsoryValue),
      note: `固定值，家用${seats >= 6 ? "6 座及以上" : "6 座以下"}档；不随车价变`,
    },
    {
      key: "damage",
      label: "车损险",
      amount: rng(args.vehiclePrice * damageLow, args.vehiclePrice * damageHigh),
      note: "跟车价走，逐年随车值下降",
    },
  ];

  const tiers = args.thirdPartyCoverage ? [args.thirdPartyCoverage] : [...THIRD_PARTY_TIERS];
  for (const tier of tiers) {
    const band = C.thirdParty[tier];
    items.push({
      key: `thirdParty${tier}`,
      label: `第三者责任险（${tier} 万保额）`,
      amount: rng(band.low, band.high),
      note: "**保额档位不同，保费差得很明显**——这一项一定要说清买的是多少万",
    });
  }

  items.push({
    key: "passenger",
    label: `座位险（${seats} 座）`,
    amount: rng(seatLow * seats, seatHigh * seats),
  });

  const isNewEnergy = args.energy === "bev" || args.energy === "phev";
  if (isNewEnergy) {
    items.push({
      key: "battery",
      label: "新能源附加：动力电池",
      amount: rng(C.newEnergy.battery.low, C.newEnergy.battery.high),
    });
    items.push({
      key: "charger",
      label: "新能源附加：自用充电桩",
      amount: rng(C.newEnergy.charger.low, C.newEnergy.charger.high),
    });
  }

  // 合计用**一个**三者档位，不然三档会被重复加进去。
  const tierForTotal = args.thirdPartyCoverage ?? DEFAULT_TIER;
  const counted = items.filter(
    (i) => !i.key.startsWith("thirdParty") || i.key === `thirdParty${tierForTotal}`,
  );
  const low = counted.reduce((a, i) => a + i.amount.low, 0);
  const high = counted.reduce((a, i) => a + i.amount.high, 0);
  const ratio = low > 0 ? high / low : Number.POSITIVE_INFINITY;
  const usable = Number.isFinite(ratio) && ratio <= USELESS_RANGE_RATIO;

  const notes: string[] = [
    `合计按三者 ${tierForTotal} 万档算${args.thirdPartyCoverage ? "" : "（默认档位，可以指定别的档重算）"}`,
    "区间是被这三样撑开的，而它们我们都拿不到：**地区系数**（同一台车不同城市能差一倍）、" +
      "**无赔款优待系数**（往年出没出险）、**驾驶记录**。给我这三样里的任何一样，区间都能收窄",
    `系数口径生效日 ${C.effectiveFrom}——新能源专属险的构成随监管调整，过了这个日子要回来核一次`,
    "这是**规则估算，不是报价**：我们不接任何保险公司的报价接口，也不代办投保",
  ];
  if (!isNewEnergy) {
    notes.push("燃油车没有新能源专属附加，所以那两项**不出现**（不是 0）");
  }
  if (!usable) {
    notes.push(
      `⚠️ 上下界相差 ${Number.isFinite(ratio) ? ratio.toFixed(1) : "∞"} 倍，超过了 ${USELESS_RANGE_RATIO} 倍的门槛——` +
        "**这个估算没有信息量，所以不给合计**。要收窄，得先知道地区与出险记录",
    );
  }

  return {
    items,
    ...(usable ? { total: rng(low, high) } : {}),
    usable,
    assumptions: {
      compulsory: sourced(compulsoryValue, compulsoryValue, ov.compulsory !== undefined),
      damageRate: sourced(damageLow, damageHigh, ov.damageRateLow !== undefined || ov.damageRateHigh !== undefined),
      passengerPerSeat: sourced(
        seatLow,
        seatHigh,
        ov.passengerPerSeatLow !== undefined || ov.passengerPerSeatHigh !== undefined,
      ),
      coefficientsEffectiveFrom: C.effectiveFrom,
    },
    notes,
  };
}

/** 纯规则计算，无外部依赖——与 `cost_calc` / `loan_calc` 同形态。 */
export const insuranceQuoteTool: ExternalTool<InsuranceQuoteArgs, InsuranceQuote> = defineExternalTool({
  name: "insurance_quote",
  provider: "rule-engine",
  sensitive: false,
  timeoutMs: 1_000,
  retries: 0,
  real: async (args) => quoteInsurance(args),
});
