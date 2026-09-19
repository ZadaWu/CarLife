/**
 * [F-18-05][F-54-07] 车机实时能量读数作为事实进行程分支的提示词。
 *
 * 这条链存在的理由：⑥ 的实测满电续航不可用时，助手会说"这辆车没有可用的实测续航数据，
 * 长途请出发前看仪表自己安排补能"——而那块仪表正是车机侧一直在报的东西
 * （`mocks/cabin` 的能量遥测端点从 M27 起就有，`CabinClient.energy` 也早就写好了，
 * 却没有任何工具或编排节点消费它）。
 *
 * 这里钉住三件事：读数 → 事实的映射（含"读不到"那一档）、`startSoc` 从写死的满电 1.0
 * 改成按读数折算、⑥ 不可用时降级到**仪表口径**满量程且口径要说出口。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { energyBranchPrompt, energySubmitDirective, rangeFact, type VehicleRangeFacts } from "../src/graph/energy";
import { energyNowFromReading, loadVehicleEnergyNow, type VehicleEnergyNow } from "../src/graph/energy-now";
import { runItineraryFanout, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import type { ChatStreamer } from "../src/llm";

// 与 range-fact.test.ts 同一理由：不关 Plan 层，单测会去打真网络。
process.env.CARLIFE_TRIP_PLAN_LAYER = "off";

const reading = {
  energyType: "bev" as const,
  battery: { percent: 72.5, rangeKm: 413, charging: false },
  fullRangeKm: 570,
  asOf: "2026-09-18T03:05:21.492Z",
};

const live: VehicleEnergyNow = {
  status: "live",
  energyType: "bev",
  batteryPercent: 72.5,
  batteryRangeKm: 413,
  fullRangeKm: 570,
  charging: false,
  asOf: reading.asOf,
};

describe("车机读数 → 事实", () => {
  it("有电量：百分比、仪表续航、折算满量程、读数时刻都带上", () => {
    const r = energyNowFromReading(reading);
    assert.deepEqual(r, live);
  });

  it("车机连上了却没报能量：与「没连上」同样不给数，且说清缺的是什么", () => {
    const r = energyNowFromReading({ energyType: "bev", asOf: reading.asOf });
    assert.equal(r.status, "unavailable");
    assert.match(r.status === "unavailable" ? r.reason : "", /没有报/);
  });

  it("0% 当没有——一个 0 进提示词会被 charging 以「startSoc 必须为正」拒掉", () => {
    const r = energyNowFromReading({ ...reading, battery: { percent: 0, rangeKm: 0, charging: false } });
    assert.equal(r.status, "unavailable");
  });

  it("燃油车读油量，同样走 live", () => {
    const r = energyNowFromReading({
      energyType: "icev",
      fuel: { percent: 62, rangeKm: 380 },
      fullRangeKm: 613,
      asOf: reading.asOf,
    });
    assert.equal(r.status, "live");
    assert.equal(r.status === "live" ? r.fuelPercent : undefined, 62);
  });

  it("未绑车机 / 车机不可达：不阻塞，按「读不到」处理并带理由", async () => {
    const r = await loadVehicleEnergyNow({ userId: "u1" }, { sessionId: "s", agent: "trip", mode: "real" }, async () => {
      throw new Error("车机未绑定");
    });
    assert.equal(r.status, "unavailable");
    assert.match(r.status === "unavailable" ? r.reason : "", /车机/);
  });
});

describe("rangeFact 里读数与实测的分工", () => {
  const measured: VehicleRangeFacts = {
    status: "measured",
    mildTempRangeKm: 402,
    sampleSize: 24,
    windowDays: 30,
  };

  it("两样都有：满量程用 ⑥ 的实测，startSoc 用车机读数", () => {
    const line = rangeFact(measured, live)!;
    assert.match(line, /常温约 402 km/);
    assert.match(line, /startSoc 填 0\.72/);
    assert.ok(!line.includes("按满电 1.0"), "有读数就不该再说按满电插点");
  });

  it("⑥ 不可用但车机报得出：降级到仪表口径满量程，**且把口径说出来**", () => {
    const line = rangeFact({ status: "unavailable", reason: "样本不足（2 条，需要至少 5 条）" }, live)!;
    assert.match(line, /rangeKm 用车机仪表口径的满量程 570 km/);
    assert.match(line, /车机仪表口径、非长期实测统计/);
    assert.ok(!line.includes("不要编一个 rangeKm"), "有出处就不该再让它交空数组");
  });

  it("两样都没有：还是那句「不要编一个 rangeKm」——降级链的末端没变", () => {
    const line = rangeFact({ status: "unavailable", reason: "还没有任何用车流水" }, { status: "unavailable", reason: "车机没连上" })!;
    assert.match(line, /不要编一个 rangeKm/);
  });

  it("读数只有电量、折算不出满量程：不冒充有出处，仍走「不要编」那一档", () => {
    const line = rangeFact(
      { status: "unavailable", reason: "还没有任何用车流水" },
      { status: "live", energyType: "bev", batteryPercent: 40, asOf: reading.asOf },
    )!;
    assert.match(line, /不要编一个 rangeKm/);
    assert.match(line, /车机也没报出可折算的满量程/);
  });

  it("读数时刻按北京时间写出来——「此刻」过一小时就不是此刻了", () => {
    assert.match(rangeFact(measured, live)!, /车机实时读数（09\/18 11:05）/);
  });

  it("燃油车（没有 range）：只报读数，不谈 rangeKm——`refuel` 没有这个入参", () => {
    const fuelLive: VehicleEnergyNow = {
      status: "live",
      energyType: "icev",
      fuelPercent: 62,
      fuelRangeKm: 380,
      fullRangeKm: 613,
      asOf: reading.asOf,
    };
    const line = rangeFact(undefined, fuelLive)!;
    assert.match(line, /油量 62%、仪表剩余续航 380 km/);
    assert.ok(!line.includes("rangeKm"));
  });

  it("两样都没有且没读数：一行都不加（与改动前逐字同行为）", () => {
    assert.equal(rangeFact(undefined, undefined), undefined);
    assert.equal(rangeFact(undefined, { status: "unavailable", reason: "车机没连上" }), undefined);
  });
});

describe("燃油车补能评估：有油量读数才允许给余量", () => {
  const fuelLive: VehicleEnergyNow = {
    status: "live",
    energyType: "icev",
    fuelPercent: 62,
    fuelRangeKm: 380,
    asOf: reading.asOf,
  };

  it("有读数：要 rangeMarginPct，且要求说明这是读数时刻的油量", () => {
    assert.match(energySubmitDirective("icev", fuelLive), /rangeMarginPct/);
    assert.match(energyBranchPrompt("icev", "去南通", fuelLive), /读数时刻的油量/);
  });

  it("没读数：一个字段都不给，且明说不要给百分比（编一个数比不给更糟）", () => {
    assert.ok(!energySubmitDirective("icev").includes("rangeMarginPct"));
    assert.match(energyBranchPrompt("icev", "去南通"), /不要给续航余量百分比/);
  });
});

describe("读数进哪几条分支的提示词（端到端形态）", () => {
  async function promptsFor(range: VehicleRangeFacts | undefined, energyNow: VehicleEnergyNow | undefined) {
    const seen: Record<string, string> = {};
    const streamer: ChatStreamer = async function* (messages, hooks) {
      seen[hooks?.agent ?? "?"] = messages[messages.length - 1]?.content ?? "";
      yield "";
    };
    const input: ItineraryInput = {
      goal: "南通三天",
      constraints: [],
      userText: "南通三天",
      energyType: "bev",
      ...(range ? { range } : {}),
      ...(energyNow ? { energyNow } : {}),
      turnId: "t1",
    };
    await runItineraryFanout(streamer, input, { threadId: "s-now", highlights: { fetch: async () => undefined } });
    return seen;
  }

  it("drive 与 ownership-task 拿到读数；hotel / tour / transit 不拿（对它们只是噪音）", async () => {
    const seen = await promptsFor({ status: "unavailable", reason: "还没有任何用车流水" }, live);
    assert.match(seen["drive-task"] ?? "", /电量 72\.5%、仪表剩余续航 413 km/);
    assert.match(seen["ownership-task"] ?? "", /电量 72\.5%/);
    for (const a of ["hotel-task", "tour-task", "transit-task"]) {
      assert.ok(!(seen[a] ?? "").includes("车机实时读数"), `${a} 不该收到能量读数`);
    }
  });

  it("没有读数时 drive 的提示词逐字不含「车机实时读数」", async () => {
    const seen = await promptsFor({ status: "measured", mildTempRangeKm: 402, sampleSize: 24, windowDays: 30 }, undefined);
    assert.ok(!(seen["drive-task"] ?? "").includes("车机实时读数"));
  });
});
