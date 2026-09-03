/**
 * VIN 补录端点测试（施工单 M29-04，F-23-05 / F-23-11）。
 * [F-23-05][AC-23-2] 手动录入 VIN + 格式校验；[F-23-11][AC-23-9] 留痕。
 *
 * 盯四件事：只接受占位车（真 VIN 车 409 说清是过户）；格式与冲突校验；
 * 不泄露存在性（他人车与不存在同响应）；留痕 target 是新 vin、detail.from 是旧占位。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { MaintenanceRecord, RepairRecord, VehicleProfile, VehicleStore } from "@carlife/memory";

import { createVehicleRouter, type ReplaceVin, type VehicleAuditEntry } from "../src/http/vehicle";

const PEND = "PEND-M2904ROUTER";
const REAL = "LSVAA49P4E2123456";

function makeProfile(over: Partial<VehicleProfile> = {}): VehicleProfile {
  return {
    vin: PEND,
    ownerId: "demo-user",
    model: "测试车型",
    modelYear: 2024,
    purchasedAt: Date.UTC(2024, 0, 1),
    odometerKm: 12_000,
    maintenance: [],
    repairs: [],
    updatedAt: 0,
    ...over,
  };
}

function memStore(seed: VehicleProfile[] = []) {
  const byVin = new Map(seed.map((p) => [p.vin, { ...p }]));
  const store: VehicleStore = {
    async get(vin) {
      const p = byVin.get(vin);
      return p ? { ...p } : null;
    },
    async listByOwner(ownerId) {
      return [...byVin.values()].filter((p) => p.ownerId === ownerId);
    },
    async upsert(p) {
      byVin.set(p.vin, { ...p });
    },
    async setDefault(_o, vin) {
      return byVin.get(vin)!;
    },
    async appendMaintenance(vin, r: MaintenanceRecord) {
      const p = byVin.get(vin)!;
      p.maintenance = [...p.maintenance, r];
      return { ...p };
    },
    async appendRepair(vin, r: RepairRecord) {
      const p = byVin.get(vin)!;
      p.repairs = [...p.repairs, r];
      return { ...p };
    },
    async advanceOdometer(vin, km) {
      const p = byVin.get(vin)!;
      p.odometerKm = Math.max(p.odometerKm, km);
      return { ...p };
    },
  };
  const replaceVin: ReplaceVin = async (oldVin, newVin) => {
    const p = byVin.get(oldVin)!;
    byVin.delete(oldVin);
    const moved = { ...p, vin: newVin };
    byVin.set(newVin, moved);
    return moved;
  };
  return { store, byVin, replaceVin };
}

function appWith(
  store: VehicleStore,
  userId: string | null,
  replaceVin?: ReplaceVin,
  audit?: (e: VehicleAuditEntry) => void,
) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createVehicleRouter(store, undefined, audit, replaceVin));
  return app;
}

async function call(
  app: express.Express,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("POST /v1/vehicles/:vin/vin [F-23-05][AC-23-2]", () => {
  it("占位车补录成功 → 200 + 迁移后档案 + forecast", async () => {
    const { store, replaceVin, byVin } = memStore([makeProfile({ maintenanceIntervalKm: 10_000 })]);
    const r = await call(appWith(store, "demo-user", replaceVin), `/v1/vehicles/${PEND}/vin`, { vin: REAL });
    assert.equal(r.status, 200);
    const v = r.body.vehicle as VehicleProfile & { forecast?: unknown };
    assert.equal(v.vin, REAL);
    assert.ok(v.forecast, "推算随档案带出");
    assert.equal(byVin.has(PEND), false, "旧占位行已不存在");
  });

  it("小写输入归一化为大写", async () => {
    const { store, replaceVin } = memStore([makeProfile()]);
    const r = await call(appWith(store, "demo-user", replaceVin), `/v1/vehicles/${PEND}/vin`, {
      vin: REAL.toLowerCase(),
    });
    assert.equal(r.status, 200);
    assert.equal((r.body.vehicle as VehicleProfile).vin, REAL);
  });

  it("真 VIN 车 → 409 vin_already_set，文案说清是过户", async () => {
    const { store, replaceVin } = memStore([makeProfile({ vin: REAL })]);
    const r = await call(appWith(store, "demo-user", replaceVin), `/v1/vehicles/${REAL}/vin`, {
      vin: "LSVAA49P4E2999999",
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "vin_already_set");
    assert.match(String(r.body.detail), /过户/);
  });

  it("非法格式（含 O）→ 400；目标已存在 → 409 且响应体只有 error", async () => {
    const { store, replaceVin } = memStore([
      makeProfile(),
      makeProfile({ vin: REAL, ownerId: "别人" }),
    ]);
    const app = appWith(store, "demo-user", replaceVin);
    const bad = await call(app, `/v1/vehicles/${PEND}/vin`, { vin: "LSVAA49POE2123456" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "invalid_vin");
    const conflict = await call(app, `/v1/vehicles/${PEND}/vin`, { vin: REAL });
    assert.equal(conflict.status, 409);
    assert.deepEqual(Object.keys(conflict.body), ["error"], "不泄露对方车辆信息");
  });

  it("他人的占位车与不存在的车同响应（404）", async () => {
    const { store, replaceVin } = memStore([makeProfile({ ownerId: "别人" })]);
    const app = appWith(store, "demo-user", replaceVin);
    const theirs = await call(app, `/v1/vehicles/${PEND}/vin`, { vin: REAL });
    const missing = await call(app, `/v1/vehicles/PEND-NOSUCH/vin`, { vin: REAL });
    assert.equal(theirs.status, 404);
    assert.deepEqual(theirs.body, missing.body);
  });

  it("未注入 replaceVin → 503（没接 ≠ 不允许）", async () => {
    const { store } = memStore([makeProfile()]);
    const r = await call(appWith(store, "demo-user"), `/v1/vehicles/${PEND}/vin`, { vin: REAL });
    assert.equal(r.status, 503);
  });
});

describe("留痕 [F-23-11][AC-23-9]", () => {
  it("成功记 vehicle.vin.backfill，target=新 vin、detail.from=旧占位；失败路径零留痕", async () => {
    const entries: VehicleAuditEntry[] = [];
    const { store, replaceVin } = memStore([makeProfile()]);
    const app = appWith(store, "demo-user", replaceVin, (e) => entries.push(e));
    await call(app, `/v1/vehicles/${PEND}/vin`, { vin: "BAD" }); // 400
    assert.equal(entries.length, 0);
    await call(app, `/v1/vehicles/${PEND}/vin`, { vin: REAL });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "vehicle.vin.backfill");
    assert.equal(entries[0].vin, REAL);
    assert.deepEqual(entries[0].detail, { from: PEND });
  });
});
