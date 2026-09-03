/**
 * 成员授权端点与角色校验（施工单 M48-03，F-55-03/04/05）。
 *
 * 盯得最紧的四条：
 *  - **撤销下一请求即失效**：不靠名单、不靠 TTL，就是每次查库（设计裁决 R11）。
 *  - **无权限与不存在同一句**：拿 VIN 挨个试问不出"这辆车在不在系统里"（AC-55-7）。
 *  - **成员管理 owner-only**：driver 连列表都改不了（AC-55-5）。
 *  - **名单不含影子档案的称呼**：那是车主给家人起的叫法，属他人 PII（FL-46 F-46-13）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { ResolvedRole } from "@carlife/db";

import { createVehicleRoleMiddleware, hasVehicleAccess } from "../src/auth/vehicle-role";
import type { AuthedRequest } from "../src/auth";
import { createVehicleGrantRouter } from "../src/http/vehicle-grant";

const OWNER = "u-owner";
const DRIVER = "u-driver";
const STRANGER = "u-stranger";
const VIN = "LSJTEST0000000001";

/** 可编排的授权替身：`roles` 决定 roleFor 的答案，调用次数可观测。 */
function grantsOf(roles: Map<string, ResolvedRole>, calls = { n: 0 }) {
  const active = new Map<string, string>(); // userId -> role
  for (const [k, v] of roles) if (v && v !== "owner") active.set(k, v);
  return {
    calls,
    async roleFor(userId: string, vin: string): Promise<ResolvedRole> {
      calls.n += 1;
      return vin === VIN ? (roles.get(userId) ?? null) : null;
    },
    async grant(input: { userId: string; vin: string; role: string }) {
      active.set(input.userId, input.role);
      roles.set(input.userId, input.role as ResolvedRole);
      return {
        id: "g1",
        userId: input.userId,
        vin: input.vin,
        role: input.role as "driver" | "passenger",
        grantedAt: new Date(),
      };
    },
    async revoke(userId: string) {
      const had = active.delete(userId);
      roles.set(userId, null);
      return had;
    },
    async listActiveByVin() {
      return [...active].map(([userId, role]) => ({
        id: `g-${userId}`,
        userId,
        vin: VIN,
        role: role as "driver" | "passenger",
        grantedAt: new Date(),
      }));
    },
    async listActiveByUser() {
      return [];
    },
  };
}

function usersOf(byName: Record<string, string>) {
  return {
    async findByUsername(name: string) {
      const id = byName[name];
      return id
        ? {
            id,
            username: name,
            passwordHash: "!",
            displayName: `显示名-${id}`,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null;
    },
    async publicByIds(ids: readonly string[]) {
      return new Map(
        ids.map((id) => [id, { id, username: `u_${id}`, displayName: `显示名-${id}` }]),
      );
    },
  };
}

function appWith(
  grants: ReturnType<typeof grantsOf>,
  userId: string | null,
  users = usersOf({ driverName: DRIVER }),
  /** 车辆级 token（车机）绑定的 vin；给它就意味着这次请求**没有人**。 */
  vehicleVin?: string,
) {
  const app = express();
  app.use((req, _res, next) => {
    (req as AuthedRequest).userId = userId ?? undefined;
    (req as AuthedRequest).vehicleVin = vehicleVin;
    next();
  });
  app.use(createVehicleRoleMiddleware(grants));
  app.use(
    createVehicleGrantRouter({
      grants: grants as never,
      users,
      ownerOf: async (vin) => (vin === VIN ? OWNER : null),
    }),
  );
  return app;
}

async function call(app: express.Express, path: string, init: RequestInit = {}) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
    const text = await r.text();
    return { status: r.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  } finally {
    server.close();
  }
}

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("[F-55-04] 角色中间件", () => {
  it("按路径解析 vin 并注入角色；非 /v1/vehicles/:vin 路径不查库", async () => {
    const calls = { n: 0 };
    const grants = grantsOf(new Map([[OWNER, "owner"]]), calls);
    const app = express();
    app.use((req, _res, next) => {
      (req as AuthedRequest).userId = OWNER;
      next();
    });
    app.use(createVehicleRoleMiddleware(grants));
    app.get("/v1/vehicles/:vin/probe", (req, res) => {
      res.json({ role: (req as { grantRole?: ResolvedRole }).grantRole ?? null });
    });
    app.get("/v1/sessions", (req, res) => {
      res.json({ role: (req as { grantRole?: ResolvedRole }).grantRole ?? "undefined" });
    });

    const hit = await call(app, `/v1/vehicles/${VIN}/probe`);
    assert.equal(hit.json.role, "owner");
    assert.equal(calls.n, 1);

    const miss = await call(app, "/v1/sessions");
    assert.equal(miss.json.role, "undefined", "不带 vin 的路径不该被解析");
    assert.equal(calls.n, 1, "也不该多查一次库");
  });

  it("**每个请求都查一次库**——撤销的生效机制就是它（R11：不建撤销名单）", async () => {
    const calls = { n: 0 };
    const grants = grantsOf(new Map([[DRIVER, "driver"]]), calls);
    const app = appWith(grants, DRIVER);
    await call(app, `/v1/vehicles/${VIN}/grants`);
    await call(app, `/v1/vehicles/${VIN}/grants`);
    assert.equal(calls.n, 2, "两次请求两次判定，没有缓存");
  });

  it("车辆级 token（无 userId）一律判非成员——车机要先声明谁在用（M48-05）", async () => {
    const grants = grantsOf(new Map([[OWNER, "owner"]]));
    const app = appWith(grants, null);
    const r = await call(app, `/v1/vehicles/${VIN}/grants`);
    assert.equal(r.status, 404);
  });
});

