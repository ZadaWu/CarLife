/**
 * 从 ⑥用车画像取这辆车的实测满电续航（沿途服务数据源交接，待执行事项 1）。
 *
 * 只在编排层的行程节点调一次（`supervisor.ts`），拿到的事实经 `rangeFact` 写进自驾分支的提示词。
 * 与该节点取能源类型的 `vehicle_profile` 调用同一手法同一理由：读失败不阻塞，
 * 按"没有实测续航"处理——而"没有"在这里是独立的一档，不是回落到某个默认值。
 *
 * 为什么由编排层取而不是给 drive 分支 `usage_profile` 工具：这个值是**事实**不是判断，
 * 代码取一次零成本，让模型多跑一趟工具只是把关键路径拉长（ADR-010：事实要送到判断者手里）。
 */

import { getRefuelStore, invokeTool, type ToolCallContext } from "@carlife/tools";
import {
  measuredEnergyPer100km,
  type RefuelRecord,
  type UsageProfile,
  type VehicleEnergyType,
} from "@carlife/memory";

import type { TurnEnergyConsumption } from "../energy-consumption";

import type { VehicleRangeFacts } from "./energy";

/** 单测可换的取数面：缺省走 `usage_profile` 工具（它自带 mock 三态）。 */
export type UsageProfileFetch = (
  args: { userId: string; vin?: string },
  ctx: ToolCallContext,
) => Promise<UsageProfile>;

const defaultFetch: UsageProfileFetch = async (args, ctx) => {
  const r = (await invokeTool("usage_profile", args, ctx)) as { data: UsageProfile };
  return r.data;
};

/** 画像 → 事实。纯函数，单测直接喂 `UsageProfile`。 */
export function rangeFactsFromUsage(profile: UsageProfile): VehicleRangeFacts {
  if (!profile.verdict.usable) {
    return { status: "unavailable", reason: profile.verdict.reason ?? "用车画像不可用" };
  }
  const { mildTempRangeKm, lowTempRangeKm, sampleSize, windowDays } = profile.summary;
  const mild = usableKm(mildTempRangeKm);
  const low = usableKm(lowTempRangeKm);
  if (mild === undefined && low === undefined) {
    return {
      status: "unavailable",
      reason: `近 ${windowDays} 天的 ${sampleSize} 条行程都没有实测续航记录`,
    };
  }
  return {
    status: "measured",
    ...(mild !== undefined ? { mildTempRangeKm: mild } : {}),
    ...(low !== undefined ? { lowTempRangeKm: low } : {}),
    sampleSize,
    windowDays,
  };
}

/** 0 与非有限值都当没有：一个"0 km 续航"进提示词会让 charging 抛「续航里程必须为正数」。 */
function usableKm(v: number | undefined): number | undefined {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined;
}


// ── 百公里能耗口径：与上面同一次取数（turn-9386d1c2）──────────────────────────

/** 油侧口径往回看多久。与 `measuredEnergyPer100km` 内部的窗口一致——它按里程配对，窗口短了就一个区间都凑不齐。 */
const REFUEL_WINDOW_DAYS = 400;

export interface VehicleEnergyFacts {
  /** 实测满电续航。**只给纯电/插混**，燃油车的 `refuel` 没有 rangeKm 入参。 */
  range?: VehicleRangeFacts;
  /** 这辆车的百公里能耗口径，注进 `energy_gap`。拿不到就缺席——不回落到标称值。 */
  consumption?: TurnEnergyConsumption;
  /** 拿不到口径时的具体理由，进日志与提示词。**"数据不足"四个字没用。** */
  consumptionReason?: string;
}

/**
 * ④ 的能源类型 + ⑥ 的画像/加油流水 → 这一轮的能源事实。
 *
 * # 为什么折进同一次取数
 *
 * `usage_profile` 这一跳本来就每轮跑一次（本机 PG，实测 3ms），而纯电的能耗口径
 * 就是拿它的 `mildTempRangeKm` 折算的纯算术（`100 ÷ 续航 × 100`），**零额外 IO**。
 * 油侧才多一次 `refuel` 区间读，且只在 icev / phev 这两档发生。
 *
 * 反过来还省一次模型往返：turn-9386d1c2 里模型自己又查了一遍画像、`energy_gap`
 * 失败后重试，那一来一回是 1.0 秒，且落在 fan-out 的尾巴上。
 *
 * 读失败一律不阻塞：按「拿不到」处理并带理由——**"没有"在这里是独立的一档，不是回落到某个默认值**。
 */
export async function loadVehicleEnergyFacts(
  args: { userId: string; vin?: string },
  ctx: ToolCallContext,
  energyType: VehicleEnergyType | undefined,
  fetch: UsageProfileFetch = defaultFetch,
  now: () => number = Date.now,
): Promise<VehicleEnergyFacts> {
  if (!energyType) {
    // 连烧什么都不知道，任何能耗数字都是编的（`measuredEnergyPer100km` 的同一条）。
    return { consumptionReason: "档案里没有这辆车的能源类型，任何能耗口径都无从谈起" };
  }

  let profile: UsageProfile | undefined;
  try {
    profile = await fetch(args, ctx);
  } catch (err) {
    console.warn("[graph] 取用车画像失败，本次按「没有实测续航」处理", err);
  }

  const electric = energyType === "bev" || energyType === "phev";
  const range: VehicleRangeFacts | undefined = !electric
    ? undefined
    : profile
      ? rangeFactsFromUsage(profile)
      : { status: "unavailable", reason: "用车画像读取失败" };

  // 油侧（含增程：长途以油为主，见 `decisiveEnergyFor`）才需要加油流水。
  const refuels = energyType === "bev" ? [] : await readRefuels(args, now());
  const measured = measuredEnergyPer100km(
    {
      energyType,
      trips: [],
      refuels,
      ...(profile?.summary.lowTempRangeKm !== undefined
        ? { lowTempRangeKm: profile.summary.lowTempRangeKm }
        : {}),
      ...(profile?.summary.mildTempRangeKm !== undefined
        ? { mildTempRangeKm: profile.summary.mildTempRangeKm }
        : {}),
      ...(profile ? { rangeSampleSize: profile.summary.sampleSize } : {}),
    },
    now(),
  );

  return {
    ...(range ? { range } : {}),
    // `source` 恒为 measured 但必须显式带（区间宽度按它分档，见 `TurnEnergyConsumption`）。
    ...(measured.consumption ? { consumption: { ...measured.consumption, source: "measured" as const } } : {}),
    ...(measured.consumption ? {} : { consumptionReason: measured.reason ?? "原因未知" }),
  };
}

/** 加油流水。仓储没注入（离线 / 单测）或没实现区间读时返回空——油耗口径随之缺席，不是回落。 */
async function readRefuels(
  args: { userId: string; vin?: string },
  now: number,
): Promise<readonly RefuelRecord[]> {
  const store = getRefuelStore();
  if (!store?.range) return [];
  try {
    return await store.range(args.userId, now - REFUEL_WINDOW_DAYS * 86_400_000, now, args.vin);
  } catch (err) {
    console.warn("[graph] 取补能流水失败，本次按「没有油耗口径」处理", err);
    return [];
  }
}
