/**
 * 口头补录的来源标注与不混同（施工单 M26-04，F-53-08，AC-53-6 / AC-53-7）。
 *
 * 两条负向断言是重点，且都属于"错了也不报错"那一类：
 *  - 来源标错 → 下游会说"根据行驶记录"，而它其实建立在一句口述之上；
 *  - 补录顺手写了 ⑥ 的流水 → 一句口述被当成一次观测，`usable` 凭空变 true。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { MaintenanceRecord, VehicleProfile, VehicleStore } from "@carlife/memory";
import { PROFILE_FACT_SOURCES, isProfileFactSource } from "@carlife/shared";

import { ToolError } from "../src/external";
import { getTool } from "../src/registry";
import { setVehicleStore, vehicleProfileWriteTool } from "../src/vehicle-profile";

const VIN = "LSJA24U91NS654321";

let written: { maintenance: MaintenanceRecord[]; odometer: Array<{ km: number; source?: string }> };

function store(): VehicleStore {
  const profile = (): VehicleProfile => ({
    vin: VIN,
    ownerId: "u",
    model: "Model Y",
    modelYear: 2023,
    purchasedAt: 0,
    odometerKm: 32_100,
    maintenance: [],
    repairs: [],
    updatedAt: 0,
  });
  return {
    async get() {
      return profile();
    },
    async listByOwner() {
      return [profile()];
    },
    async upsert() {},
    async setDefault() {
      return profile();
    },
    async appendMaintenance(_vin, r) {
      written.maintenance.push(r);
      return profile();
    },
    async appendRepair() {
      return profile();
    },
    async advanceOdometer(_vin, km, source) {
      written.odometer.push({ km, source });
      return profile();
    },
  };
}

const call = (args: Record<string, unknown>) =>
  vehicleProfileWriteTool.call(args as never, { sessionId: "s", agent: "ownership", mode: "real" });

beforeEach(() => {
  written = { maintenance: [], odometer: [] };
  setVehicleStore(store());
});

describe("来源标注：受控词表，缺省 owner-stated", () => {
  it("省略 source → **owner-stated**，不是留空也不是门店记录", async () => {
    await call({ vin: VIN, op: "odometer", odometerKm: 186_000 });
    assert.deepEqual(written.odometer, [{ km: 186_000, source: "owner-stated" }]);
  });

  it("保养记录同样带 owner-stated", async () => {
    await call({ vin: VIN, op: "maintenance", odometerKm: 186_000, items: "小保养" });
    assert.equal(written.maintenance[0].source, "owner-stated");
  });

  it("显式传门店记录时照传", async () => {
    await call({ vin: VIN, op: "odometer", odometerKm: 186_000, source: "dealer" });
    assert.equal(written.odometer[0].source, "dealer");
  });

  it("**非法来源直接拒，不悄悄回落**——回落的后果是把口述说成行驶记录", async () => {
    await assert.rejects(
      call({ vin: VIN, op: "odometer", odometerKm: 186_000, source: "用户自述" }),
      (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.equal(e.category, "invalid");
        assert.match(e.message, /owner-stated/);
        return true;
      },
    );
    assert.deepEqual(written.odometer, [], "拒了就不许有任何写入");
  });

  it("注册表 schema 与词表一致——两处漂移会让模型传一个工具不认的值", () => {
    const reg = getTool("vehicle_profile_write");
    assert.ok(reg);
    const parsed = reg.schema.safeParse({ vin: "x".repeat(17), op: "odometer", odometerKm: 1, source: "telemetry" });
    assert.equal(parsed.success, true);
    const bad = reg.schema.safeParse({ vin: "x".repeat(17), op: "odometer", odometerKm: 1, source: "用户自述" });
    assert.equal(bad.success, false, "schema 就该把非词表值挡在门外");
    for (const s of PROFILE_FACT_SOURCES) assert.ok(isProfileFactSource(s));
  });
});

describe("不混同：补录不生成 ⑥ 的行程流水（AC-53-7）", () => {
  it("`vehicle_profile_write` 的实现里不出现任何 ⑥ 写入路径", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/vehicle-profile.ts", import.meta.url), "utf8");
    for (const needle of ["ingestTrip", "usage-telemetry", "TripStore", "trip.create"]) {
      assert.equal(src.includes(needle), false, `补录路径不该出现「${needle}」——口述不是观测`);
    }
  });

  it("一次完整补录只碰 ④：odometer 与 maintenance 各一次，没有别的副作用", async () => {
    await call({ vin: VIN, op: "maintenance", odometerKm: 186_000, items: "小保养" });
    await call({ vin: VIN, op: "odometer", odometerKm: 186_000 });
    assert.equal(written.maintenance.length, 1);
    assert.equal(written.odometer.length, 1);
  });
});

describe("按他说的口径记", () => {
  it("「18 万 6 千多」这类口径由模型落成 186000，工具不做任何二次修正", async () => {
    await call({ vin: VIN, op: "odometer", odometerKm: 186_000 });
    assert.equal(written.odometer[0].km, 186_000, "不四舍五入、不取整到千位");
  });

  it("保养项目为空时拒写——档案记录会被拿去和修理厂争议，编不得", async () => {
    await assert.rejects(call({ vin: VIN, op: "maintenance", odometerKm: 1 }), (e: unknown) => {
      assert.ok(e instanceof ToolError);
      return true;
    });
  });
});
