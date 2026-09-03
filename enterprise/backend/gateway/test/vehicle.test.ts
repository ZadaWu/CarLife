/**
 * ④车辆档案端点测试（施工单 M14-04）。
 *
 * 盯三件事：归属只认鉴权身份（跨用户 VIN 拒绝且不泄露存在性）；
 * 校验规则与端上向导一致（非法 VIN / 里程倒退 / 未来购车时间）；
 * 无 VIN 建档走占位主键且首辆车自动成为默认车。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { MaintenanceRecord, RepairRecord, VehicleProfile, VehicleStore } from "@carlife/memory";

import { createVehicleRouter, isPendingVin } from "../src/http/vehicle";

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

/** 内存 store：行为对齐 repositories/vehicle.ts 的可观察语义。 */
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

function appWith(store: VehicleStore, userId: string | null) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createVehicleRouter(store));
  return app;
}

/** 绑定车机的形状：没有 userId、有 vehicleVin（鉴权中间件对车辆 token 就填成这样）。 */
function cockpitAppWith(store: VehicleStore, vin: string) {
  const app = express();
  app.use((req, _res, next) => {
    const r = req as express.Request & { vehicleVin?: string; tokenKind?: string };
    r.vehicleVin = vin;
    r.tokenKind = "vehicle";
    next();
  });
  app.use(createVehicleRouter(store));
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

describe("GET /v1/vehicles", () => {
  it("未鉴权 401", async () => {
    const { store } = memStore([makeProfile()]);
    assert.equal((await call(appWith(store, null), "GET", "/v1/vehicles")).status, 401);
  });

  it("空列表 200 []——没建档是常态不是异常", async () => {
    const { store } = memStore();
    const r = await call(appWith(store, "demo-user"), "GET", "/v1/vehicles");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.vehicles, []);
  });

  /*
   * 绑定车机的读法（M54-07）。2026-09-01 走查：车机档案页恒 401，
   * 界面还把它说成"网关不可达"。车辆 token 读**自己绑的那辆**是合法读法
   * （R7 禁的是写），且 myRole 必须不是 owner——那会让端上渲染管理入口。
   */
  it("绑定车机读到自己绑的那辆，myRole=cockpit 不是 owner", async () => {
    const { store } = memStore([makeProfile(), makeProfile({ vin: "LSVAA49P4E2999999", ownerId: "别人" })]);
    const r = await call(cockpitAppWith(store, VIN), "GET", "/v1/vehicles");
    assert.equal(r.status, 200);
    const vehicles = r.body.vehicles as { vin: string; myRole: string; forecast?: unknown }[];
    assert.equal(vehicles.length, 1, "只有绑的那辆，不是全库");
    assert.equal(vehicles[0]!.vin, VIN);
    assert.equal(vehicles[0]!.myRole, "cockpit", "谎报 owner 会让端上渲染管理入口");
    assert.ok(vehicles[0]!.forecast !== undefined, "保养推算与按人列表同形状");
  });

  it("绑定车机、车还没建档：空列表 200，不是 404/401", async () => {
    const { store } = memStore();
    const r = await call(cockpitAppWith(store, VIN), "GET", "/v1/vehicles");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.vehicles, []);
  });

  it("车辆 token **不能建档**——R7：车机不写车辆档案", async () => {
    const { store } = memStore();
    const r = await call(cockpitAppWith(store, VIN), "POST", "/v1/vehicles", CREATE_BODY);
    assert.equal(r.status, 401);
  });

  it("只看到自己的车", async () => {
    const { store } = memStore([makeProfile(), makeProfile({ vin: "LSVAA49P4E2999999", ownerId: "别人" })]);
    const r = await call(appWith(store, "demo-user"), "GET", "/v1/vehicles");
    assert.equal((r.body.vehicles as unknown[]).length, 1);
  });

  it("每辆车附保养推算（M14-05）：无日均里程时不给到期时间——不猜", async () => {
    const { store } = memStore([makeProfile({ maintenanceIntervalKm: 10_000 })]);
    const r = await call(appWith(store, "demo-user"), "GET", "/v1/vehicles");
    const v = (r.body.vehicles as Array<{ forecast: { remainingKm: number; etaDays?: number; basis: string[] } }>)[0];
    assert.equal(typeof v.forecast.remainingKm, "number");
    assert.equal(v.forecast.etaDays, undefined, "端点拿不到⑥日均里程，不该编一个 etaDays");
    assert.ok(v.forecast.basis.length > 0, "依据必须随数值一起交付（Brief §2 同一视区）");
  });
});