describe("[F-55-04] hasVehicleAccess 的三态", () => {
  const req = (role: ResolvedRole | undefined, userId = DRIVER) =>
    ({ userId, grantRole: role }) as never;

  it("中间件没跑（undefined）时回落到只有车主——忘挂中间件的后果是更严不是更松", () => {
    assert.equal(hasVehicleAccess(req(undefined, OWNER), OWNER, "member"), true);
    assert.equal(hasVehicleAccess(req(undefined, DRIVER), OWNER, "member"), false);
  });

  it("查过且非成员（null）一律拒", () => {
    assert.equal(hasVehicleAccess(req(null), OWNER, "member"), false);
    assert.equal(hasVehicleAccess(req(null), OWNER, "owner"), false);
  });

  it("driver 能读不能写；owner 都能", () => {
    assert.equal(hasVehicleAccess(req("driver"), OWNER, "member"), true);
    assert.equal(hasVehicleAccess(req("driver"), OWNER, "owner"), false);
    assert.equal(hasVehicleAccess(req("owner", OWNER), OWNER, "member"), true);
    assert.equal(hasVehicleAccess(req("owner", OWNER), OWNER, "owner"), true);
  });

  it("passenger 与 driver 在读这一档同权（车辆共享域）", () => {
    assert.equal(hasVehicleAccess(req("passenger"), OWNER, "member"), true);
    assert.equal(hasVehicleAccess(req("passenger"), OWNER, "owner"), false);
  });
});

describe("[F-55-03][AC-55-5] 成员管理 owner-only", () => {
  it("车主可读名单：车主在列且角色为 owner", async () => {
    const grants = grantsOf(
      new Map<string, ResolvedRole>([
        [OWNER, "owner"],
        [DRIVER, "driver"],
      ]),
    );
    const r = await call(appWith(grants, OWNER), `/v1/vehicles/${VIN}/grants`);
    assert.equal(r.status, 200);
    const members = r.json.members as Array<{ userId: string; role: string; displayName: string }>;
    assert.deepEqual(
      members.map((m) => [m.userId, m.role]),
      [
        [OWNER, "owner"],
        [DRIVER, "driver"],
      ],
    );
  });

  it("**名单只有账号自设的 displayName**，不含影子档案的称呼（FL-46 F-46-13）", async () => {
    const grants = grantsOf(
      new Map<string, ResolvedRole>([
        [OWNER, "owner"],
        [DRIVER, "driver"],
      ]),
    );
    const r = await call(appWith(grants, OWNER), `/v1/vehicles/${VIN}/grants`);
    const raw = JSON.stringify(r.json);
    assert.ok(raw.includes("显示名-"), "用的是账号 displayName");
    for (const pii of ["妈", "婆婆", "relation", "ageBand", "needs", "phone"]) {
      assert.ok(!raw.includes(pii), `名单里不该出现影子档案字段：${pii}`);
    }
  });

  it("driver 能看名单（上车声明要用），但不能加人不能删人", async () => {
    const roles = new Map<string, ResolvedRole>([
      [OWNER, "owner"],
      [DRIVER, "driver"],
    ]);
    const app = appWith(grantsOf(roles), DRIVER);
    assert.equal((await call(app, `/v1/vehicles/${VIN}/grants`)).status, 200);
    assert.equal(
      (await call(app, `/v1/vehicles/${VIN}/grants`, jsonPost({ username: "x", role: "driver" })))
        .status,
      404,
      "非车主的管理请求与'车不存在'同一响应",
    );
    assert.equal(
      (await call(app, `/v1/vehicles/${VIN}/grants/${STRANGER}`, { method: "DELETE" })).status,
      404,
    );
  });

  it("非成员连名单都看不到，且与'车不存在'不可区分（AC-55-7）", async () => {
    const grants = grantsOf(new Map<string, ResolvedRole>([[OWNER, "owner"]]));
    const app = appWith(grants, STRANGER);
    const denied = await call(app, `/v1/vehicles/${VIN}/grants`);
    const absent = await call(app, `/v1/vehicles/LSJNOSUCHVIN00000/grants`);
    assert.equal(denied.status, absent.status);
    assert.deepEqual(denied.json, absent.json);
    assert.deepEqual(denied.json, { error: "vehicle_not_found" });
  });
});

