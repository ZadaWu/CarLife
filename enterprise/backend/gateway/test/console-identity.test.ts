/**
 * 用户体系后台路由（施工单 M68-01 只读 / M68-02 治理动作）。仓储与会话都是替身——这里验的是
 * 角色门、参数收口（limit 夹取 / 非法 type）、404 形态、**响应里没有 passwordHash**，
 * 以及写端点的三件事：ops 403 且落 denied 审计、幂等 200 不二次调仓储、owner 409。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express from "express";

import type { IdentityConsoleRepository, ResolvedRole } from "@carlife/db";

import { consoleAudit } from "../src/console/audit";
import { createIdentityConsoleRouter, reasonOf } from "../src/console/identity";

type Calls = {
  userPage: Array<{ q?: string; limit: number; cursor?: string }>;
  devicePage: unknown[];
  deviceRevoke: string[];
  grantRevoke: Array<[string, string]>;
  audit: Array<{ actor: string; action: string; result: string; target?: string | null; detail?: Record<string, unknown> | null }>;
};

function newCalls(): Calls {
  return { userPage: [], devicePage: [], deviceRevoke: [], grantRevoke: [], audit: [] };
}

const DEV_ACTIVE = { id: "d-active", userId: "u1", deviceType: "mobile" as const, modelName: "iPhone", registeredAt: new Date(), lastActiveAt: new Date() };
const DEV_COCKPIT = { ...DEV_ACTIVE, id: "d-cockpit", deviceType: "cockpit" as const, vehicleVin: "V1" };
const DEV_REVOKED = { ...DEV_ACTIVE, id: "d-revoked", revokedAt: new Date("2026-09-01") };

function identityStub(calls: Calls): IdentityConsoleRepository {
  const user = { id: "u1", username: "demo", displayName: "演示", createdAt: new Date("2026-09-01") };
  return {
    async overview() {
      return { users: 1, vehicles: 1, activeGrants: { driver: 1, passenger: 0 }, devices: { mobile: 1, pad: 0, cockpit: 1 }, revokedDevices: 0, vehiclesWithCockpit: 1 };
    },
    async userPage(q) {
      calls.userPage.push(q);
      return { rows: [{ ...user, ownedVehicles: 1, activeGrants: 0, activeDevices: 1, lastActiveAt: null }], hasMore: false, nextCursor: null };
    },
    async userDetail(id) {
      if (id !== "u1") return null;
      return { user, ownedVehicles: [], grants: [], devices: [] };
    },
    async vehiclePage() {
      return { rows: [], hasMore: false, nextCursor: null };
    },
    async vehicleDetail(vin) {
      if (vin !== "V1") return null;
      return {
        vehicle: { vin, model: "M", modelYear: 2025, energyType: null, isDefault: true, createdAt: new Date(), owner: user, activeGrants: 0, cockpits: 0, odometerKm: 1, purchasedAt: new Date() },
        owner: user,
        grants: [],
        cockpits: [],
        shadowMemberCount: 2,
      };
    },
    async devicePage(q) {
      calls.devicePage.push(q);
      return { rows: [], hasMore: false, nextCursor: null };
    },
    async deviceById(id) {
      return [DEV_ACTIVE, DEV_COCKPIT, DEV_REVOKED].find((d) => d.id === id) ?? null;
    },
    async grantState(userId, vin) {
      if (vin !== "V1") return "missing";
      return userId === "u-revoked" ? "revoked" : userId === "u-driver" ? "active" : "missing";
    },
  };
}

/** roleFor 的答案表：u-owner 是车主、u-driver 生效、u-revoked 已撤销（回 null）、其余非成员。 */
const ROLES: Record<string, ResolvedRole> = { "u-owner": "owner", "u-driver": "driver" };

function appWith(role: "admin" | "ops" | null, calls: Calls, opts: { actions?: boolean } = { actions: true }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role) (req as express.Request & { console?: unknown }).console = { subject: `${role}-1`, role };
    next();
  });
  // 真的审计中间件 + 假的审计仓储：断言 denied / ok 与 detail 都是它写出来的
  app.use(
    consoleAudit({
      async record(entry) {
        calls.audit.push(entry as Calls["audit"][number]);
        return "aud-x";
      },
    } as never),
  );
  app.use(
    createIdentityConsoleRouter({
      identity: identityStub(calls),
      chat: {
        async consoleSessionPage(q) {
          return { sessions: [{ sessionId: `s-${q.userId}`, userId: q.userId ?? null, title: null, createdAt: "", updatedAt: "", messageCount: 0, turnCount: 0, firstMessageAt: null, lastMessageAt: null }], hasMore: false, nextCursor: null };
        },
      },
      ...(opts.actions
        ? {
            devices: {
              async revoke(id: string) {
                calls.deviceRevoke.push(id);
                return true;
              },
            },
            grants: {
              async roleFor(userId: string, vin: string) {
                return vin === "V1" ? (ROLES[userId] ?? null) : null;
              },
              async revoke(userId: string, vin: string) {
                calls.grantRevoke.push([userId, vin]);
                return true;
              },
            },
          }
        : {}),
    }),
  );
  return app;
}

