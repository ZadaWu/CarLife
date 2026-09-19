/**
 * vehicle_energy —— 车机侧的实时电量 / 油量与仪表剩余续航。
 *
 * 这个工具存在的理由：`mocks/cabin` 的能量遥测端点从 M27 起就在报这两个数，
 * `CabinClient.energy` 也早就写好了，**却没有任何消费方**——于是行程规划一直说
 * "这辆车没有可用的实测续航数据，请出发前看仪表自己安排补能"。
 *
 * 盯三条：**满量程是折算的**（除零与缺失一律不给，编一个数比不给更糟）、
 * **未绑车机如实报错**（不给默认值，否则"我不知道"会被说成"够开"）、
 * **纯电看电、燃油看油**（插混两样都有时以电优先，与档位判断分开）。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { deriveFullRangeKm, setCabinClient, vehicleEnergyTool, type CabinClient } from "../src/index";
import { setVehicleStore } from "../src/vehicle-profile";
import type { VehicleStore } from "@carlife/memory";

const VIN = "LSJA24U91NS662403";

const fakeVehicles = {
  async get() {
    return null;
  },
  async listByOwner() {
    return [
      { vin: VIN, ownerId: "u1", model: "Model Y", modelYear: 2024, purchasedAt: 0, odometerKm: 0, maintenance: [], repairs: [], updatedAt: 0 },
    ];
  },
} as unknown as VehicleStore;

function clientReturning(energy: () => Promise<unknown>): CabinClient {
  const nope = () => {
    throw new Error("not used");
  };
  return {
    bind: nope,
    status: nope,
    apply: nope,
    changes: nope,
    energy: energy as CabinClient["energy"],
    mediaLibrary: nope,
    mediaDuck: nope,
    mediaPlayer: nope,
    mediaCommand: nope,
    mediaSink: nope,
    mediaTrack: nope,
  } as unknown as CabinClient;
}

afterEach(() => {
  setCabinClient(undefined);
  setVehicleStore(undefined);
});

const ctx = { sessionId: "s1", turnId: "t1" };

describe("满量程折算", () => {
  it("按「剩余续航 ÷ 当前百分比」回推", () => {
    assert.equal(deriveFullRangeKm(413, 72.5), 570);
  });

  it("0% / 负数 / 缺失一律不折算——除零得出的 Infinity 进提示词最难查", () => {
    assert.equal(deriveFullRangeKm(413, 0), undefined);
    assert.equal(deriveFullRangeKm(413, -1), undefined);
    assert.equal(deriveFullRangeKm(undefined, 72.5), undefined);
    assert.equal(deriveFullRangeKm(413, undefined), undefined);
    assert.equal(deriveFullRangeKm(Number.NaN, 72.5), undefined);
  });
});

describe("vehicle_energy 的取数", () => {
  it("纯电：电量、仪表续航、折算满量程一起回来", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(
      clientReturning(async () => ({
        vehicleId: "VEH-1",
        model: "Model Y",
        energyType: "bev",
        battery: { percent: 72.5, rangeKm: 413, charging: true },
        mode: "charging",
        asOf: "2026-09-18T03:05:21.492Z",
        rebuilt: false,
      })),
    );
    const r = await vehicleEnergyTool.call({ userId: "u1" }, ctx);
    assert.equal(r.data.vin, VIN);
    assert.equal(r.data.battery?.percent, 72.5);
    assert.equal(r.data.fullRangeKm, 570);
  });

  it("燃油：没有 battery 时按 fuel 折算", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(
      clientReturning(async () => ({
        vehicleId: "VEH-2",
        model: "迈锐宝",
        energyType: "icev",
        fuel: { percent: 62, rangeKm: 380 },
        mode: "driving",
        asOf: "2026-09-18T03:05:21.492Z",
        rebuilt: false,
      })),
    );
    const r = await vehicleEnergyTool.call({ userId: "u1" }, ctx);
    assert.equal(r.data.fullRangeKm, 613);
  });

  it("车机报不出能量：不编一个满量程出来", async () => {
    setVehicleStore(fakeVehicles);
    setCabinClient(
      clientReturning(async () => ({
        vehicleId: "VEH-3",
        model: "Model Y",
        energyType: "bev",
        mode: "driving",
        asOf: "2026-09-18T03:05:21.492Z",
        rebuilt: false,
      })),
    );
    const r = await vehicleEnergyTool.call({ userId: "u1" }, ctx);
    assert.equal(r.data.fullRangeKm, undefined);
  });

  it("这位车主没有车辆档案：如实报错，不给默认读数", async () => {
    setVehicleStore({ async get() { return null; }, async listByOwner() { return []; } } as unknown as VehicleStore);
    setCabinClient(clientReturning(async () => ({})));
    await assert.rejects(() => vehicleEnergyTool.call({ userId: "u1" }, ctx), /建档/);
  });
});
