/**
 * 手动记一笔保养端点测试（施工单 M29-03，F-23-03 / F-23-11）。
 * [F-23-03][AC-23-3] 事件驱动事务写入；[F-23-03][AC-23-5] 写入后推算重算；
 * [F-23-11][AC-23-9] 留痕。
 *
 * 盯四件事：来源固定 owner-manual（与对话路径的 owner-stated 是两种证词）；
 * 里程先写且带来源（M26-04 踩过的顺序坑）；补录旧单不推进里程；
 * items 全文不进 audit detail。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { MaintenanceRecord, ProfileFactSource, RepairRecord, VehicleProfile, VehicleStore } from "@carlife/memory";

import { createVehicleRouter, type VehicleAuditEntry } from "../src/http/vehicle";

const VIN = "LSVAA49P4E2123456";

function makeProfile(over: Partial<VehicleProfile> = {}): VehicleProfile {
  return {
    vin: VIN,
    ownerId: "demo-user",
    model: "测试车型",
    modelYear: 2024,
    purchasedAt: Date.UTC(2024, 0, 1),
    odometerKm: 12_000,
    maintenanceIntervalKm: 10_000,
    maintenance: [],
    repairs: [],
    updatedAt: 0,
    ...over,
  };
}

/** 内存 store：行为对齐 repositories/vehicle.ts——appendMaintenance 顺带推进里程但不带来源。 */
function memStore(seed: VehicleProfile[] = []) {
  const byVin = new Map(seed.map((p) => [p.vin, { ...p }]));
  const odometerSources: Array<ProfileFactSource | undefined> = [];
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
    async setDefault(_ownerId, vin) {
      return byVin.get(vin)!;
    },
    async appendMaintenance(vin, r: MaintenanceRecord) {
      const p = byVin.get(vin)!;
      p.maintenance = [...p.maintenance, r];
      p.odometerKm = Math.max(p.odometerKm, r.odometerKm); // 顺带推进，不带来源
      return { ...p };
    },
    async appendRepair(vin, r: RepairRecord) {
      const p = byVin.get(vin)!;
      p.repairs = [...p.repairs, r];
      return { ...p };
    },
    async advanceOdometer(vin, km, source) {
      const p = byVin.get(vin)!;
      if (km > p.odometerKm) {
        p.odometerKm = km;
        odometerSources.push(source);
      }
      return { ...p };
    },
  };
  return { store, byVin, odometerSources };
}

function appWith(store: VehicleStore, userId: string | null, audit?: (e: VehicleAuditEntry) => void) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createVehicleRouter(store, undefined, audit));
  return app;
}

async function call(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const ENTRY = { at: Date.UTC(2026, 7, 20), odometerKm: 15_000, items: "机油机滤、轮胎换位" };

describe("POST /v1/vehicles/:vin/maintenance [F-23-03][AC-23-3]", () => {
  it("正常录入 → 201、记录追加、source=owner-manual、响应带重算的 forecast", async () => {
    const { store } = memStore([makeProfile()]);
    const r = await call(appWith(store, "demo-user"), "POST", `/v1/vehicles/${VIN}/maintenance`, ENTRY);
    assert.equal(r.status, 201);
    const v = r.body.vehicle as VehicleProfile & { forecast?: { remainingKm: number } };
    assert.equal(v.maintenance.length, 1);
    assert.equal(v.maintenance[0].source, "owner-manual");
    assert.equal(v.odometerKm, 15_000);
    // 推算随档案带出且基于新记录：15000 + 10000 - 15000 = 10000
    assert.equal(v.forecast?.remainingKm, 10_000);
  });

  it("里程先写且带 owner-manual 来源（M26-04 的顺序坑）", async () => {
    const { store, odometerSources } = memStore([makeProfile()]);
    await call(appWith(store, "demo-user"), "POST", `/v1/vehicles/${VIN}/maintenance`, ENTRY);
    assert.deepEqual(odometerSources, ["owner-manual"], "advanceOdometer 必须在 appendMaintenance 之前带来源执行");
  });

  it("补录旧单（odometerKm < 当前）→ 201 且档案里程不变 [F-23-03][AC-23-5]", async () => {
    const { store, byVin, odometerSources } = memStore([makeProfile({ odometerKm: 20_000 })]);
    const r = await call(appWith(store, "demo-user"), "POST", `/v1/vehicles/${VIN}/maintenance`, {
      ...ENTRY,
      odometerKm: 17_000,
    });
    assert.equal(r.status, 201);
    assert.equal(byVin.get(VIN)!.odometerKm, 20_000, "补录旧记录不得改小当前里程");
    assert.equal(odometerSources.length, 0, "没有推进就没有来源写入");
    assert.equal(byVin.get(VIN)!.maintenance.length, 1, "记录本身照常落");
  });

  it("校验：未来日期 / 空 items / 越界里程 → 400；他人 vin → 404", async () => {
    const { store } = memStore([makeProfile(), makeProfile({ vin: "LSVAA49P4E2999999", ownerId: "别人" })]);
    const app = appWith(store, "demo-user");
    const future = await call(app, "POST", `/v1/vehicles/${VIN}/maintenance`, {
      ...ENTRY,
      at: Date.now() + 86_400_000,
    });
    assert.equal(future.status, 400);
    assert.match(String(future.body.detail), /未来时间/);
    assert.equal((await call(app, "POST", `/v1/vehicles/${VIN}/maintenance`, { ...ENTRY, items: "  " })).status, 400);
    assert.equal(
      (await call(app, "POST", `/v1/vehicles/${VIN}/maintenance`, { ...ENTRY, odometerKm: 3_000_000 })).status,
      400,
    );
    assert.equal(
      (await call(app, "POST", `/v1/vehicles/LSVAA49P4E2999999/maintenance`, ENTRY)).status,
      404,
    );
  });
});

describe("留痕 [F-23-11][AC-23-9]", () => {
  it("成功录入记一条 vehicle.maintenance.append，items 全文不进 detail", async () => {
    const entries: VehicleAuditEntry[] = [];
    const { store } = memStore([makeProfile()]);
    await call(appWith(store, "demo-user", (e) => entries.push(e)), "POST", `/v1/vehicles/${VIN}/maintenance`, ENTRY);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "vehicle.maintenance.append");
    assert.equal(entries[0].vin, VIN);
    const detailJson = JSON.stringify(entries[0].detail);
    assert.ok(!detailJson.includes("机油"), "items 自由文本不得进 detail（M3-01 边界）");
    assert.equal(entries[0].detail?.itemsLength, ENTRY.items.length);
  });

  it("400 与 404 零留痕——没有发生写入", async () => {
    const entries: VehicleAuditEntry[] = [];
    const { store } = memStore([makeProfile()]);
    const app = appWith(store, "demo-user", (e) => entries.push(e));
    await call(app, "POST", `/v1/vehicles/${VIN}/maintenance`, { ...ENTRY, items: "" });
    await call(app, "POST", `/v1/vehicles/UNKNOWN/maintenance`, ENTRY);
    assert.equal(entries.length, 0);
  });
});
