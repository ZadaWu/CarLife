/**
 * ⑥ 实测能耗口径（施工单 M26-06，F-54-01 / F-54-07）。纯函数。
 *
 * 盯的是"算得出来 vs 说不出来"这条边：**样本不足、区间不合理、能源类型未知
 * 三种不可用理由各自可区分**，且都不给数值——回落厂标是调用方的事，
 * 不在这一层偷偷做。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MIN_FUEL_INTERVALS,
  electricConsumptionPer100km,
  fuelConsumptionPer100km,
  measuredEnergyPer100km,
  type RefuelRecord,
} from "../src/usage-telemetry/energy";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 26);
const ago = (d: number) => NOW - d * DAY;

/** 一台百公里 8 升的车：每 500 公里加 40 升。 */
const evenFuel = (n: number): RefuelRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    at: ago(150 - i * 20),
    liters: 40,
    odometerKm: 100_000 + i * 500,
  }));

describe("油侧：两次加油之间才算得出油耗", () => {
  it("一条记录算不出来，且说得清为什么", () => {
    const r = fuelConsumptionPer100km([{ at: ago(3), liters: 40, odometerKm: 100_000 }], NOW);
    assert.equal(r.consumption, undefined);
    assert.match(r.reason ?? "", /至少要两条/);
  });

  it("一条都没有 → 说「还没有任何加油记录」，与「只有一条」区分开", () => {
    const r = fuelConsumptionPer100km([], NOW);
    assert.match(r.reason ?? "", /还没有任何加油记录/);
  });

  it("三条记录 = 两个区间 → 给出实测油耗与推导", () => {
    const r = fuelConsumptionPer100km(evenFuel(3), NOW);
    assert.ok(r.consumption);
    assert.equal(r.consumption.value, 8, "40 升 ÷ 500 公里 × 100 = 8");
    assert.equal(r.consumption.unit, "L");
    assert.equal(r.consumption.sampleSize, 2, "样本量是**区间数**不是记录数");
    assert.ok(r.consumption.derivation.some((d) => d.includes("加油区间")));
  });

  it("两条记录（1 个区间）低于默认门槛 → 不给数值", () => {
    assert.equal(DEFAULT_MIN_FUEL_INTERVALS, 2);
    const r = fuelConsumptionPer100km(evenFuel(2), NOW);
    assert.equal(r.consumption, undefined);
    assert.match(r.reason ?? "", /有效区间只有 1 个/);
  });

  it("门槛可覆盖——取值依据未定（§13-21），不该写死在实现里", () => {
    const r = fuelConsumptionPer100km(evenFuel(2), NOW, 180, 1);
    assert.ok(r.consumption, "把门槛降到 1 个区间就该算得出来");
  });

  it("**里程倒退或过短的区间整段丢弃**，并在推导里说明", () => {
    const rows: RefuelRecord[] = [
      ...evenFuel(3),
      { at: ago(10), liters: 40, odometerKm: 101_010 }, // 与上一条只差 10km
    ];
    const r = fuelConsumptionPer100km(rows, NOW);
    assert.ok(r.consumption);
    assert.equal(r.consumption.sampleSize, 2, "那个 10km 的区间不参与均值");
    assert.ok(r.consumption.derivation.some((d) => d.includes("丢弃")));
  });

  it("离谱油耗（一次加满跑了几十公里）不进均值", () => {
    const rows: RefuelRecord[] = [
      ...evenFuel(3),
      { at: ago(5), liters: 190, odometerKm: 101_300 }, // 300km 加 190 升 → 63L/100km
    ];
    const r = fuelConsumptionPer100km(rows, NOW);
    assert.ok(r.consumption);
    assert.equal(r.consumption.value, 8, "均值不该被那一条带偏");
  });

  it("窗口取 180 天：加油是低频事件，30 天窗口会让绝大多数车永远凑不够", () => {
    const old = evenFuel(3).map((r) => ({ ...r, at: ago(120) }));
    assert.ok(fuelConsumptionPer100km(old, NOW, 180).consumption);
    assert.equal(fuelConsumptionPer100km(old, NOW, 30).consumption, undefined);
  });
});

describe("电侧：从实测续航折算成百分比", () => {
  it("满电续航 400km → 每百公里 25%", () => {
    const r = electricConsumptionPer100km(400, 12, 30, "常温");
    assert.equal(r.consumption?.value, 25);
    assert.equal(r.consumption?.unit, "%");
    assert.ok(r.consumption?.derivation.some((d) => d.includes("常温")));
  });

  it("没有续航样本 → 说清是哪一档没有，不给数值", () => {
    const r = electricConsumptionPer100km(undefined, 0, 30, "低温");
    assert.equal(r.consumption, undefined);
    assert.match(r.reason ?? "", /低温/);
  });

  it("**不用 kWh**：那要电池容量，而 ④ 里没有这个字段", () => {
    assert.equal(electricConsumptionPer100km(400, 1, 30, "常温").consumption?.unit, "%");
  });
});

describe("measuredEnergyPer100km：按能源类型选口径", () => {
  const base = { trips: [], refuels: evenFuel(3), rangeSampleSize: 10 };

  it("燃油走油耗（升）", () => {
    const r = measuredEnergyPer100km({ ...base, energyType: "icev" }, NOW);
    assert.equal(r.consumption?.unit, "L");
  });

  it("增程/插混也走油耗——长途以油为主是本期的简化假设", () => {
    const r = measuredEnergyPer100km({ ...base, energyType: "phev" }, NOW);
    assert.equal(r.consumption?.unit, "L");
  });

  it("纯电走电耗（百分比），常温优先", () => {
    const r = measuredEnergyPer100km(
      { ...base, energyType: "bev", mildTempRangeKm: 400, lowTempRangeKm: 280 },
      NOW,
    );
    assert.equal(r.consumption?.unit, "%");
    assert.equal(r.consumption?.value, 25);
  });

  it("纯电没有常温样本时退到低温档，并在推导里说明「实际会比这个省」", () => {
    const r = measuredEnergyPer100km({ ...base, energyType: "bev", lowTempRangeKm: 280 }, NOW);
    assert.ok(r.consumption);
    assert.ok(r.consumption.derivation.some((d) => d.includes("低温档")));
  });

  it("**能源类型未知 → 任何数值都不给**（与 graph/energy.ts 三分支同源）", () => {
    const r = measuredEnergyPer100km(base, NOW);
    assert.equal(r.consumption, undefined);
    assert.match(r.reason ?? "", /没有这辆车的能源类型/);
  });
});