describe("POST /v1/vehicles（建档/编辑）", () => {
  it("无 VIN 建档 → 占位主键 + 首辆车自动设默认", async () => {
    const { store, defaults } = memStore();
    const r = await call(appWith(store, "demo-user"), "POST", "/v1/vehicles", CREATE_BODY);
    assert.equal(r.status, 201);
    const vehicle = r.body.vehicle as VehicleProfile;
    assert.ok(isPendingVin(vehicle.vin), "无 VIN 建档必须是占位主键");
    assert.equal(r.body.pendingVin, true);
    assert.equal(defaults.get("demo-user"), vehicle.vin, "唯一一辆车自动成为默认车");
  });

  it("**占位 VIN 过不了真实 VIN 校验**——它永远不会被当成真 VIN", async () => {
    const { store } = memStore();
    const r = await call(appWith(store, "demo-user"), "POST", "/v1/vehicles", CREATE_BODY);
    const vin = (r.body.vehicle as VehicleProfile).vin;
    const { isValidVin } = await import("@carlife/memory");
    assert.equal(isValidVin(vin), false);
  });

  it("非法 VIN 拒绝", async () => {
    const { store } = memStore();
    const r = await call(appWith(store, "demo-user"), "POST", "/v1/vehicles", {
      ...CREATE_BODY,
      vin: "INVALID",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_vin");
  });

  it("别人的 VIN → 409，不泄露对方车辆信息", async () => {
    const { store } = memStore([makeProfile({ ownerId: "别人" })]);
    const r = await call(appWith(store, "demo-user"), "POST", "/v1/vehicles", {
      ...CREATE_BODY,
      vin: VIN,
    });
    assert.equal(r.status, 409);
    assert.equal(Object.keys(r.body).length, 1, "响应体只有 error，没有对方档案字段");
  });

  it("编辑路径里程不能倒退——upsert 不是改小里程的后门", async () => {
    const { store } = memStore([makeProfile({ odometerKm: 20_000 })]);
    const r = await call(appWith(store, "demo-user"), "POST", "/v1/vehicles", {
      ...CREATE_BODY,
      vin: VIN,
      odometerKm: 100,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "odometer_backwards");
  });

  it("未来的购车时间拒绝；非法 energyType 拒绝而不是吞成未知", async () => {
    const { store } = memStore();
    const app = appWith(store, "demo-user");
    const future = await call(app, "POST", "/v1/vehicles", {
      ...CREATE_BODY,
      purchasedAt: Date.now() + 86_400_000,
    });
    assert.equal(future.status, 400);
    const badEnergy = await call(app, "POST", "/v1/vehicles", { ...CREATE_BODY, energyType: "电动" });
    assert.equal(badEnergy.status, 400);
  });
});

describe("POST /v1/vehicles/:vin/{default,odometer}", () => {
  it("设默认：归属校验由仓储抛错 → 404", async () => {
    const { store } = memStore([makeProfile({ ownerId: "别人" })]);
    const r = await call(appWith(store, "demo-user"), "POST", `/v1/vehicles/${VIN}/default`);
    assert.equal(r.status, 404);
  });

  it("里程上报：跨用户 404；正常前进生效", async () => {
    const mine = memStore([makeProfile()]);
    const app = appWith(mine.store, "demo-user");
    const ok = await call(app, "POST", `/v1/vehicles/${VIN}/odometer`, { odometerKm: 15_000 });
    assert.equal(ok.status, 200);
    assert.equal((ok.body.vehicle as VehicleProfile).odometerKm, 15_000);

    const theirs = memStore([makeProfile({ ownerId: "别人" })]);
    const denied = await call(appWith(theirs.store, "demo-user"), "POST", `/v1/vehicles/${VIN}/odometer`, {
      odometerKm: 15_000,
    });
    assert.equal(denied.status, 404);
  });
});
