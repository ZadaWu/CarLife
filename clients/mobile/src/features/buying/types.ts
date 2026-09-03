/**
 * 购车页的数据形状（施工单 M15-05）。
 *
 * 与服务端 `graph/state.ts` 的 `BuyingPlanState` / `CostPlanState` 同形。
 * **不 import 服务端类型**：端上不依赖 agent-runtime 的包；
 * 形状变化由 `GET /v1/session/:id/buying` 的契约与这里的字段名共同守着。
 */

export interface SourceRef {
  document: string;
  /** 原文片段——AC-15-3「可点开查看来源」点开看到的就是它，不是摘要。 */
  snippet: string;
  score: number;
}

export interface Candidate {
  model: string;
  specs: { label: string; value: string; source: SourceRef }[];
  guidePrice?: { amount: number; trim: string; source: SourceRef };
  eliminatedBy?: { dimension: string; reason: string }[];
  /** 配置级事实（M21-02/06）。拿不到报价系统时缺省。 */
  trimSpecs?: { trim: string; priceCny?: number; rangeKm?: number; seats?: number }[];
  /** 让这台车通过硬约束的是哪几个配置——「六座来自 Model Y L」靠它。 */
  matchedTrims?: string[];
}

/** 区间。金融那一侧的数**没有一个是点值**。 */
export interface Range {
  low: number;
  high: number;
}

/** 配置比较（M21-03）。列 = 配置，不是列 = 车型。 */
export interface TrimPlan {
  models: string[];
  rows: { model: string; trim: string; priceCny?: number; rangeKm?: number; seats?: number }[];
  alignment: string;
  /** 对齐口径的人话说明——**表头必须写出来**，否则会被读成"拿顶配比入门"。 */
  alignmentNote: string;
  pairs: {
    left: { model: string; trim: string };
    right: { model: string; trim: string };
    diffs: { field: string; label: string; left?: number; right?: number; delta?: number; note?: string }[];
    marginalPricePerKm?: number;
  }[];
  unpricedModels: { model: string; note: string }[];
  missingModels: string[];
  droppedRows: { model: string; trim: string; priceCny: number; reason: string }[];
  sources: SourceRef[];
  at: number;
}

/** 贷款测算（M21-04）。**利率带 source**：`assumed` 时页面必须标出来。 */
export interface LoanPlan {
  breakdown: {
    vehiclePrice: number;
    downPayment: number;
    downPaymentRatio: number;
    principal: number;
    months: number;
    annualRate: Range & { source: "user" | "assumed" };
    equalInstallment: { monthlyPayment: Range; totalInterest: Range; totalPayment: Range };
    equalPrincipal: {
      firstMonthPayment: Range;
      lastMonthPayment: Range;
      totalInterest: Range;
      totalPayment: Range;
    };
    cashVsLoan: { extraInterest: Range; cashKept: number; note: string };
    notes: string[];
  };
  model: string;
  priceSource: { document: string; trim: string; kind: string };
  interestFreeClaimed: boolean;
  at: number;
}

/** 保费估算（M21-05）。`usable: false` 时**页面不显示任何合计金额**。 */
export interface InsurancePlan {
  quote: {
    items: { key: string; label: string; amount: Range; note?: string }[];
    total?: Range;
    usable: boolean;
    assumptions: {
      compulsory: Range & { source: "user" | "assumed" };
      damageRate: Range & { source: "user" | "assumed" };
      passengerPerSeat: Range & { source: "user" | "assumed" };
      coefficientsEffectiveFrom: string;
    };
    notes: string[];
  };
  model: string;
  priceSource: { document: string; trim: string; kind: string };
  at: number;
}

export interface BuyingPlan {
  candidates: Candidate[];
  eliminated: Candidate[];
  universe: { model: string; documents: string[] }[];
  unclassifiedDocs: number;
  at: number;
}

export interface CostPlan {
  breakdown: {
    years: number;
    items: Record<string, number>;
    total: number;
    perKm: number;
    assumptions: Record<string, number>;
    notes: string[];
  };
  model: string;
  priceSource: { document: string; trim: string; kind: "user" | "catalog" };
  changed: string[];
  at: number;
}

/**
 * 页面状态。
 *
 * **`offline` 与 `empty` 必须分开**（与档案页同一条纪律）：
 * "读不到"与"还没比过车"给用户的下一步动作完全不同，
 * 把前者显示成后者，等于拿"你还没比过"盖住一次故障。
 */
export type BuyingState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "empty" }
  | {
      kind: "ready";
      plan: BuyingPlan;
      cost: CostPlan | null;
      /** 三段各自独立为 null：只比过配置没算过钱时，金融分区显示"还没算"而不是整页变空。 */
      trim: TrimPlan | null;
      loan: LoanPlan | null;
      insurance: InsurancePlan | null;
    };

/** 假设名 → 中文标签。与服务端 `ASSUMPTION_LABELS` 同一套词，**8 项一个不少**。 */
export const ASSUMPTION_LABELS: Record<string, string> = {
  annualKm: "年行驶里程（km）",
  electricityPricePerKwh: "电价（元/kWh）",
  fuelPricePerLiter: "油价（元/L）",
  kwhPer100km: "百公里电耗（kWh）",
  litersPer100km: "百公里油耗（L）",
  insuranceRate: "商业险费率（占当年车值）",
  maintenancePerYear: "年均保养费（元）",
  residualRatePerYear: "年残值率",
};

/**
 * 区间怎么显示。
 *
 * **上下界相同才显示成一个数**（车主自己给了利率的情况）；
 * 其余一律显示成区间——取中点显示等于把"不知道"伪装成"知道"。
 */
export function rangeText(r: Range, unit = "元"): string {
  const fmt = (n: number) => Math.round(n).toLocaleString("zh-CN");
  return r.low === r.high ? `${fmt(r.low)} ${unit}` : `${fmt(r.low)} ~ ${fmt(r.high)} ${unit}`;
}

/** 对齐口径 → 人话短标签（长说明用 `alignmentNote`）。 */
export const ALIGNMENT_LABELS: Record<string, string> = {
  "same-model": "同一款车逐档",
  "trim-name": "按配置名对齐",
  "price-proximity": "按指导价接近度对齐",
  none: "对不上",
};

export const ITEM_LABELS: Record<string, string> = {
  vehiclePrice: "车价",
  energy: "能耗",
  insurance: "保险",
  maintenance: "保养",
  residualValue: "残值（回收）",
};

export const DIMENSION_LABELS: Record<string, string> = {
  budget: "预算",
  energy: "能源类型",
  seats: "座位数",
  bodyType: "车身形式",
};

/**
 * 矩阵的行：所有候选出现过的参数项并集。
 *
 * 缺项显示"—"并注明"资料中未提及"——**不留空、不猜**。
 * 留空会被读成"这一项两台一样"，而实际是我们没查到。
 */
export function specRows(candidates: readonly Candidate[]): string[] {
  const seen: string[] = [];
  for (const c of candidates) {
    for (const s of c.specs) if (!seen.includes(s.label)) seen.push(s.label);
  }
  return seen;
}
