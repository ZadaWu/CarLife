/**
 * ⑥ 的实测能耗口径（施工单 M26-06，FL-54 F-54-01 / F-54-07，架构文档 §7⑥ / §13-21）。
 *
 * # 两侧的单位不一样，而且必须不一样
 *
 * - **油侧**：升每百公里。只能从**补能流水**算——两次加油之间跑了多少、加了多少升。
 *   `Trip` 里没有加油量，所以这条数据源是本 Sprint 新补的（`RefuelRecord`）。
 * - **电侧**：**百分比每百公里**，从实测满电续航折算（`100 ÷ 续航 × 100`）。
 *   刻意不用 kWh：那需要电池容量，而 ④ 档案里没有这个字段；
 *   而且车主看仪表盘报的本来就是百分比（"还剩 40%"），单位一致才对得上。
 *
 * 这也是 `energyAskPrompt` 分两支问的根据：燃油问升、纯电问百分比。
 * 混一套单位的后果不是不好看，是**算出来的缺口没有意义**。
 *
 * # 为什么一条加油记录算不出油耗
 *
 * 百公里油耗按**两次加油之间**算：`liters(n) ÷ (odo(n) − odo(n−1)) × 100`。
 * 单条记录没有区间。所以"车主报了一次加油"≠"从此有实测油耗了"——
 * 这一点要能被话术说出口，否则用户会奇怪"我明明告诉你了"。
 *
 * # 不可用就说不可用
 *
 * 沿 `usage_profile` 既有的 `verdict.usable / reason` 形状（不另造一套语义）：
 * 样本不足、区间不合理、能源类型未知——**各自可区分**，且都不给数值。
 * 回落到厂标是**调用方**的事（`energy_gap` 的 `source: "rated"`），不在这一层偷偷做。
 */

import type { VehicleEnergyType } from "../vehicle-store";
import type { TripRecord } from "./summary";

const DAY_MS = 86_400_000;

/**
 * 至少要几个**区间**才给实测油耗。区间数 = 加油记录数 − 1。
 *
 * 默认 2（即 3 条加油记录）。**取值依据未定，见架构文档 §13-21**——
 * 一个区间就下结论太容易被一次"没加满"带偏，而门槛太高又等于永远用不上。
 * 调用方可覆盖；这里只给保守默认。
 */
export const DEFAULT_MIN_FUEL_INTERVALS = 2;

/** 单个区间的合理性边界。超出的区间**整段丢弃**并在推导里说明，不参与均值。 */
const MIN_INTERVAL_KM = 50; // 太短的区间里，"这次没加满"的误差会被放大成几倍油耗
const MAX_INTERVAL_KM = 2_000; // 中间显然漏记过至少一次加油
const MAX_PLAUSIBLE_L_PER_100KM = 40; // 超过它只能是记录错了，不是车太费油

/** 一条补能流水。存储在 `@carlife/db` 的 `refuel_records`。 */
export interface RefuelRecord {
  /** epoch ms。 */
  at: number;
  /** 这次加了多少升。**不是油箱容量，也不是剩余量。** */
  liters: number;
  /** 加油时的里程读数。区间油耗全靠它。 */
  odometerKm: number;
}

export interface EnergyConsumption {
  /** 每百公里消耗量。 */
  value: number;
  /** `L` = 升（油），`%` = 电量百分比（电）。 */
  unit: "L" | "%";
  /** 参与计算的样本数：油侧是**区间数**，电侧是有实测续航的行程数。 */
  sampleSize: number;
  windowDays: number;
  /** 推导过程，随结果交付——用户会问这个数怎么来的。 */
  derivation: string[];
}

export interface EnergyConsumptionResult {
  consumption?: EnergyConsumption;
  /** 拿不到时的具体理由。**"数据不足"四个字没用**，要说清缺什么。 */
  reason?: string;
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * 油侧：两次加油之间的实测油耗。
 *
 * 记录按里程升序配对。**里程倒退或持平的相邻两条整段丢弃**——
 * 那要么是记错了，要么中间换了车，两种情况都不该进均值。
 */
export function fuelConsumptionPer100km(
  records: readonly RefuelRecord[],
  now: number,
  windowDays = 180,
  minIntervals = DEFAULT_MIN_FUEL_INTERVALS,
): EnergyConsumptionResult {
  /*
   * 窗口取 180 天而不是 30：加油是低频事件，一个月可能只有一两次。
   * 用 30 天窗口会让绝大多数车永远凑不够区间，表现为"永远没有实测油耗"。
   */
  const from = now - windowDays * DAY_MS;
  const inWindow = [...records]
    .filter((r) => r.at >= from && r.at <= now)
    .sort((a, b) => a.odometerKm - b.odometerKm);

  if (inWindow.length === 0) return { reason: "还没有任何加油记录" };
  if (inWindow.length === 1) {
    // 说清楚为什么"我明明告诉你了"还是算不出来。
    return { reason: "只有 1 条加油记录——百公里油耗要按两次加油之间算，至少要两条" };
  }

  const rates: number[] = [];
  const dropped: string[] = [];
  for (let i = 1; i < inWindow.length; i += 1) {
    const prev = inWindow[i - 1];
    const cur = inWindow[i];
    const km = cur.odometerKm - prev.odometerKm;
    if (km < MIN_INTERVAL_KM || km > MAX_INTERVAL_KM) {
      dropped.push(`${Math.round(km)}km 的区间（不在 ${MIN_INTERVAL_KM}~${MAX_INTERVAL_KM}km 内）`);
      continue;
    }
    const rate = (cur.liters / km) * 100;
    if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_PLAUSIBLE_L_PER_100KM) {
      dropped.push(`${round(rate)}L/100km 的区间（超出合理范围）`);
      continue;
    }
    rates.push(rate);
  }

