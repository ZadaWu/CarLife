/**
 * energy_gap —— 补能缺口测算（施工单 M26-06，FL-54 F-54-02，架构文档 §5 工具表 / §4.6）。
 *
 * # 纯计算，没有 IO
 *
 * 能耗与余量**都从入参进来**：能耗由编排层从 ⑥ 取（`measuredEnergyPer100km`），
 * 余量只能由车主口述（§4.6：**实时余量不是它的数据源**）。
 * 这样它可以被完整单测，也不会在工具层制造第二条取数路径。
 *
 * 其中能耗那一栏**不经模型**：它不在 `energyGapSchema` 里，由编排层按轮注入
 * （见下面的 `EnergyConsumptionLookup`）。余量仍由模型填——那句话只有车主说得出。
 *
 * # 一个数都不许写死
 *
 * 需求描述里那句"500 公里消耗 80 升"是**举例**，不是可以硬编码的值——
 * 80L/500km = 16L/100km，对任何一台家用车都不是合理数字。
 * 本文件里没有任何能耗常数：换一台车、换一段里程，这个数就不同（AC-54-3）。
 *
 * # 够就说够
 *
 * `gap <= 0` 时 `refillCount` 是 **0**，不是"保险起见来一次"。
 * 硬塞一次停靠的代价是真实的：同行的老人小孩要多等一次（FL-18 的既有取向）。
 *
 * # 说"够"离安全结论只有一步
 *
 * 所以输出里带 `confidence`，且**永远给区间而不是一个点**：
 * 说够而实际不够，后果是有人被撂在路上（AC-54-11）。
 */

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

/** `L` = 升（燃油/增程），`%` = 电量百分比（纯电）。两侧单位不同是刻意的。 */
export type EnergyUnit = "L" | "%";

export interface EnergyGapArgs {
  /** 本次行程里程（公里）。 */
  distanceKm: number;
  /**
   * 每百公里消耗量与它的口径。
   *
   * `measured` = ⑥ 实测；`rated` = 厂商标称。**回落是调用方做的**，
   * 本工具只负责如实把口径带进结果——它决定了区间给多宽，也决定了怎么说这句话。
   */
  consumption?: {
    value: number;
    unit: EnergyUnit;
    source: "measured" | "rated";
    sampleSize?: number;
    windowDays?: number;
  };
  /** 车主口述的当前余量。**只能由入参传入**（§4.6：瞬时事实不进档案）。 */
  currentLevel?: { value: number; unit: EnergyUnit };
  /**
   * 一次补满能加多少（油箱容量 / 可用电量百分比）。
   * **不知道就别传**：不传时不给补能次数，只给缺口——编一个次数没有意义。
   */
  capacity?: { value: number; unit: EnergyUnit };
}

export interface EnergyGapData {
  /** 本次预计需要多少。口径不全时缺席。 */
  demand?: number;
  /** 需求区间 [低, 高]。**永远给区间**，不给一个点。 */
  demandRange?: [number, number];
  remaining?: number;
  /** 缺口 = 需求 − 余量。**负数表示够**（还富余多少）。 */
  gap?: number;
  /** 建议补能次数。`capacity` 未知时缺席；`gap <= 0` 时为 0。 */
  refillCount?: number;
  unit?: EnergyUnit;
  /** 够不够。缺口算不出来时为 `undefined`——**不猜**。 */
  sufficient?: boolean;
  /** 说得出口的依据，逐条。 */
  basis: string[];
  /** 缺什么。`demand` 或 `gap` 缺席时必有。 */
  missing?: string[];
}

/**
 * 区间宽度。
 *
 * `measured` 收窄、`rated` 放宽——厂标与真实油耗差三成是常态，
 * 拿它当实测报一个窄区间，就是把不确定性藏起来（AC-54-4）。
 * 取值依据未定（§13-21），这里给保守默认。
 */
const SPREAD: Record<"measured" | "rated", number> = { measured: 0.12, rated: 0.25 };

