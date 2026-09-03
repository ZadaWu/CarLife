/**
 * 档案变更记录端点测试（施工单 M29-05，F-23-11 / AC-23-9）。
 *
 * 盯四件事：动作白名单（非 vehicle. 前缀不出现）；detail 不透传（受控视图）；
 * 跨用户/不存在同响应；VIN 补录跟查（旧占位时期的记录出现在新 vin 的末页）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { MaintenanceRecord, RepairRecord, VehicleProfile, VehicleStore } from "@carlife/memory";

import {
  changeSummary,
  createVehicleRouter,
  type AuditPageRow,
  type AuditReader,
} from "../src/http/vehicle";

const VIN = "LSVAA49P4E2123456";
const PEND = "PEND-M2905CHANGES";

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
  const store: VehicleStore = {
    async get(vin) {
      const p = byVin.get(vin);
      return p ? { ...p } : null;
    },
    async listByOwner(o) {
      return [...byVin.values()].filter((p) => p.ownerId === o);
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
  return { store };
}

function row(over: Partial<AuditPageRow>): AuditPageRow {
  return {
    id: `aud-${Math.random().toString(36).slice(2)}`,
    at: "2026-08-27T01:00:00.000Z",
    actorRole: "owner",
    action: "vehicle.upsert",
    result: "ok",
    detail: null,
    ...over,
  };
}

/** 内存审计读端：按 target 分桶，忽略 cursor（单页即末页）。 */
function memReader(byTarget: Record<string, AuditPageRow[]>): AuditReader {
  return async (q) => ({
    entries: byTarget[q.target] ?? [],
    hasMore: false,
    nextCursor: null,
  });
}

function appWith(store: VehicleStore, userId: string | null, reader?: AuditReader) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createVehicleRouter(store, undefined, undefined, undefined, reader));
  return app;
}

async function call(app: express.Express, path: string) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("GET /v1/vehicles/:vin/changes [F-23-11][AC-23-9]", () => {
  it("白名单过滤 + 受控视图（detail 不透传）+ 倒序保持", async () => {
    const { store } = memStore([makeProfile()]);
    const reader = memReader({
      [VIN]: [
        row({ at: "2026-08-27T03:00:00.000Z", action: "vehicle.odometer", detail: { odometerKm: [12_000, 12_500] } }),
        row({ at: "2026-08-27T02:00:00.000Z", action: "cabin.bind", detail: { secret: "x" } }),
        row({ at: "2026-08-27T01:00:00.000Z", action: "vehicle.set_default" }),
      ],
    });
    const r = await call(appWith(store, "demo-user", reader), `/v1/vehicles/${VIN}/changes`);
    assert.equal(r.status, 200);
    const changes = r.body.changes as Array<Record<string, unknown>>;
    assert.equal(changes.length, 2, "非 vehicle. 前缀的动作不出现");
    assert.deepEqual(Object.keys(changes[0]).sort(), ["action", "actorRole", "at", "id", "summary"]);
    assert.ok(!JSON.stringify(r.body).includes("secret"), "detail 不透传");
    assert.match(String(changes[0].summary), /12,000 → 12,500/);
  });

  it("跨用户与不存在同响应（404）；未注入读端 503", async () => {
    const theirs = memStore([makeProfile({ ownerId: "别人" })]);
    const app = appWith(theirs.store, "demo-user", memReader({}));
    const a = await call(app, `/v1/vehicles/${VIN}/changes`);
    const b = await call(app, `/v1/vehicles/NOSUCH/changes`);
    assert.equal(a.status, 404);
    assert.deepEqual(a.body, b.body);

    const mine = memStore([makeProfile()]);
    assert.equal((await call(appWith(mine.store, "demo-user"), `/v1/vehicles/${VIN}/changes`)).status, 503);
  });

  it("VIN 补录跟查：旧占位时期的记录并入末页并按时间倒序", async () => {
    const { store } = memStore([makeProfile()]);
    const reader = memReader({
      [VIN]: [
        row({ at: "2026-08-27T05:00:00.000Z", action: "vehicle.maintenance.append" }),
        row({ at: "2026-08-27T04:00:00.000Z", action: "vehicle.vin.backfill", detail: { from: PEND } }),
      ],
      [PEND]: [
        row({ at: "2026-08-27T02:00:00.000Z", action: "vehicle.upsert", detail: { created: true } }),
        row({ at: "2026-08-27T01:00:00.000Z", action: "guard.check" }), // 白名单同样作用于旧段
      ],
    });
    const r = await call(appWith(store, "demo-user", reader), `/v1/vehicles/${VIN}/changes`);
    const changes = r.body.changes as Array<{ at: string; summary: string }>;
    assert.equal(changes.length, 3, "新 2 + 旧 1（旧段的非白名单被滤掉）");
    assert.deepEqual(
      changes.map((c) => c.at),
      ["2026-08-27T05:00:00.000Z", "2026-08-27T04:00:00.000Z", "2026-08-27T02:00:00.000Z"],
      "合并后仍倒序",
    );
    assert.equal(changes[2].summary, "建立了车辆档案");
  });
});

describe("changeSummary 措辞", () => {
  it("各动作一句话；里程 denied 说清未生效；对话补录列出写入项", () => {
    assert.equal(changeSummary({ action: "vehicle.set_default", result: "ok", detail: null }), "设为默认车");
    assert.match(
      changeSummary({ action: "vehicle.odometer", result: "denied", detail: { odometerKm: [12_000, 100] } }),
      /未生效/,
    );
    assert.match(
      changeSummary({
        action: "vehicle.upsert",
        result: "ok",
        detail: { created: false, fields: ["odometerKm", "energyType"], odometerKm: [1, 2] },
      }),
      /里程、动力形式/,
    );
    assert.match(
      changeSummary({
        action: "vehicle.elicitation.fill",
        result: "ok",
        detail: { written: ["odometerKm", "maintenance"] },
      }),
      /里程、保养记录/,
    );
    assert.equal(
      changeSummary({ action: "vehicle.elicitation.fill", result: "denied", detail: {} }),
      "对话补录未获确认，没有写入",
    );
  });
});