async function post(app: express.Express, path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    // 审计写在 res.on("finish")，比响应晚一拍
    await new Promise((resolve) => setTimeout(resolve, 10));
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* 没挂路由时是 express 的 HTML 404 */
    }
    return { status: r.status, body: parsed };
  } finally {
    server.close();
  }
}

async function get(app: express.Express, path: string) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await r.text();
    return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const READS = [
  "/console/identity/overview",
  "/console/identity/users",
  "/console/identity/users/u1",
  "/console/identity/vehicles",
  "/console/identity/vehicles/V1",
  "/console/identity/devices",
];

describe("角色门：六条 GET 无身份 401、ops 与 admin 都 200", () => {
  for (const path of READS) {
    it(path, async () => {
      const calls = newCalls();
      assert.equal((await get(appWith(null, calls), path)).status, 401);
      assert.equal((await get(appWith("ops", calls), path)).status, 200);
      assert.equal((await get(appWith("admin", calls), path)).status, 200);
    });
  }
});

describe("响应形态", () => {
  it("users / users/:id 的 JSON 全文不含 passwordHash；详情带 recentSessions", async () => {
    const calls = newCalls();
    const app = appWith("ops", calls);
    const list = await get(app, "/console/identity/users?q=de");
    assert.equal(list.text.includes("passwordHash"), false);
    const detail = await get(app, "/console/identity/users/u1");
    assert.equal(detail.text.includes("passwordHash"), false);
    assert.deepEqual((detail.body.recentSessions as Array<{ sessionId: string }>).map((s) => s.sessionId), ["s-u1"]);
  });

  it("不存在的账号 / 车辆 → 404 not_found", async () => {
    const calls = newCalls();
    const app = appWith("ops", calls);
    assert.deepEqual((await get(app, "/console/identity/users/nobody")).body, { error: "not_found" });
    assert.deepEqual((await get(app, "/console/identity/vehicles/NOPE")).body, { error: "not_found" });
  });

  it("limit 缺省 50、上限 200；q 去空、空白当没传", async () => {
    const calls = newCalls();
    const app = appWith("ops", calls);
    await get(app, "/console/identity/users");
    await get(app, "/console/identity/users?limit=999&q=%20%20");
    await get(app, "/console/identity/users?limit=7&q=%20abc%20");
    assert.equal(calls.userPage[0]!.limit, 50);
    assert.equal(calls.userPage[0]!.q, undefined);
    assert.equal(calls.userPage[1]!.limit, 200);
    assert.equal(calls.userPage[1]!.q, undefined);
    assert.equal(calls.userPage[2]!.limit, 7);
    assert.equal(calls.userPage[2]!.q, "abc");
  });

  it("devices：type 非法 400、status 非法 400、缺省 status=active", async () => {
    const calls = newCalls();
    const app = appWith("ops", calls);
    assert.deepEqual((await get(app, "/console/identity/devices?type=tv")).body, { error: "invalid_type" });
    assert.deepEqual((await get(app, "/console/identity/devices?status=dead")).body, { error: "invalid_status" });
    await get(app, "/console/identity/devices?type=cockpit&vin=V1");
    assert.deepEqual(calls.devicePage[0], { type: "cockpit", status: "active", userId: undefined, vin: "V1", limit: 50, cursor: undefined });
  });

  it("车辆详情只有影子档案计数，没有称呼", async () => {
    const calls = newCalls();
    const d = await get(appWith("ops", calls), "/console/identity/vehicles/V1");
    assert.equal(d.body.shadowMemberCount, 2);
    assert.equal(Object.hasOwn(d.body, "members"), false);
  });
});