/**
 * 百公里能耗的合理上界，按单位分。它只管一件事：**拦住"满电续航被当成能耗"**。
 *
 * turn-9386d1c2 里模型把 ⑥ 的满电续航 428km 填成了百公里能耗。续航是几百公里量级，
 * 两档上界都在它下面，所以这一类不管配哪个单位都会被拦下。
 *
 * **它拦不住另一类**：同一轮模型换算重试，交了 93.46%/100km——那是整段 400km 的总电耗，
 * 数值落在上界之内，一路算出四倍的需求量进了 `submit_range_assessment`，全程零报错。
 * 那一类没有阈值拦得住，只能靠这一栏根本不经模型（见下面的 `EnergyConsumptionLookup`）。
 * 这道闸是给注入没覆盖到的路径兜底的，不是主防线。
 *
 * 判据取物理下限而不是"常见值"：`%` 超过 100 等于满电跑不到一百公里；`L` 这一档与 ⑥
 * 聚合侧的 `MAX_PLAUSIBLE_L_PER_100KM` 是同一个数，**改一处要改另一处**。
 */
const MAX_PLAUSIBLE_PER_100KM: Record<EnergyUnit, number> = { L: 40, "%": 100 };

const round = (n: number, d = 1): number => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

export function computeEnergyGap(args: EnergyGapArgs): EnergyGapData {
  const basis: string[] = [];
  const missing: string[] = [];

  if (!Number.isFinite(args.distanceKm) || args.distanceKm <= 0) {
    return { basis, missing: ["本次行程里程"] };
  }

  const c = args.consumption;
  if (!c || !Number.isFinite(c.value) || c.value <= 0) {
    // 没有能耗口径就**不给需求量**，只说清缺什么（AC-54-4 末条）。
    missing.push("这辆车的百公里能耗（⑥ 实测与厂商标称都拿不到）");
    return { basis, missing };
  }
  const ceiling = MAX_PLAUSIBLE_PER_100KM[c.unit];
  if (c.value > ceiling) {
    // 抛而不是静默当没给：**要让传的人看见**，与单位不一致那条同一条纪律。
    throw new ToolError(
      "energy_gap",
      "invalid",
      `百公里能耗 ${c.value}${c.unit} 超出物理上界 ${ceiling}${c.unit}——` +
        "传进来的多半是满电续航或整段总消耗量，不是每百公里的消耗量",
      false,
    );
  }

  const unit = c.unit;
  const demand = round((args.distanceKm * c.value) / 100);
  const spread = SPREAD[c.source];
  const demandRange: [number, number] = [
    round(demand * (1 - spread)),
    round(demand * (1 + spread)),
  ];

  basis.push(
    c.source === "measured"
      ? `按你最近${c.windowDays ? ` ${c.windowDays} 天` : ""}${
          c.sampleSize ? ` ${c.sampleSize} 个样本` : ""
        }实测的百公里 ${c.value}${unit}，${args.distanceKm} 公里大约要 ${demand}${unit}`
      : // 标称值必须说出来是标称值——否则用户会以为那是"他这台车"的数（AC-54-4）
        `按厂商标称的百公里 ${c.value}${unit}（**不是你的实测值**），${args.distanceKm} 公里大约要 ${demand}${unit}`,
  );
  basis.push(`考虑路况与驾驶差异，实际大概在 ${demandRange[0]}~${demandRange[1]}${unit} 之间`);

  const level = args.currentLevel;
  if (!level || !Number.isFinite(level.value)) {
    missing.push("当前能源余量");
    return { demand, demandRange, unit, basis, missing };
  }
  if (level.unit !== unit) {
    // 单位混用直接抛，**不静默换算**：升与百分之几之间没有通用换算，
    // 悄悄换一个等于给出一个凭空捏造的缺口。
    throw new ToolError(
      "energy_gap",
      "invalid",
      `单位不一致：能耗按 ${unit} 算，而余量给的是 ${level.unit}。不做静默换算`,
      false,
    );
  }

  const remaining = round(level.value);
  const gap = round(demand - remaining);
  const sufficient = gap <= 0;
  basis.push(
    sufficient
      ? `你现在有 ${remaining}${unit}，比预计需要的多 ${round(-gap)}${unit}`
      : `你现在有 ${remaining}${unit}，还差 ${gap}${unit}`,
  );

  let refillCount: number | undefined;
  if (sufficient) {
    // 够就是够。**不为了显得周到而硬塞一次停靠**——多停一次是同行者在等。
    refillCount = 0;
  } else if (args.capacity && args.capacity.unit === unit && args.capacity.value > 0) {
    refillCount = Math.ceil(gap / args.capacity.value);
    basis.push(`按一次补满 ${args.capacity.value}${unit} 算，路上大约要补 ${refillCount} 次`);
  } else {
    // 不知道一次能补多少就不给次数——编一个没有意义。
    basis.push("一次能补多少不知道（档案里没有油箱/电池容量），所以没法说要补几次");
  }

  return { demand, demandRange, remaining, gap, refillCount, unit, sufficient, basis };
}

