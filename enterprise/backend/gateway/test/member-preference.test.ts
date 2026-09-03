/**
 * 偏好写入与组合 CRUD 端点（施工单 M24-09，F-50-12）。
 *
 * 盯三条：**校验同源**（shared 的 validateCabinPreference / validateCombination，
 * 网关零第二份规则）、**单人组合 400**、**偏好写入保留其它字段**。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { CombinationStore, MemberStore, TripStore, VehicleMember, VehicleProfile, VehicleStore } from "@carlife/memory";
import { validateCombination } from "@carlife/memory";
import type { MemberCombination } from "@carlife/shared";

import { createVehicleMemberRouter } from "../src/http/vehicle-member";

const VIN = "LSJA24U91NS772409";
const OWNER = "demo-user";

function vehicles(): VehicleStore {
  const car: VehicleProfile = { vin: VIN, ownerId: OWNER, model: "测试车", modelYear: 2024, purchasedAt: 0, odometerKm: 1, maintenance: [], repairs: [], updatedAt: 0 };
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

function memberStore(): MemberStore & { rows: VehicleMember[] } {
  const rows: VehicleMember[] = [
    { id: "m-1", vin: VIN, ownerId: OWNER, displayName: "妈妈", relation: "母亲", roles: ["passenger"], ageBand: "senior", needs: ["motion_sickness"], phone: "13800138000", updatedAt: 0 },
    { id: "m-2", vin: VIN, ownerId: OWNER, displayName: "小宝", roles: ["passenger"], ageBand: "child", needs: [], updatedAt: 0 },
  ];
  return {
    rows,
    async listByVehicle(ownerId, vin) { return rows.filter((m) => m.ownerId === ownerId && m.vin === vin); },
    async listByOwner(ownerId) { return rows.filter((m) => m.ownerId === ownerId); },
    async get(ownerId, id) { return rows.find((m) => m.ownerId === ownerId && m.id === id) ?? null; },
    async upsert(m) {
      const i = rows.findIndex((r) => r.id === m.id);
      const row = { ...(rows[i] ?? {}), ...m, id: m.id ?? "m-x", updatedAt: 1 } as VehicleMember;
      if (i >= 0) rows[i] = row; else rows.push(row);
      return row;
    },
    async remove() { return null; },
  };
}

function comboStore(): CombinationStore {
  const rows: MemberCombination[] = [];
  return {
    async listByVehicle(ownerId, vin) { return rows.filter((c) => c.ownerId === ownerId && c.vin === vin); },
    async findByMembers() { return null; },
    async upsert(input) {
      const { memberIds } = validateCombination(input);
      const row: MemberCombination = { id: `c-${rows.length + 1}`, vin: input.vin, ownerId: input.ownerId, label: input.label, memberIds, override: input.override, updatedAt: 1 };
      rows.push(row);
      return row;
    },
    async remove(_o, id) { const i = rows.findIndex((r) => r.id === id); if (i < 0) return null; rows.splice(i, 1); return id; },
    async invalidateContaining() { return []; },
  };
}

const NOOP_TRIPS = { async clearMemberAttribution() { return 0; } } as unknown as TripStore;

function serve(members: MemberStore, combinations?: CombinationStore) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = OWNER;
    next();
  });
  app.use(createVehicleMemberRouter({ members, vehicles: vehicles(), trips: NOOP_TRIPS, combinations }));
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { call, close: () => server.close() };
}

describe("PUT 偏好", () => {
  it("合法偏好写入并保留其它字段（phone/needs 不动）", async () => {
    const ms = memberStore();
    const h = serve(ms);
    const r = await h.call("PUT", `/v1/vehicles/${VIN}/members/m-1/cabin-preference`, { preference: { tempMaxC: 24, seatVentilation: 2 } });
    h.close();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.member.cabinPreference, { tempMaxC: 24, seatVentilation: 2 });
    const row = ms.rows.find((x) => x.id === "m-1")!;
    assert.equal(row.phone, "13800138000", "读-改-写保留手机号");
    assert.deepEqual(row.needs, ["motion_sickness"], "needs 与偏好分离");
  });

  it("未知字段 400（season 进不来——校验同源 shared）", async () => {
    const h = serve(memberStore());
    const r = await h.call("PUT", `/v1/vehicles/${VIN}/members/m-1/cabin-preference`, { preference: { season: "winter" } });
    h.close();
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "season");
  });
});

describe("组合 CRUD", () => {
  it("建组合 → 列表可见；单人组合 400", async () => {
    const h = serve(memberStore(), comboStore());
    const created = await h.call("POST", `/v1/vehicles/${VIN}/combinations`, { label: "孩子和妈妈", memberIds: ["m-1", "m-2"], override: { mediaContentTag: "儿歌" } });
    assert.equal(created.status, 200);
    const list = await h.call("GET", `/v1/vehicles/${VIN}/combinations`);
    assert.equal(list.body.combinations.length, 1);
    const single = await h.call("POST", `/v1/vehicles/${VIN}/combinations`, { label: "一个人", memberIds: ["m-1"], override: {} });
    h.close();
    assert.equal(single.status, 400);
    assert.match(single.body.detail, /至少要两个人/);
  });

  it("删除幂等：删不到也 200 {removed:false}", async () => {
    const h = serve(memberStore(), comboStore());
    const r = await h.call("DELETE", `/v1/vehicles/${VIN}/combinations/c-404`);
    h.close();
    assert.equal(r.status, 200);
    assert.equal(r.body.removed, false);
  });

  it("未接入组合存储 → 503 unconfigured（不是空列表）", async () => {
    const h = serve(memberStore(), undefined);
    const r = await h.call("GET", `/v1/vehicles/${VIN}/combinations`);
    h.close();
    assert.equal(r.status, 503);
  });
});