describe("[F-30-09] 治理动作：admin 独有、全部经审计", () => {
  const REVOKE_DEV = "/console/identity/devices/d-active/revoke";
  const REVOKE_GRANT = "/console/identity/vehicles/V1/grants/u-driver/revoke";

  it("ops 调两条 POST → 403，审计记 denied 且动作名正确；仓储一次都没被调", async () => {
    const calls = newCalls();
    const app = appWith("ops", calls);
    assert.equal((await post(app, REVOKE_DEV, { reason: "x" })).status, 403);
    assert.equal((await post(app, REVOKE_GRANT)).status, 403);
    assert.deepEqual(
      calls.audit.map((a) => [a.action, a.result, a.actor]),
      [["device.revoke", "denied", "ops-1"], ["grant.revoke", "denied", "ops-1"]],
    );
    assert.equal(calls.deviceRevoke.length + calls.grantRevoke.length, 0);
  });

  it("无身份 → 401 且审计 actor 是 anonymous", async () => {
    const calls = newCalls();
    assert.equal((await post(appWith(null, calls), REVOKE_DEV)).status, 401);
    assert.equal(calls.audit[0]?.actor, "anonymous");
  });

  it("[F-07-11] admin 撤销私人设备 → 200 personal；再撤一次 → alreadyRevoked 且仓储不再被调", async () => {
    const calls = newCalls();
    const app = appWith("admin", calls);
    const first = await post(app, REVOKE_DEV, { reason: "  手机丢了  " });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true, kind: "personal", alreadyRevoked: false });
    assert.deepEqual(calls.deviceRevoke, ["d-active"]);
    const a = calls.audit[0]!;
    assert.equal(a.action, "device.revoke");
    assert.equal(a.result, "ok");
    assert.equal(a.target, "d-active");
    // 审计中间件把 method / status 并进 detail（M3-01），路由填的那几项要原样在里面
    assert.deepEqual(a.detail, { method: "POST", status: 200, deviceType: "mobile", vehicleVin: null, userId: "u1", reason: "手机丢了", alreadyRevoked: false });

    const again = await post(app, "/console/identity/devices/d-revoked/revoke");
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyRevoked, true);
    assert.deepEqual(calls.deviceRevoke, ["d-active"], "已撤销的不再调仓储");
    assert.equal(calls.audit[1]?.detail?.alreadyRevoked, true);
  });

  it("撤销车机 → kind cockpit 带 vehicleVin（界面据此说“解绑”）", async () => {
    const calls = newCalls();
    const r = await post(appWith("admin", calls), "/console/identity/devices/d-cockpit/revoke");
    assert.deepEqual(r.body, { ok: true, kind: "cockpit", vehicleVin: "V1", alreadyRevoked: false });
  });

  it("不存在的设备 → 404；reason 超长 → 400 reason_too_long；reason 非字符串 → 400", async () => {
    const calls = newCalls();
    const app = appWith("admin", calls);
    assert.equal((await post(app, "/console/identity/devices/nope/revoke")).status, 404);
    const long = await post(app, REVOKE_DEV, { reason: "x".repeat(201) });
    assert.equal(long.status, 400);
    assert.equal(long.body.error, "reason_too_long");
    assert.equal((await post(app, REVOKE_DEV, { reason: 42 })).body.error, "invalid_reason");
    assert.equal(calls.deviceRevoke.length, 0);
  });

  it("撤销 driver 授权 → 200 role=driver，审计 target=vin；owner → 409；从未授权 → 404；已撤销 → 幂等 200", async () => {
    const calls = newCalls();
    const app = appWith("admin", calls);
    const ok = await post(app, REVOKE_GRANT, { reason: "车主来电" });
    assert.deepEqual(ok.body, { ok: true, role: "driver", alreadyRevoked: false });
    assert.deepEqual(calls.grantRevoke, [["u-driver", "V1"]]);
    assert.equal(calls.audit[0]?.target, "V1");
    assert.deepEqual(calls.audit[0]?.detail, { method: "POST", status: 200, userId: "u-driver", role: "driver", reason: "车主来电", alreadyRevoked: false });

    const owner = await post(app, "/console/identity/vehicles/V1/grants/u-owner/revoke");
    assert.equal(owner.status, 409);
    assert.equal(owner.body.error, "owner_cannot_be_revoked");
    assert.equal(calls.audit[1]?.result, "error", "409 也留痕");

    assert.equal((await post(app, "/console/identity/vehicles/V1/grants/u-nobody/revoke")).status, 404);
    const revoked = await post(app, "/console/identity/vehicles/V1/grants/u-revoked/revoke");
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.alreadyRevoked, true);
    assert.deepEqual(calls.grantRevoke, [["u-driver", "V1"]], "已撤销 / 404 / 409 都不调仓储");
  });

  it("不注入 devices/grants 时两条 POST 不挂（404，不是 403）", async () => {
    const calls = newCalls();
    const r = await post(appWith("admin", calls, { actions: false }), REVOKE_DEV);
    assert.equal(r.status, 404);
  });

  it("reasonOf：空 / 空白当没传，去首尾空格，200 字是边界", () => {
    assert.deepEqual(reasonOf({}), {});
    assert.deepEqual(reasonOf({ reason: "   " }), {});
    assert.deepEqual(reasonOf({ reason: " a " }), { reason: "a" });
    assert.deepEqual(reasonOf({ reason: "x".repeat(200) }), { reason: "x".repeat(200) });
    assert.deepEqual(reasonOf({ reason: "x".repeat(201) }), { error: "reason_too_long" });
    assert.deepEqual(reasonOf(null), {});
  });
});
