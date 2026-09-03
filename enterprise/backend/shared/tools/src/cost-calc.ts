/**
 * cost_calc —— 保险 / 贷款 / 五年使用成本（§5 工具表，数据来源：**规则计算**）。
 *
 * 它的存在价值有两个，缺一不可：
 *  1. 业务上：郑明要的是**分项 + 全部计算假设**，不是一个总数（FL-15 F-15-04/05）；
 *  2. 工程上：它证明"工具可脱离 Agent 与 LLM 单测"（AC-34-4）——**本文件一行 LLM 调用都没有**。
 *
 * 假设必须随结果返回：用户改一个假设就能重算，这是"不给黑盒数字"的实现形态。
 */

import { defineExternalTool, type ExternalTool } from "./external";

export interface CostCalcArgs {
  /** 车价（元） */
  vehiclePrice: number;
  /** 能源类型决定按电价还是油价算 */
  energy: "bev" | "phev" | "icev";
  /** 可覆盖的假设；未给的用默认值，**默认值会原样出现在结果里** */
  assumptions?: Partial<CostAssumptions>;
  years?: number;
}

export interface CostAssumptions {
  /** 年行驶里程（km） */
  annualKm: number;
  /** 电价（元/kWh） */
  electricityPricePerKwh: number;
  /** 油价（元/L） */
  fuelPricePerLiter: number;
  /** 百公里电耗（kWh） */
  kwhPer100km: number;
  /** 百公里油耗（L） */
  litersPer100km: number;
  /** 商业险费率（占车价比例，逐年按残值折算） */
  insuranceRate: number;
  /**
   * 首年保险金额（元）。**可选覆盖**（施工单 M21-05，F-48-09）。
   *
   * 给了就用它当第一年的保险，后续年份仍按残值率逐年折算——
   * 也就是把 `车价 × insuranceRate` 这一项换成 `insurance_quote` 的分项合计，
   * 让同一轮对话里不会出现两个互相矛盾的保险数字（AC-48-7）。
   *
   * **不给时计算路径与 M21 之前逐字相同**：默认的首年保险就是 `车价 × insuranceRate`，
   * 而后续年份原本也正是它乘残值率的复利——两种写法数值完全等价，
   * M15-02 已验收的那份五年成本一个数都不会变（回归断言钉住了这一点）。
   */
  insuranceFirstYear?: number;
  /** 年均保养费（元） */
  maintenancePerYear: number;
  /** 年残值率（复利） */
  residualRatePerYear: number;
}

const DEFAULTS: CostAssumptions = {
  annualKm: 15_000,
  electricityPricePerKwh: 0.8,
  fuelPricePerLiter: 7.8,
  kwhPer100km: 15,
  litersPer100km: 7.5,
  insuranceRate: 0.035,
  maintenancePerYear: 1_200,
  residualRatePerYear: 0.85,
};

/** PHEV 按电为主、油为辅的粗略配比；口径随结果返回，可被质疑与修正。 */
const PHEV_ELECTRIC_SHARE = 0.7;

export interface CostBreakdown {
  years: number;
  /** 各分项五年合计（元） */
  items: {
    vehiclePrice: number;
    energy: number;
    insurance: number;
    maintenance: number;
    /** 负数：残值是回收的钱 */
    residualValue: number;
  };
  total: number;
  perKm: number;
  /** **全部**计算假设——包括用户没给、系统补的那些（F-15-05） */
  assumptions: CostAssumptions;
  /** 每个数字怎么来的，供用户质疑 */
  notes: string[];
}

function energyCostPerYear(args: CostCalcArgs, a: CostAssumptions): number {
  const per100Electric = a.kwhPer100km * a.electricityPricePerKwh;
  const per100Fuel = a.litersPer100km * a.fuelPricePerLiter;
  const per100 =
    args.energy === "bev"
      ? per100Electric
      : args.energy === "icev"
        ? per100Fuel
        : per100Electric * PHEV_ELECTRIC_SHARE + per100Fuel * (1 - PHEV_ELECTRIC_SHARE);
  return (a.annualKm / 100) * per100;
}

export function calcCost(args: CostCalcArgs): CostBreakdown {
  if (!(args.vehiclePrice > 0)) throw new Error("vehiclePrice 必须为正数");
  const years = args.years ?? 5;
  if (!Number.isInteger(years) || years <= 0) throw new Error("years 必须为正整数");

  const a: CostAssumptions = { ...DEFAULTS, ...args.assumptions };

  const energy = energyCostPerYear(args, a) * years;
  const maintenance = a.maintenancePerYear * years;

  /*
   * 保险逐年按当年车值计费——这是"五年保险不是车价×费率×5"的原因。
   *
   * 写成"首年金额 × 残值率的复利"而不是"当年车值 × 费率"，是为了让
   * `insuranceFirstYear` 能整项替换掉首年（M21-05）。两种写法**数值完全等价**：
   * 第 y 年 = 车价 × 残值率^y × 费率 = (车价 × 费率) × 残值率^y。
   * 不传覆盖时，M15-02 验收过的那份分项一个数都不会变。
   */
  let insurance = 0;
  let yearly = a.insuranceFirstYear ?? args.vehiclePrice * a.insuranceRate;
  let value = args.vehiclePrice;
  for (let y = 0; y < years; y += 1) {
    insurance += yearly;
    yearly *= a.residualRatePerYear;
    value *= a.residualRatePerYear;
  }
  const residualValue = -value;

  const total = args.vehiclePrice + energy + insurance + maintenance + residualValue;

  return {
    years,
    items: {
      vehiclePrice: round(args.vehiclePrice),
      energy: round(energy),
      insurance: round(insurance),
      maintenance: round(maintenance),
      residualValue: round(residualValue),
    },
    total: round(total),
    perKm: round(total / (a.annualKm * years), 3),
    assumptions: a,
    notes: [
      `能耗按${args.energy === "bev" ? "纯电" : args.energy === "icev" ? "燃油" : `插混（电占 ${PHEV_ELECTRIC_SHARE * 100}%）`}口径计算`,
      a.insuranceFirstYear !== undefined
        ? `保险首年按分项估算的 ${a.insuranceFirstYear} 元计（来自 insurance_quote，不是车价 × 费率），后续年份按残值率 ${a.residualRatePerYear} 逐年递减`
        : `保险逐年按当年车值 × ${a.insuranceRate} 计费，不是车价 × 费率 × ${years}`,
      `残值按年 ${a.residualRatePerYear} 复利折算，${years} 年末车值计入负成本`,
      "以上为估算，实际受地区、车型、驾驶习惯影响",
    ],
  };
}

function round(n: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** 纯规则计算，无外部依赖——四件套里它只用到"来源标注"这一件。 */
export const costCalcTool: ExternalTool<CostCalcArgs, CostBreakdown> = defineExternalTool({
  name: "cost_calc",
  provider: "rule-engine",
  sensitive: false,
  timeoutMs: 1_000,
  retries: 0,
  real: async (args) => calcCost(args),
});
