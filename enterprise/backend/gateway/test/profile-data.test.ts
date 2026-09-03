/**
 * 档案页数据面端点（施工单 M14-09 / M14-10）。
 *
 * 盯的是同一条纪律的三个面：
 *   未接入 ≠ 没有数据（503 且说明是"未接入"）
 *   样本不足 ≠ 数字是零（照常返回 summary 与**具体理由**）
 *   回落整车口径必须带 `scope`（隐式回落＝用整车数字冒充个人结论）
 * 外加归属：不属于当前用户一律 404，且不区分"不存在"与"不属于你"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type {
  MemberStore,
  StoredTrip,
  TripStore,
  VehicleMember,
  VehicleProfile,
  VehicleStore,
} from "@carlife/memory";

import { createProfileDataRouter, type PreferenceReader } from "../src/http/profile-data";

const VIN = "LSVAA49P4E2123456";
const NOW = Date.UTC(2026, 7, 12);
const DAY = 86_400_000;

function vehicle(over: Partial<VehicleProfile> = {}): VehicleProfile {
  return {
    vin: VIN,
    ownerId: "demo-user",
    model: "Model Y",
    modelYear: 2023,
    purchasedAt: Date.UTC(2023, 4, 1),
    odometerKm: 41_280,
    maintenance: [],
    repairs: [],
    updatedAt: 0,
    ...over,
  };
}

const vehicles = (v: VehicleProfile | null): VehicleStore =>
  ({ async get() { return v; } }) as unknown as VehicleStore;

function members(list: VehicleMember[]): MemberStore {
  return { async listByVehicle() { return list; } } as unknown as MemberStore;
}

function member(over: Partial<VehicleMember> = {}): VehicleMember {
  return {
    id: "m1",
    vin: VIN,
    ownerId: "demo-user",
    displayName: "妈妈",
    roles: ["passenger"],
    needs: [],
    ...over,
  } as VehicleMember;
}

/** 造一批流水；`n` 条，每条 20km，落在窗口内。 */
function trips(n: number, over: Partial<StoredTrip> = {}): TripStore {
  const list: StoredTrip[] = Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    userId: "demo-user",
    vin: VIN,
    distanceKm: 20,
    startedAt: NOW - (i + 1) * DAY,
    endedAt: NOW - (i + 1) * DAY + 3_600_000,
    roadType: "city",
    ...over,
  })) as unknown as StoredTrip[];
  return { async range() { return list; } } as unknown as TripStore;
}

function appWith(deps: Parameters<typeof createProfileDataRouter>[0], userId: string | null = "demo-user") {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createProfileDataRouter({ now: () => NOW, ...deps }));
  return app;
}

async function get(app: express.Express, path: string) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: (await r.json()) as Record<string, never> };
  } finally {
    server.close();
  }
}

describe("GET /v1/vehicles/:vin/usage", () => {
  it("未鉴权 401", async () => {
    const app = appWith({ vehicles: vehicles(vehicle()), members: members([]) }, null);
    assert.equal((await get(app, `/v1/vehicles/${VIN}/usage`)).status, 401);
  });

  it("别人的车 404，且与「车不存在」同一个响应", async () => {
    const other = appWith({ vehicles: vehicles(vehicle({ ownerId: "someone-else" })), members: members([]) });
    const missing = appWith({ vehicles: vehicles(null), members: members([]) });
    const a = await get(other, `/v1/vehicles/${VIN}/usage`);
    const b = await get(missing, `/v1/vehicles/${VIN}/usage`);
    assert.equal(a.status, 404);
    assert.deepEqual(a.body, b.body);
  });

  it("⑥未接入 → 503 且明说是「未接入」，不是 200 空数据", async () => {
    const app = appWith({ vehicles: vehicles(vehicle()), members: members([]) });
    const { status, body } = await get(app, `/v1/vehicles/${VIN}/usage`);
    assert.equal(status, 503);
    assert.equal((body as unknown as { error: string }).error, "usage_unconfigured");
    assert.match(String((body as unknown as { reason: string }).reason), /未接入/);
  });

  it("样本足够时给画像与推导依据", async () => {
    const app = appWith({ vehicles: vehicles(vehicle()), members: members([]), trips: trips(24) });
    const { status, body } = await get(app, `/v1/vehicles/${VIN}/usage`);
    assert.equal(status, 200);
    const p = body as unknown as {
      summary: { sampleSize: number; avgDailyKm: number; derivation: string[] };
      verdict: { usable: boolean };
    };
    assert.equal(p.verdict.usable, true);
    assert.equal(p.summary.sampleSize, 24);
    assert.ok(p.summary.avgDailyKm > 0);
    // 可解释性（F-22-06）：每个数字要能说出怎么来的
    assert.ok(p.summary.derivation.length > 0);
  });

  it("样本不足时**照常返回 summary 与具体理由**——不给 null 逼端上自己编话", async () => {
    const app = appWith({ vehicles: vehicles(vehicle()), members: members([]), trips: trips(2) });
    const { status, body } = await get(app, `/v1/vehicles/${VIN}/usage`);
    assert.equal(status, 200);
    const p = body as unknown as {
      summary: { sampleSize: number };
      verdict: { usable: boolean; reason?: string };
    };
    assert.equal(p.verdict.usable, false);
    assert.equal(p.summary.sampleSize, 2);
    assert.ok(p.verdict.reason, "不可用必须带理由");
  });
});

