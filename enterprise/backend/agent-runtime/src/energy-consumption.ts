/**
 * 这一轮这辆车的百公里能耗口径，按轮暂存（turn-9386d1c2 的修复）。
 *
 * 形态照抄 `energy-candidates.ts`：①Working 层、进程内 Map、按 (sessionId, turnId) 键、
 * 轮结束即弃、不落库。**写入端是编排层**（`graph/supervisor.ts` 的行程节点），这一点与
 * 那几本白名单不同——它们记的是工具返回过什么，这一本记的是编排层算出来的事实。
 * 读取端是 `energy_gap` 工具，经 `setEnergyConsumptionLookup` 注入（装配在 `index.ts`）。
 *
 * # 为什么是一份事实而不是一个工具入参
 *
 * ⑥ 手里的是满电续航 km，`energy_gap` 要的是百公里消耗量，中间那次换算此前没人定义，
 * 只能由模型心算——turn-9386d1c2 里它算错了两次。按 ADR-012「向已经知道它的那一方要」，
 * 知道的那一方是编排层（④ 的能源类型 + ⑥ 的续航/加油流水，两样它取过了）。
 *
 * 后写覆盖前写：一轮里只有行程节点写，重复写的只可能是同一份。
 */

import type { EnergyConsumption } from "@carlife/memory";

/**
 * 存的是 `EnergyGapArgs["consumption"]` 的形状：⑥ 的 `EnergyConsumption` 加一个口径标记。
 *
 * `measuredEnergyPer100km` 顾名思义只产实测值，所以这里恒为 `measured`——
 * 但这一栏**必须显式带着**：`energy_gap` 的区间宽度按它分档（实测收窄、厂标放宽），
 * 而"拿厂标当实测报一个窄区间"就是把不确定性藏起来（AC-54-4）。
 */
export type TurnEnergyConsumption = EnergyConsumption & { source: "measured" };

const store = new Map<string, TurnEnergyConsumption>();

const key = (sessionId: string, turnId: string): string => `${sessionId}#${turnId}`;

export function recordEnergyConsumption(
  ctx: { sessionId?: string; turnId?: string },
  consumption: TurnEnergyConsumption | undefined,
): void {
  if (!ctx.sessionId || !ctx.turnId || !consumption) return;
  store.set(key(ctx.sessionId, ctx.turnId), consumption);
}

/** 读取（不删除）。没记过就是 `undefined`——与"没接"由调用方区分，口径同 `peekEnergyStopCandidates`。 */
export function peekEnergyConsumption(
  sessionId: string,
  turnId: string,
): TurnEnergyConsumption | undefined {
  return store.get(key(sessionId, turnId));
}

/** 轮结束清理（与 `sweepEnergyStopCandidates` 同一时机调用）。 */
export function sweepEnergyConsumption(sessionId: string, turnId: string): void {
  store.delete(key(sessionId, turnId));
}

/** 测试用：清空全部。 */
export function resetEnergyConsumption(): void {
  store.clear();
}