  if (rates.length < minIntervals) {
    const why =
      dropped.length > 0
        ? `有效区间只有 ${rates.length} 个（需要 ${minIntervals} 个）；丢弃了 ${dropped.join("、")}`
        : `有效区间只有 ${rates.length} 个（需要 ${minIntervals} 个）`;
    return { reason: why };
  }

  const value = round(rates.reduce((a, b) => a + b, 0) / rates.length);
  const derivation = [
    `百公里油耗 = ${rates.length} 个加油区间的均值（每个区间 = 本次加油量 ÷ 与上次加油的里程差 × 100）`,
    `窗口 ${windowDays} 天内共 ${inWindow.length} 条加油记录`,
  ];
  if (dropped.length > 0) derivation.push(`丢弃了 ${dropped.length} 个不合理区间：${dropped.join("、")}`);
  return {
    consumption: { value, unit: "L", sampleSize: rates.length, windowDays, derivation },
  };
}

/**
 * 电侧：从实测满电续航折算成"每百公里掉多少电"。
 *
 * `%/100km = 100 ÷ 满电续航km × 100`。用车主报得出来的单位（百分比），
 * 而不是 kWh——后者要电池容量，④ 里没有这个字段，猜一个等于编。
 *
 * 温度分档由调用方决定用哪一档：本函数只做折算，不替它选。
 */
export function electricConsumptionPer100km(
  rangeKm: number | undefined,
  sampleSize: number,
  windowDays: number,
  label: string,
): EnergyConsumptionResult {
  if (rangeKm === undefined || !Number.isFinite(rangeKm) || rangeKm <= 0) {
    return { reason: `窗口内没有可用的${label}实测续航样本` };
  }
  const value = round((100 / rangeKm) * 100);
  return {
    consumption: {
      value,
      unit: "%",
      sampleSize,
      windowDays,
      derivation: [
        `每百公里耗电 = 100km ÷ ${label}实测满电续航 ${round(rangeKm)}km × 100%`,
        `样本量 = 窗口内 ${sampleSize} 条带实测续航的行程`,
      ],
    },
  };
}

export interface EnergyInput {
  energyType?: VehicleEnergyType;
  trips: readonly TripRecord[];
  refuels: readonly RefuelRecord[];
  /** 低温实测续航（来自 `aggregate`）。冬季出行用它。 */
  lowTempRangeKm?: number;
  /** 常温实测续航。 */
  mildTempRangeKm?: number;
  /** 有实测续航的行程条数（来自 `aggregate` 的 sampleSize 语义）。 */
  rangeSampleSize?: number;
}

/**
 * 按能源类型选口径。**未知能源类型不给任何数值**——
 * 这与 `graph/energy.ts` 那三条分支同源：不知道这辆车烧什么时，
 * 给出的每一个能源数字都是编的。
 */
export function measuredEnergyPer100km(
  input: EnergyInput,
  now: number,
  windowDays = 30,
): EnergyConsumptionResult {
  if (!input.energyType) {
    return { reason: "档案里没有这辆车的能源类型，任何能耗口径都无从谈起" };
  }
  if (input.energyType === "bev") {
    // 纯电只有电耗。取常温档；没有常温样本时退到低温档并在推导里说明。
    const mild = electricConsumptionPer100km(
      input.mildTempRangeKm,
      input.rangeSampleSize ?? 0,
      windowDays,
      "常温",
    );
    if (mild.consumption) return mild;
    const low = electricConsumptionPer100km(
      input.lowTempRangeKm,
      input.rangeSampleSize ?? 0,
      windowDays,
      "低温",
    );
    if (low.consumption) {
      low.consumption.derivation.push("（窗口内没有常温样本，用的是低温档——实际会比这个省）");
      return low;
    }
    return { reason: mild.reason };
  }
  /*
   * 燃油与增程/插混都走油耗。
   *
   * 增程车确实两种能源都有，但**长途以油为主**是本期的简化假设
   * （M26-07 F-54-09 会按里程阈值选问哪一种），所以能耗口径也取油。
   * 规则升级归 US-54 的未决。
   */
  return fuelConsumptionPer100km(input.refuels, now, 180);
}