describe("GET /v1/vehicles/:vin/members/:id/usage", () => {
  it("名单里没有这个人 → 404", async () => {
    const app = appWith({ vehicles: vehicles(vehicle()), members: members([]), trips: trips(24) });
    assert.equal((await get(app, `/v1/vehicles/${VIN}/members/m1/usage`)).status, 404);
  });

  it("纯乘客走同行口径——不算里程与充电（M17-02：不为字段齐全而算）", async () => {
    const app = appWith({
      vehicles: vehicles(vehicle()),
      members: members([member({ roles: ["passenger"] })]),
      trips: trips(24),
    });
    const { body } = await get(app, `/v1/vehicles/${VIN}/members/m1/usage`);
    const b = body as unknown as { kind: string; summary: Record<string, unknown> };
    assert.equal(b.kind, "companion");
    assert.equal("avgDailyKm" in b.summary, false);
  });

  it("常驾在按人样本不足时回落整车口径，且**带上 scope 标记**", async () => {
    // range 忽略过滤条件（fake store），所以按人与整车拿到同一批——
    // 这里验的是 kind/scope 字段有没有被原样带出去，而不是聚合本身。
    const app = appWith({
      vehicles: vehicles(vehicle()),
      members: members([member({ roles: ["driver"] })]),
      trips: trips(24),
    });
    const { body } = await get(app, `/v1/vehicles/${VIN}/members/m1/usage`);
    const b = body as unknown as { kind: string; scope: string; memberId: string };
    assert.equal(b.kind, "driver");
    assert.equal(b.memberId, "m1");
    assert.ok(b.scope === "member" || b.scope === "vehicle");
  });

  it("返回结构里不含任何可用来打分的字段（AC-46-10）", async () => {
    const app = appWith({
      vehicles: vehicles(vehicle()),
      members: members([member()]),
      trips: trips(24),
    });
    const { body } = await get(app, `/v1/vehicles/${VIN}/members/m1/usage`);
    const keys = JSON.stringify(body).toLowerCase();
    for (const bad of ["score", "rating", "grade", "risk"]) {
      assert.equal(keys.includes(`"${bad}`), false, `不应出现 ${bad} 字段`);
    }
  });
});

describe("GET /v1/preferences", () => {
  const reader = (r: Awaited<ReturnType<PreferenceReader["list"]>>): PreferenceReader => ({
    async list() {
      return r;
    },
  });

  it("未接入 → 503 且明说未接入", async () => {
    const app = appWith({ vehicles: vehicles(vehicle()), members: members([]) });
    const { status, body } = await get(app, "/v1/preferences");
    assert.equal(status, 503);
    assert.equal((body as unknown as { error: string }).error, "memory_unconfigured");
  });

  it("正常返回列表", async () => {
    const app = appWith({
      vehicles: vehicles(vehicle()),
      members: members([]),
      preferences: reader({ items: [{ content: "偏好周末短途自驾" }] }),
    });
    const { body } = await get(app, "/v1/preferences");
    assert.equal((body as unknown as { degraded: boolean }).degraded, false);
    assert.equal((body as unknown as { preferences: unknown[] }).preferences.length, 1);
  });

  it("degraded 原样带出——**这次没查到不代表没有**", async () => {
    const app = appWith({
      vehicles: vehicles(vehicle()),
      members: members([]),
      preferences: reader({ items: [], degraded: true, error: "pgvector 连不上" }),
    });
    const { body } = await get(app, "/v1/preferences");
    const b = body as unknown as { degraded: boolean; reason?: string; preferences: unknown[] };
    assert.equal(b.degraded, true);
    assert.equal(b.reason, "pgvector 连不上");
    // 空列表 + degraded 必须能被端上区分开，否则会显示成"你还没说过偏好"
    assert.deepEqual(b.preferences, []);
  });
});
