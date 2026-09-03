/**
 * 档案写路径留痕测试（施工单 M29-01，F-23-11 / AC-23-9）。
 *
 * 盯四件事：写入实际发生才留痕（400/404 零新增）；编辑记字段名与里程 [旧,新] 摘要；
 * 被"只前进"规则忽略的上报记 denied（用户"我改了但没生效"的唯一解释来源）；
 * 未注入 audit 时四条路由行为与此前逐字节相同（可选注入的回归钉）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { MaintenanceRecord, RepairRecord, VehicleProfile, VehicleStore } from "@carlife/memory";

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
    maintenance: [],
    repairs: [],
    updatedAt: 0,
    ...over,
  };
}

function memStore(seed: VehicleProfile[] = []) {
  const byVin = new Map(seed.map((p) => [p.vin, { ...p }]));
  const defaults = new Map<string, string>();
  const store: VehicleStore = {
    async get(vin) {
      return byVin.get(vin) ?? null;
    },
    async listByOwner(ownerId) {
      const all = [...byVin.values()].filter((p) => p.ownerId === ownerId);
      const def = defaults.get(ownerId);
      return all.sort((a, b) => Number(b.vin === def) - Number(a.vin === def));
    },
    async upsert(p) {
      byVin.set(p.vin, { ...p });
    },
    async setDefault(ownerId, vin) {
      const p = byVin.get(vin);
      if (!p || p.ownerId !== ownerId) throw new Error("not found");
      defaults.set(ownerId, vin);
      return p;
    },
    async appendMaintenance(vin, r: MaintenanceRecord) {
      const p = byVin.get(vin)!;
      p.maintenance = [...p.maintenance, r];
      return p;
    },
    async appendRepair(vin, r: RepairRecord) {
      const p = byVin.get(vin)!;
      p.repairs = [...p.repairs, r];
      return p;
    },
    async advanceOdometer(vin, km) {
      const p = byVin.get(vin)!;
      p.odometerKm = Math.max(p.odometerKm, km);
      return p;
    },
  };
  return { store, byVin, defaults };
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

const CREATE_BODY = {
  model: "宋 PLUS EV",
  modelYear: 2024,
  purchasedAt: Date.UTC(2024, 2, 1),
  odometerKm: 8_000,
  energyType: "bev",
};

/** detail 的键白名单（M3-01 PII 边界的机械检查）：出现任何白名单外的键即失败。 */
const DETAIL_KEYS = new Set(["created", "fields", "odometerKm", "reason"]);

function assertDetailWhitelisted(entries: VehicleAuditEntry[]) {
  for (const e of entries) {
    for (const k of Object.keys(e.detail ?? {})) {
      assert.ok(DETAIL_KEYS.has(k), `detail 出现白名单外的键：${k}`);
    }
  }
}

describe("留痕：POST /v1/vehicles（upsert）", () => {
  it("新建 → 一条 vehicle.upsert，created=true，target 是占位 vin", async () => {
    const entries: VehicleAuditEntry[] = [];
    const { store } = memStore();
    const r = await call(appWith(store, "demo-user", (e) => entries.push(e)), "POST", "/v1/vehicles", CREATE_BODY);
    assert.equal(r.status, 201);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "vehicle.upsert");
    assert.equal(entries[0].ownerId, "demo-user");
    assert.equal(entries[0].result, "ok");
    assert.equal(entries[0].vin, (r.body.vehicle as VehicleProfile).vin);
    assert.equal(entries[0].detail?.created, true);
    assertDetailWhitelisted(entries);
  });

  it("编辑改里程 → detail.fields 含 odometerKm 且带 [旧,新]", async () => {
    const entries: VehicleAuditEntry[] = [];
    const { store } = memStore([makeProfile({ odometerKm: 8_000 })]);
    const r = await call(appWith(store, "demo-user", (e) => entries.push(e)), "POST", "/v1/vehicles", {
      ...CREATE_BODY,
      vin: VIN,
      odometerKm: 9_500,
    });
    assert.equal(r.status, 201);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].detail?.created, false);
    assert.ok((entries[0].detail?.fields as string[]).includes("odometerKm"));
    assert.deepEqual(entries[0].detail?.odometerKm, [8_000, 9_500]);
    assertDetailWhitelisted(entries);
  });

  it("校验失败（400）零新增——没有发生写入", async () => {
    const entries: VehicleAuditEntry[] = [];
    const { store } = memStore();
    const r = await call(appWith(store, "demo-user", (e) => entries.push(e)), "POST", "/v1/vehicles", {
      ...CREATE_BODY,
      vin: "INVALID",
    });
    assert.equal(r.status, 400);
    assert.equal(entries.length, 0);
  });
});

describe("留痕：default / odometer", () => {
  it("设默认成功记一条；404 路径不记（探测不是修改）", async () => {
    const entries: VehicleAuditEntry[] = [];
    const mine = memStore([makeProfile()]);
    const okApp = appWith(mine.store, "demo-user", (e) => entries.push(e));
    assert.equal((await call(okApp, "POST", `/v1/vehicles/${VIN}/default`)).status, 200);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "vehicle.set_default");

    const theirs = memStore([makeProfile({ ownerId: "别人" })]);
    const denied: VehicleAuditEntry[] = [];
    const app404 = appWith(theirs.store, "demo-user", (e) => denied.push(e));
    assert.equal((await call(app404, "POST", `/v1/vehicles/${VIN}/default`)).status, 404);
    assert.equal(denied.length, 0);
  });

  it("里程前进记 ok + [旧,新]；倒退被忽略记 denied", async () => {
    const entries: VehicleAuditEntry[] = [];
    const { store } = memStore([makeProfile({ odometerKm: 12_000 })]);
    const app = appWith(store, "demo-user", (e) => entries.push(e));

    await call(app, "POST", `/v1/vehicles/${VIN}/odometer`, { odometerKm: 15_000 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].result, "ok");
    assert.deepEqual(entries[0].detail?.odometerKm, [12_000, 15_000]);

    await call(app, "POST", `/v1/vehicles/${VIN}/odometer`, { odometerKm: 100 });
    assert.equal(entries.length, 2);
    assert.equal(entries[1].result, "denied");
    assert.equal(entries[1].detail?.reason, "odometer_backwards_ignored");
    assertDetailWhitelisted(entries);
  });
});

describe("回归钉：未注入 audit 时行为与此前逐字节相同", () => {
  it("四条路由的状态码与响应体形状不变", async () => {
    const { store } = memStore([makeProfile()]);
    const app = appWith(store, "demo-user");
    assert.equal((await call(app, "GET", "/v1/vehicles")).status, 200);
    const up = await call(app, "POST", "/v1/vehicles", { ...CREATE_BODY, vin: VIN, odometerKm: 13_000 });
    assert.equal(up.status, 201);
    assert.ok(up.body.vehicle);
    assert.equal((await call(app, "POST", `/v1/vehicles/${VIN}/default`)).status, 200);
    const od = await call(app, "POST", `/v1/vehicles/${VIN}/odometer`, { odometerKm: 14_000 });
    assert.equal(od.status, 200);
    assert.equal((od.body.vehicle as VehicleProfile).odometerKm, 14_000);
  });
});
