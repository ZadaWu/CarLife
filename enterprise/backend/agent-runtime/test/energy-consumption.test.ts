/**
 * [F-54-02] 百公里能耗口径由编排层按轮注入（turn-9386d1c2 的修复）。
 *
 * 那一轮的形状：⑥ 手里是满电续航 428km，`energy_gap` 要的是百公里消耗量，中间那次换算
 * 此前没人定义，只能由模型心算。它算错了两次——428L/100km（被单位闸门拦下）、
 * 93.46%/100km（那是整段 400km 的总量，需求量因此放大四倍且一路无报错）。
 *
 * 这里钉住的是"换算归代码"：折算值本身、未知能源类型一个数都不给、
 * 油侧才读加油流水（纯电那一档零额外 IO 是把它折进同一次取数的全部理由），
 * 以及续航分支的措辞里不许再出现 `charging` 的动作指令。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { setRefuelStore, type RefuelLogStore } from "@carlife/tools";

import { rangeFactForEnergyBranch } from "../src/graph/energy";
import { loadVehicleEnergyFacts } from "../src/graph/range-facts";
import {
  peekEnergyConsumption,
  recordEnergyConsumption,
  resetEnergyConsumption,
  sweepEnergyConsumption,
} from "../src/energy-consumption";

const NOW = Date.UTC(2026, 8, 19);

const profile = (over: Record<string, unknown> = {}) => ({
  summary: {
    windowDays: 30,
    avgDailyKm: 42.1,
    commonChargeHours: [22],
    mildTempRangeKm: 428,
    sampleSize: 50,
    staleDays: 1,
    derivation: [],
    ...over,
  },
  verdict: { usable: true as const },
  fetched: 89,
});

afterEach(() => {
  resetEnergyConsumption();
  setRefuelStore(undefined);
});

describe("loadVehicleEnergyFacts：换算归代码，不归模型", () => {
  it("纯电：428km 满电续航折算成 23.4%/100km，口径标 measured 并带样本量", async () => {
    const facts = await loadVehicleEnergyFacts(
      { userId: "u1" },
      { sessionId: "s" },
      "bev",
      async () => profile(),
      () => NOW,
    );
    assert.equal(facts.consumption?.value, 23.4, "100 ÷ 428 × 100");
    assert.equal(facts.consumption?.unit, "%");
    assert.equal(facts.consumption?.source, "measured");
    assert.equal(facts.consumption?.sampleSize, 50);
    // 同一次取数也要照旧给出满电续航——自驾分支的 charging 靠它定插点间距。
    assert.deepEqual(facts.range, {
      status: "measured",
      mildTempRangeKm: 428,
      sampleSize: 50,
      windowDays: 30,
    });
  });

  it("**纯电不读加油流水**——零额外 IO 是把它折进同一次取数的全部理由", async () => {
    let reads = 0;
    setRefuelStore({
      append: async () => ({ id: "x" }),
      range: async () => {
        reads += 1;
        return [];
      },
    } satisfies RefuelLogStore);
    await loadVehicleEnergyFacts({ userId: "u1" }, { sessionId: "s" }, "bev", async () => profile(), () => NOW);
    assert.equal(reads, 0);
  });

  it("燃油：从加油流水算，读的是同一次取数里的那一趟", async () => {
    let reads = 0;
    setRefuelStore({
      append: async () => ({ id: "x" }),
      range: async () => {
        reads += 1;
        return [
          { at: NOW - 60 * 86_400_000, liters: 40, odometerKm: 10_000 },
          { at: NOW - 30 * 86_400_000, liters: 45, odometerKm: 10_500 },
          { at: NOW - 5 * 86_400_000, liters: 45, odometerKm: 11_000 },
        ];
      },
    } satisfies RefuelLogStore);
    const facts = await loadVehicleEnergyFacts(
      { userId: "u1" },
      { sessionId: "s" },
      "icev",
      async () => profile(),
      () => NOW,
    );
    assert.equal(reads, 1);
    assert.equal(facts.consumption?.value, 9);
    assert.equal(facts.consumption?.unit, "L");
    // 燃油车没有 rangeKm 入参，这一栏照旧缺席。
    assert.equal(facts.range, undefined);
  });

  it("仓储没实现区间读（单测里的写入桩）：口径缺席并说清理由，不回落到标称值", async () => {
    setRefuelStore({ append: async () => ({ id: "x" }) });
    const facts = await loadVehicleEnergyFacts(
      { userId: "u1" },
      { sessionId: "s" },
      "icev",
      async () => profile(),
      () => NOW,
    );
    assert.equal(facts.consumption, undefined);
    assert.match(facts.consumptionReason ?? "", /加油记录/);
  });

  it("能源类型未知：一个数都不给，连画像都不查", async () => {
    let fetched = 0;
    const facts = await loadVehicleEnergyFacts(
      { userId: "u1" },
      { sessionId: "s" },
      undefined,
      async () => {
        fetched += 1;
        return profile();
      },
      () => NOW,
    );
    assert.equal(fetched, 0);
    assert.equal(facts.consumption, undefined);
    assert.equal(facts.range, undefined);
    assert.match(facts.consumptionReason ?? "", /能源类型/);
  });

  it("画像里没有一条带实测续航的行程：纯电这一档口径缺席，理由原样带出", async () => {
    const facts = await loadVehicleEnergyFacts(
      { userId: "u1" },
      { sessionId: "s" },
      "bev",
      async () => profile({ mildTempRangeKm: undefined }),
      () => NOW,
    );
    assert.equal(facts.consumption, undefined);
    assert.match(facts.consumptionReason ?? "", /实测续航/);
  });
});

describe("按轮暂存：轮与轮之间不串", () => {
  const c = { value: 23.4, unit: "%" as const, source: "measured" as const, sampleSize: 50, windowDays: 30, derivation: [] };

  it("记了才读得到，且只在自己那一轮读得到", () => {
    recordEnergyConsumption({ sessionId: "s1", turnId: "t1" }, c);
    assert.equal(peekEnergyConsumption("s1", "t1")?.value, 23.4);
    assert.equal(peekEnergyConsumption("s1", "t2"), undefined);
    assert.equal(peekEnergyConsumption("s2", "t1"), undefined);
  });

  it("归不了轮就不记——宁可没有口径，也不要记到别人头上", () => {
    recordEnergyConsumption({ sessionId: "s1" }, c);
    recordEnergyConsumption({ turnId: "t1" }, c);
    assert.equal(peekEnergyConsumption("s1", "t1"), undefined);
  });

  it("轮结束清理", () => {
    recordEnergyConsumption({ sessionId: "s1", turnId: "t1" }, c);
    sweepEnergyConsumption("s1", "t1");
    assert.equal(peekEnergyConsumption("s1", "t1"), undefined);
  });
});

describe("续航分支的措辞：只陈述事实，不指派 charging", () => {
  const measured = { status: "measured" as const, mildTempRangeKm: 428, sampleSize: 50, windowDays: 30 };

  it("数字与出处都在，但一个 charging 的动作指令都没有", () => {
    const line = rangeFactForEnergyBranch(measured)!;
    assert.match(line, /常温约 428 km/);
    assert.match(line, /50 条行程/);
    // ownership 的工具表里没有 charging：教它怎么调等于把它引到错的落点。
    for (const forbidden of ["charging", "rangeKm", "startSoc"]) {
      assert.ok(!line.includes(forbidden), `不该出现 ${forbidden}`);
    }
  });

  it("明说这是满电续航不是百公里能耗——那正是 turn-9386d1c2 混掉的两个数", () => {
    const line = rangeFactForEnergyBranch(measured)!;
    assert.match(line, /不是百公里能耗/);
    assert.match(line, /不要自己拿这个数换算/);
  });

  it("没有实测续航时也不许编一个去折算", () => {
    const line = rangeFactForEnergyBranch({ status: "unavailable", reason: "还没有任何用车流水" })!;
    assert.match(line, /还没有任何用车流水/);
    assert.match(line, /不要编一个满电续航/);
  });
});
