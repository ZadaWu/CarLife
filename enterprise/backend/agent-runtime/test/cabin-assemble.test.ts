/**
 * 车机装配（施工单 M24-02，F-49-02）。
 *
 * 这份测试存在的唯一理由：**注入口留了不等于接上了**（M15-01 教训）。
 * 断言装配后注入口真的被替换、URL 未配时真的被清空、绑定回写真的落进④档案。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { getCabinClient, setCabinClient } from "@carlife/tools";
import type { VehicleProfile, VehicleStore } from "@carlife/memory";

import { assembleCabin, bindingStoreFromVehicles } from "../src/cabin/assemble";

const profile = (over: Partial<VehicleProfile> = {}): VehicleProfile => ({
  vin: "LSJA0000000000001",
  ownerId: "u1",
  model: "Model Y",
  modelYear: 2024,
  purchasedAt: 0,
  odometerKm: 1000,
  maintenance: [],
  repairs: [],
  updatedAt: 0,
  ...over,
});

function fakeStore(rows: VehicleProfile[]): VehicleStore & { upserts: VehicleProfile[] } {
  const byVin = new Map(rows.map((r) => [r.vin, r]));
  const upserts: VehicleProfile[] = [];
  return {
    upserts,
    async get(vin) {
      return byVin.get(vin) ?? null;
    },
    async listByOwner() {
      return [...byVin.values()];
    },
    async upsert(p) {
      upserts.push(p);
      byVin.set(p.vin, p);
    },
    async setDefault() {
      throw new Error("not used");
    },
    async appendMaintenance() {
      throw new Error("not used");
    },
    async appendRepair() {
      throw new Error("not used");
    },
    async advanceOdometer() {
      throw new Error("not used");
    },
  };
}

afterEach(() => setCabinClient(undefined));

describe("assembleCabin：装配处必须可测", () => {
  it("URL 配了 → 注入口被替换（getCabinClient 有值），并返回 backend 供探活", () => {
    const backend = assembleCabin("http://localhost:8793", fakeStore([]));
    assert.ok(backend, "返回 backend");
    assert.ok(getCabinClient(), "注入口已替换");
  });

  it("URL 未配 → 注入口被清空，不留半配置状态", () => {
    assembleCabin("http://localhost:8793", fakeStore([]));
    const backend = assembleCabin(undefined, fakeStore([]));
    assert.equal(backend, undefined);
    assert.equal(getCabinClient(), undefined);
  });
});

describe("bindingStoreFromVehicles：绑定读写落④档案", () => {
  it("load：有档案给 {model, cabinVehicleId}，无档案给 null", async () => {
    const store = bindingStoreFromVehicles(
      fakeStore([profile({ cabinVehicleId: "VEH-000007" })]),
    );
    const hit = await store.load("LSJA0000000000001");
    assert.deepEqual(hit, { model: "Model Y", cabinVehicleId: "VEH-000007" });
    assert.equal(await store.load("LSJZZZZZZZZZZZZZ9"), null);
  });

  it("save：经 upsert 回写整份档案，其余字段原样保留", async () => {
    const vehicles = fakeStore([profile({ odometerKm: 4321 })]);
    const store = bindingStoreFromVehicles(vehicles);
    await store.save("LSJA0000000000001", "VEH-000042");
    assert.equal(vehicles.upserts.length, 1);
    assert.equal(vehicles.upserts[0].cabinVehicleId, "VEH-000042");
    assert.equal(vehicles.upserts[0].odometerKm, 4321, "改绑不动别的字段");
  });

  it("save：档案不存在时抛错，不静默建档", async () => {
    const store = bindingStoreFromVehicles(fakeStore([]));
    await assert.rejects(() => store.save("LSJZZZZZZZZZZZZZ9", "VEH-1"), /档案不存在/);
  });
});