/**
 * 能耗口径的按轮读取端（形态照抄 `energy-stop-candidates.ts` 的 `EnergyStopLookup`）。
 *
 * # 为什么这一栏不由模型填
 *
 * ⑥ 给的是**满电续航 km**，这里要的是**百公里消耗量**，中间那次换算此前没人定义，
 * 只能由模型心算。turn-9386d1c2 里它算了两次、两次都错：先把 428km 当成 428L/100km
 * （单位闸门拦下），再换算成 93.46%/100km（那是整段 400km 的总量，需求量因此放大四倍）。
 *
 * 权威源是编排层——`energyType` 在 ④、实测续航与加油流水在 ⑥，两样它这一轮都已经取过。
 * 所以按 ADR-012「向已经知道它的那一方要」，
 * 这一栏从 schema 里撤掉，改由编排层按 `(sessionId, turnId)` 注入。
 *
 * 三种返回各有含义，与 `EnergyStopLookup` 同一口径：
 * - `undefined`：没接（离线 / 单测 / 归不了轮）——退回入参里的那一份（通常也没有）；
 * - 有值：编排层这一轮算出来的口径，**它胜过入参**。
 */
export type EnergyConsumptionLookup = (ctx: {
  sessionId: string;
  turnId?: string;
}) => EnergyGapArgs["consumption"] | undefined;

let consumptionLookup: EnergyConsumptionLookup | undefined;

export function setEnergyConsumptionLookup(fn: EnergyConsumptionLookup | undefined): void {
  consumptionLookup = fn;
}

export function lookupEnergyConsumption(ctx: {
  sessionId: string;
  turnId?: string;
}): EnergyGapArgs["consumption"] | undefined {
  return consumptionLookup?.(ctx);
}

export const energyGapTool: ExternalTool<EnergyGapArgs, EnergyGapData> = defineExternalTool<
  EnergyGapArgs,
  EnergyGapData
>({
  name: "energy_gap",
  provider: "carlife-calc",
  timeoutMs: 2_000,
  async real(args, ctx) {
    // 能耗口径不在 schema 里（理由见 `EnergyConsumptionLookup`）：这一轮的那份由编排层注入。
    const injected = lookupEnergyConsumption({ sessionId: ctx.sessionId, turnId: ctx.turnId });
    return computeEnergyGap(injected ? { ...args, consumption: injected } : args);
  },
  /**
   * mock：一个**不够**的例子。
   *
   * 刻意不给"够"——够的那条分支不需要下游做任何事，
   * 用它当 mock 会让"缺口 → 补能点 → 并进方案"整条路径永远走不到。
   */
  mock(args) {
    return computeEnergyGap({
      ...args,
      consumption: args.consumption ?? {
        value: 8.6,
        unit: "L",
        source: "measured",
        sampleSize: 3,
        windowDays: 180,
      },
      currentLevel: args.currentLevel ?? { value: 20, unit: "L" },
    });
  },
});
