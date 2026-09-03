/**
 * 能量仿真：变化要可见、循环要闭环、确定性要成立、演示控制要严格。
 *
 * 时间全部注入（advanceEnergy 收 now 参数），不 sleep——
 * "过了 10 分钟"是用例的输入，不是用例的等待。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { advanceEnergy, energyTypeForModel, initEnergy, overrideEnergy, rehydrateEnergy, viewEnergy } from "../src/energy";
import type { EnergyState } from "../src/energy";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

describe("能量仿真", () => {
  it("行驶中电量随时间下降，续航跟着折算", () => {
    const e0 = initEnergy("VEH-000001", "Model Y", T0);
    assert.equal(e0.energyType, "bev");
    const e1 = advanceEnergy(e0, T0 + 10 * MIN);
    assert.ok(e1.batteryPercent! < e0.batteryPercent!, "10 分钟后电量必须比出发时低");
    assert.equal(e0.batteryPercent, initEnergy("VEH-000001", "Model Y", T0).batteryPercent, "初值确定");
    const v = viewEnergy(e1, "Model Y");
    assert.ok(v.battery!.rangeKm > 0 && v.battery!.rangeKm < 600);
    assert.equal(v.fuel, undefined, "纯电车不得报油量");
  });

  it("电量见底自动进充电、充到 90 拔枪继续开——演示车不会死在 0%", () => {
    let e: EnergyState = { ...initEnergy("VEH-000002", "Model 3", T0), batteryPercent: 12 };
    e = advanceEnergy(e, T0 + 5 * MIN); // 掉破 10 → charging
    assert.equal(e.mode, "charging");
    e = advanceEnergy(e, T0 + 60 * MIN);
    assert.equal(e.mode, "driving", "充满该拔枪");
    assert.ok(e.batteryPercent! <= 90 && e.batteryPercent! > 50);
  });

  it("燃油车油量下降、见底跳加油；同名车型动力形式确定", () => {
    // 合成分布里挑一个稳定落在 icev 的名字（确定性哈希，测试写死断言即可）
    const model = [...Array(50)].map((_, i) => `测试车型${i}`).find((m) => energyTypeForModel(m) === "icev")!;
    assert.ok(model, "合成分布里必须存在燃油车型");
    assert.equal(energyTypeForModel(model), energyTypeForModel(model));
    let e: EnergyState = { ...initEnergy("VEH-000003", model, T0), fuelPercent: 9 };
    assert.equal(e.batteryPercent, undefined, "燃油车不得报电量");
    e = advanceEnergy(e, T0 + 3 * MIN);
    assert.ok(e.fuelPercent! > 90, `见底应跳加油，实际 ${e.fuelPercent}`);
  });

  it("演示控制：越界拒绝不夹；燃油车拒绝充电模式", () => {
    const ev = initEnergy("VEH-000004", "Model Y", T0);
    assert.throws(() => overrideEnergy(ev, { batteryPercent: 120 }, T0), RangeError);
    assert.throws(() => overrideEnergy(ev, { fuelPercent: 50 }, T0), RangeError, "纯电车没有油量");
    const set = overrideEnergy(ev, { batteryPercent: 15 }, T0);
    assert.equal(set.batteryPercent, 15);
    const model = [...Array(50)].map((_, i) => `测试车型${i}`).find((m) => energyTypeForModel(m) === "icev")!;
    const fu = initEnergy("VEH-000005", model, T0);
    assert.throws(() => overrideEnergy(fu, { mode: "charging" }, T0), RangeError);
  });

  it("灌回：形状认得出才收；动力形式以代码为真相源", () => {
    const good = rehydrateEnergy({ energyType: "bev", batteryPercent: 33, mode: "charging", asOf: T0 - MIN }, "VEH-000006", "Model Y", T0);
    assert.equal(good.batteryPercent, 33);
    assert.equal(good.mode, "charging");
    const wrongType = rehydrateEnergy({ energyType: "icev", fuelPercent: 50 }, "VEH-000007", "Model Y", T0);
    assert.equal(wrongType.energyType, "bev", "快照里的动力形式与车型推导不符时按代码重来");
    const garbage = rehydrateEnergy("not-an-object", "VEH-000008", "Model Y", T0);
    assert.equal(garbage.energyType, "bev");
    assert.ok(garbage.batteryPercent! >= 45);
  });

  it("停机补算有上限：停一个月回来不至于跑几万步（也不会算出负数）", () => {
    const e = advanceEnergy(initEnergy("VEH-000009", "Model Y", T0), T0 + 30 * 24 * 60 * MIN);
    assert.ok(e.batteryPercent! >= 0 && e.batteryPercent! <= 100);
  });
});