describe("[F-55-03][AC-55-2] 添加与移除", () => {
  it("车主按 username 添加 driver", async () => {
    const grants = grantsOf(new Map<string, ResolvedRole>([[OWNER, "owner"]]));
    const r = await call(
      appWith(grants, OWNER),
      `/v1/vehicles/${VIN}/grants`,
      jsonPost({ username: "driverName", role: "driver" }),
    );
    assert.equal(r.status, 201);
    assert.equal(r.json.userId, DRIVER);
  });

  it("**owner 不在可授予集合里**——所有权是 vehicles.owner_id 的事（R1）", async () => {
    const grants = grantsOf(new Map<string, ResolvedRole>([[OWNER, "owner"]]));
    const r = await call(
      appWith(grants, OWNER),
      `/v1/vehicles/${VIN}/grants`,
      jsonPost({ username: "driverName", role: "owner" }),
    );
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "invalid_role");
  });

  it("账号不存在与已是成员**返回同一句**——否则车主就有了一个账号探测接口", async () => {
    const grants = grantsOf(new Map<string, ResolvedRole>([[OWNER, "owner"]]));
    const app = appWith(grants, OWNER);
    const nobody = await call(
      app,
      `/v1/vehicles/${VIN}/grants`,
      jsonPost({ username: "nobody", role: "driver" }),
    );
    assert.equal(nobody.status, 409);
    assert.deepEqual(nobody.json, { error: "grant_failed" });
  });

  it("移除是幂等的：移除一个本来就不在的人不是错误", async () => {
    const grants = grantsOf(new Map<string, ResolvedRole>([[OWNER, "owner"]]));
    const r = await call(appWith(grants, OWNER), `/v1/vehicles/${VIN}/grants/${STRANGER}`, {
      method: "DELETE",
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.removed, false);
  });

  it("**移除后下一次请求即失效**（AC-55-4）：同一个 app，前一次 200 后一次 404", async () => {
    const roles = new Map<string, ResolvedRole>([
      [OWNER, "owner"],
      [DRIVER, "driver"],
    ]);
    const grants = grantsOf(roles);
    const asDriver = appWith(grants, DRIVER);
    assert.equal((await call(asDriver, `/v1/vehicles/${VIN}/grants`)).status, 200);

    // 车主移除他
    const asOwner = appWith(grants, OWNER);
    const removed = await call(asOwner, `/v1/vehicles/${VIN}/grants/${DRIVER}`, {
      method: "DELETE",
    });
    assert.equal(removed.json.removed, true);

    // 他的下一次请求——不需要等任何 TTL
    assert.equal((await call(asDriver, `/v1/vehicles/${VIN}/grants`)).status, 404);
  });
});

describe("[F-56-05][AC-56-5] 绑定的车机能读自己这辆车的成员名单（M52-01）", () => {
  /*
   * 车机拿到车辆级凭证后要做的第一件事就是列成员让人点选（M48-05 的上车声明）。
   * 而 `resolveVehicleRole` 对没有 userId 的请求一律判非成员——那条规则本身是对的
   * （R4：车机不代表任何人），但它把声明流程自己的前置也挡掉了：绑定成功后
   * 车机读名单吃 404，声明屏永远进不去。2026-08-31 走查 W8 撞上，本组用例钉住修法。
   */
  const roles = new Map<string, ResolvedRole>([
    [OWNER, "owner"],
    [DRIVER, "driver"],
  ]);

  it("绑到这辆车的车机 → 200，且名单含车主与 driver", async () => {
    const app = appWith(grantsOf(roles), null, undefined, VIN);
    const r = await call(app, `/v1/vehicles/${VIN}/grants`);
    assert.equal(r.status, 200);
    const members = r.json.members as Array<{ userId: string; role: string }>;
    assert.ok(members.some((m) => m.userId === OWNER && m.role === "owner"));
    assert.ok(members.some((m) => m.userId === DRIVER && m.role === "driver"));
  });

  it("**绑到别的车**的车机读这辆车 → 404（放行只限自己绑的那辆）", async () => {
    const app = appWith(grantsOf(roles), null, undefined, "LSJOTHERCAR000001");
    assert.equal((await call(app, `/v1/vehicles/${VIN}/grants`)).status, 404);
  });

  it("**没有 vehicleVin 也没有 userId** → 404（不是「没人就放行」）", async () => {
    const app = appWith(grantsOf(roles), null);
    assert.equal((await call(app, `/v1/vehicles/${VIN}/grants`)).status, 404);
  });

  it("车机**不能加成员**——读名单不等于成了车主", async () => {
    const app = appWith(grantsOf(roles), null, undefined, VIN);
    const r = await call(app, `/v1/vehicles/${VIN}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "someone", role: "driver" }),
    });
    assert.ok(r.status >= 400, `期望被拒，实际 ${r.status}`);
  });

  it("车机**不能移除成员**", async () => {
    const app = appWith(grantsOf(roles), null, undefined, VIN);
    const r = await call(app, `/v1/vehicles/${VIN}/grants/${DRIVER}`, { method: "DELETE" });
    assert.ok(r.status >= 400, `期望被拒，实际 ${r.status}`);
  });
});
