/**
 * 车机绑定端点（施工单 M24-05，F-49-11）。
 *
 * 盯三态可区分：**未绑定 / 离线 / 已绑定**——离线显示成"未绑定"会诱导重绑。
 * 外加：跨用户 404、bind 幂等语义透传（不在网关重实现）、未配置 503。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import { CabinUnboundError, ToolError, type CabinClient } from "@carlife/tools";
import type { VehicleProfile, VehicleStore } from "@carlife/memory";

import { createVehicleCabinRouter } from "../src/http/vehicle-cabin";

const VIN = "LSJA24U91NS882405";
const OWNER = "demo-user";

const CAPS = {
  model: "Model Y", source: "seed" as const,
  climate: { zones: ["driver", "passenger"], tempRangeC: [16, 28] as [number, number], tempStepC: 0.5, fanLevels: 5, hasSync: true },
  seats: { driver: { heatingLevels: 3, ventilationLevels: 3, massageModes: ["off"] } },
  ambientLight: { zones: ["front"], modes: ["static"], brightnessRange: [0, 100] as [number, number] },
  media: { zones: ["cabin"], sources: ["music"], volumeRange: [0, 100] as [number, number] },
  fragrance: { present: false, intensities: [], scents: [] },
  childMode: { zones: ["rearLeft"] },
};

function vehicles(): VehicleStore {
  const car: VehicleProfile = {
    vin: VIN, ownerId: OWNER, model: "Model Y", modelYear: 2024, purchasedAt: 0,
    odometerKm: 1, maintenance: [], repairs: [], updatedAt: 0,
  };
  return {
    async get(vin) { return vin === VIN ? car : null; },
    async listByOwner() { return [car]; },
    async upsert() {},
    async setDefault() { throw new Error("no"); },
    async appendMaintenance() { throw new Error("no"); },
    async appendRepair() { throw new Error("no"); },
    async advanceOdometer() { throw new Error("no"); },
  };
}

const status = (impl: () => Promise<never> | Promise<unknown>): CabinClient => ({
  bind: async () => ({ vehicleId: "VEH-000001", model: "Model Y", capabilities: CAPS, state: {}, updatedAt: "t", rebuilt: false }) as never,
  status: impl as never,
  apply: async () => { throw new Error("no"); },
  changes: async () => ({ changes: [] }),
});

function serve(userId: string | null, cabin?: CabinClient, vehicleVin?: string) {
  const app = express();
  app.use((req, _res, next) => {
    const r = req as express.Request & { userId?: string; vehicleVin?: string };
    r.userId = userId ?? undefined;
    r.vehicleVin = vehicleVin;
    next();
  });
  app.use(createVehicleCabinRouter({ vehicles: vehicles(), cabin }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const call = async (method: string, path: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { call, close: () => server.close() };
}

/*
 * 绑定车机的读法（M54-07 续，2026-09-01 走查"车机卡 unauthorized"）。
 * 车机状态与能量是车辆共享域，energy 的仿真本来就是车机侧概念——
 * 车机自己 401 是走查里那张红字卡的直接原因。owner 门槛的管理动作照旧要人。
 */
describe("绑定车机读 cabin/energy", () => {
  it("车辆 token（绑本车）读 cabin 200", async () => {
    const h = serve(null, status(async () => ({ vehicleId: "VEH-000001", model: "Model Y", capabilities: CAPS, state: {}, updatedAt: "t", rebuilt: false })), VIN);
    const r = await h.call("GET", `/v1/vehicles/${VIN}/cabin`);
    h.close();
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "bound");
  });

  it("绑的是别的车：照旧 401，不因为是车机就放行", async () => {
    const h = serve(null, status(async () => ({}) as never), "LSJA24U91NS999999");
    const r = await h.call("GET", `/v1/vehicles/${VIN}/cabin`);
    h.close();
    assert.equal(r.status, 401);
  });
});

describe("GET /v1/vehicles/:vin/cabin 三态", () => {
  it("已绑定：能力摘要 + simulated + 拉取时间", async () => {
    const h = serve(OWNER, status(async () => ({ vehicleId: "VEH-000001", model: "Model Y", capabilities: CAPS, state: {}, updatedAt: "t", rebuilt: false })));
    const r = await h.call("GET", `/v1/vehicles/${VIN}/cabin`);
    h.close();
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "bound");
    assert.equal(r.body.capabilities.climateZones, 2);
    assert.equal(r.body.provenance, "simulated");
    assert.ok(r.body.fetchedAt);
  });

  it("未绑定 ≠ 离线：CabinUnboundError → unbound", async () => {
    const h = serve(OWNER, status(async () => { throw new CabinUnboundError(VIN); }));
    const r = await h.call("GET", `/v1/vehicles/${VIN}/cabin`);
    h.close();
    assert.equal(r.body.state, "unbound");
  });

  it("离线：upstream → offline 带原因（**不显示成未绑定**）", async () => {
    const h = serve(OWNER, status(async () => { throw new ToolError("cabin", "upstream", "车机没连上", true); }));
    const r = await h.call("GET", `/v1/vehicles/${VIN}/cabin`);
    h.close();
    assert.equal(r.body.state, "offline");
    assert.match(r.body.reason, /离线/);
  });

  it("未配置 MOCK_CABIN_URL → unconfigured（区别于离线）", async () => {
    const h = serve(OWNER, undefined);
    const r = await h.call("GET", `/v1/vehicles/${VIN}/cabin`);
    h.close();
    assert.equal(r.body.state, "unconfigured");
  });

  it("跨用户 404，不泄露存在性", async () => {
    const h = serve("other-user", status(async () => ({}) as never));
    const r = await h.call("GET", `/v1/vehicles/${VIN}/cabin`);
    h.close();
    assert.equal(r.status, 404);
  });
});

describe("POST /v1/vehicles/:vin/cabin/bind", () => {
  it("绑定成功返回 bound 摘要（幂等语义在 CabinClient，网关透传）", async () => {
    const h = serve(OWNER, status(async () => ({}) as never));
    const r = await h.call("POST", `/v1/vehicles/${VIN}/cabin/bind`);
    h.close();
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "bound");
    assert.equal(r.body.cabinVehicleId, "VEH-000001");
  });

  it("车机离线时绑定 502 + 状态仍是 offline", async () => {
    const offline: CabinClient = {
      ...status(async () => ({}) as never),
      bind: async () => { throw new ToolError("cabin", "upstream", "车机没连上", true); },
    };
    const h = serve(OWNER, offline);
    const r = await h.call("POST", `/v1/vehicles/${VIN}/cabin/bind`);
    h.close();
    assert.equal(r.status, 502);
    assert.equal(r.body.state, "offline");
  });
});
