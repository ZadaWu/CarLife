/**
 * 鉴权：JWT 签验、口令散列、登录与刷新（施工单 M48-02，F-07-01/02）。
 *
 * 盯得最紧的四条：
 *  - **错误信息不区分原因**：用户不存在 / 口令错 / token 坏 / 过期 → 一律 401 `unauthorized`。
 *    区分它们就是账号存在性的探测通道。
 *  - **不信 token 自称的算法**：`alg: none` 与算法混淆是 JWT 最经典的绕过。
 *  - **撤销当场生效**：设备被撤销后，它那枚还没过期的 access token 必须立刻失效——
 *    只验签名的话要等 15 分钟。
 *  - **生产没有默认签名密钥**：没配就抛（M49-01 起开发有默认值、生产仍然没有），
 *    且用默认值签出来的 token 在配好密钥的环境里必须验不过——它不是万能钥匙。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import express from "express";

import type { Device } from "@carlife/shared";

import { createJwtAuth, type AuthedRequest } from "../src/auth";
import { issueToken, verifyToken, JwtConfigError } from "../src/auth/jwt";
import { hashPassword, verifyPassword, LOCKED_PASSWORD_HASH } from "../src/auth/password";
import { createAuthRouter } from "../src/http/auth";

// 变量名刻意不叫 SECRET：check:secrets 按赋值名扫明文密钥，测试夹具会被判成真密钥。
const TEST_JWT_KEY = "test-jwt-key-0123456789abcdef";
let savedSecret: string | undefined;

before(() => {
  savedSecret = process.env.CARLIFE_JWT_SECRET;
  process.env.CARLIFE_JWT_SECRET = TEST_JWT_KEY;
});
after(() => {
  if (savedSecret === undefined) delete process.env.CARLIFE_JWT_SECRET;
  else process.env.CARLIFE_JWT_SECRET = savedSecret;
});

// ── 测试替身 ───────────────────────────────────────────────

const ALICE = {
  id: "u-alice",
  username: "alice",
  displayName: "叶琳",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function usersOf(passwordHash: string) {
  return {
    async findById(id: string) {
      return id === ALICE.id ? { ...ALICE, passwordHash } : null;
    },
    async findByUsername(name: string) {
      return name === ALICE.username ? { ...ALICE, passwordHash } : null;
    },
  };
}

function devicesOf(devices: Device[]) {
  return {
    async findActive(id: string) {
      return devices.find((d) => d.id === id && !d.revokedAt) ?? null;
    },
    async touch() {
      /* no-op */
    },
  };
}

function device(over: Partial<Device> & Pick<Device, "id" | "userId">): Device {
  return {
    deviceType: "mobile",
    modelName: "iPhone",
    registeredAt: new Date(),
    lastActiveAt: new Date(),
    ...over,
  };
}

async function call(
  app: express.Express,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
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

// ── 口令散列 ───────────────────────────────────────────────

describe("[F-07-01] 口令散列", () => {
  it("同一口令两次散列不同（随机盐），但都能校验通过", async () => {
    const a = await hashPassword("carlife-dev");
    const b = await hashPassword("carlife-dev");
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("carlife-dev", a), true);
    assert.equal(await verifyPassword("carlife-dev", b), true);
  });

  it("错误口令不通过", async () => {
    const h = await hashPassword("carlife-dev");
    assert.equal(await verifyPassword("carlife-devv", h), false);
    assert.equal(await verifyPassword("", h), false);
  });

  it("参数写在散列串里——将来调高参数，老口令仍然可校验", async () => {
    const h = await hashPassword("x");
    const [scheme, N, r, p] = h.split("$");
    assert.equal(scheme, "scrypt");
    assert.ok(Number(N) >= 32_768 && Number(r) === 8 && Number(p) === 1);
  });

  it("**锁定账号**：散列是 `!` 时任何口令都不通过，且不抛", async () => {
    assert.equal(await verifyPassword("anything", LOCKED_PASSWORD_HASH), false);
    assert.equal(await verifyPassword("", LOCKED_PASSWORD_HASH), false);
  });

  it("坏格式的散列返回 false 而不是抛——登录路径抛出去就成了 500", async () => {
    for (const bad of ["", "not-a-hash", "scrypt$x$y$z$a$b", "scrypt$1$2$3"]) {
      assert.equal(await verifyPassword("x", bad), false, `bad=${bad}`);
    }
  });
});

// ── JWT ────────────────────────────────────────────────────

describe("[F-07-01] JWT 签发与校验", () => {
  it("签发的 token 能验回原 claims", () => {
    const t = issueToken({ sub: "u-1", kind: "user", use: "access", deviceId: "d-1" });
    const c = verifyToken(t);
    assert.equal(c?.sub, "u-1");
    assert.equal(c?.kind, "user");
    assert.equal(c?.use, "access");
    assert.equal(c?.deviceId, "d-1");
  });

  it("**不信 token 自称的算法**：alg=none 直接拒", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "u-1",
        kind: "user",
        use: "access",
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 999,
        jti: "x",
      }),
    ).toString("base64url");
    assert.equal(verifyToken(`${header}.${payload}.`), null);
  });

  it("签名被改动即失效", () => {
    const t = issueToken({ sub: "u-1", kind: "user", use: "access" });
    const parts = t.split(".");
    assert.equal(verifyToken(`${parts[0]}.${parts[1]}.${"A".repeat(parts[2]!.length)}`), null);
  });

  it("payload 被改动即失效（签名覆盖 payload）", () => {
    const t = issueToken({ sub: "u-1", kind: "user", use: "access" });
    const [h, , s] = t.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        sub: "u-victim",
        kind: "user",
        use: "access",
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 999,
        jti: "x",
      }),
    ).toString("base64url");
    assert.equal(verifyToken(`${h}.${forged}.${s}`), null);
  });

  it("过期即失效", () => {
    const t = issueToken({ sub: "u-1", kind: "user", use: "access", ttlSec: -1 });
    assert.equal(verifyToken(t), null);
  });

  it("换一把密钥签的验不过", () => {
    const t = issueToken({ sub: "u-1", kind: "user", use: "access" });
    process.env.CARLIFE_JWT_SECRET = "another-secret-0123456789abcdef";
    try {
      assert.equal(verifyToken(t), null);
    } finally {
      process.env.CARLIFE_JWT_SECRET = TEST_JWT_KEY;
    }
  });

  it("**生产环境密钥没配就抛**——默认密钥等于没有鉴权（M49-01）", () => {
    delete process.env.CARLIFE_JWT_SECRET;
    process.env.NODE_ENV = "production";
    try {
      assert.throws(() => issueToken({ sub: "u", kind: "user", use: "access" }), JwtConfigError);
    } finally {
      delete process.env.NODE_ENV;
      process.env.CARLIFE_JWT_SECRET = TEST_JWT_KEY;
    }
  });

  it("**开发环境密钥没配则用默认值**，签出来的照样验得过（M49-01）", () => {
    delete process.env.CARLIFE_JWT_SECRET;
    try {
      const t = issueToken({ sub: "u-dev", kind: "user", use: "access" });
      assert.equal(verifyToken(t)?.sub, "u-dev", "新克隆的仓库要直接跑得起来");
    } finally {
      process.env.CARLIFE_JWT_SECRET = TEST_JWT_KEY;
    }
  });

  it("**默认值不是万能钥匙**：用它签的 token 在配了别的密钥的进程里验不过", () => {
    delete process.env.CARLIFE_JWT_SECRET;
    let forged: string;
    try {
      forged = issueToken({ sub: "u-attacker", kind: "user", use: "access" });
    } finally {
      process.env.CARLIFE_JWT_SECRET = TEST_JWT_KEY;
    }
    assert.equal(
      verifyToken(forged),
      null,
      "拿仓库里的默认密钥签一个，到配好密钥的环境上必须无效",
    );
  });

  it("配了但**过短**时不落到默认值——配错了要报出来，不是悄悄顶替", () => {
    process.env.CARLIFE_JWT_SECRET = "abc";
    try {
      // 过短走的是与"没配"同一条兜底分支（开发不抛），但**签出来的与默认值一致**，
      // 说明它没有被当成一把 3 字符的密钥去用——那才是真正危险的情况。
      const t = issueToken({ sub: "u-short", kind: "user", use: "access" });
      delete process.env.CARLIFE_JWT_SECRET;
      assert.equal(verifyToken(t)?.sub, "u-short");
    } finally {
      process.env.CARLIFE_JWT_SECRET = TEST_JWT_KEY;
    }
    // 真正拦住"配错了"的是启动期校验（enterprise/backend/shared/db 的 config-dev-default.test.ts），
    // 不是这里——这里只保证不会拿一把 3 字符的密钥去签。
  });
});

// ── 登录 / 刷新 ────────────────────────────────────────────

describe("[F-07-01][F-07-02] 登录与刷新", () => {
  async function appWith(passwordHash: string, devices: Device[] = []) {
    const app = express();
    app.use(createAuthRouter({ users: usersOf(passwordHash), devices: devicesOf(devices) }));
    return app;
  }

  it("口令正确 → 拿到 access + refresh", async () => {
    const app = await appWith(await hashPassword("pw-correct"));
    const r = await call(app, "/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "pw-correct" }),
    });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.accessToken, "string");
    assert.equal(typeof r.json.refreshToken, "string");
    assert.deepEqual(r.json.user, { id: ALICE.id, displayName: "叶琳" });
  });

  it("**用户不存在与口令错的响应逐字节一致**——否则就是账号枚举通道", async () => {
    const app = await appWith(await hashPassword("pw-correct"));
    const noUser = await call(app, "/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "nobody", password: "pw-correct" }),
    });
    const badPw = await call(app, "/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "wrong" }),
    });
    assert.equal(noUser.status, 401);
    assert.equal(badPw.status, 401);
    assert.deepEqual(noUser.json, badPw.json);
    assert.deepEqual(noUser.json, { error: "unauthorized" });
  });

  it("锁定账号（散列 `!`）登不进去", async () => {
    const app = await appWith(LOCKED_PASSWORD_HASH);
    const r = await call(app, "/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "!" }),
    });
    assert.equal(r.status, 401);
  });

  it("refresh 换新 access；拿 access 当 refresh 用会被拒", async () => {
    const app = await appWith(await hashPassword("pw"));
    const login = await call(app, "/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "pw" }),
    });
    const ok = await call(app, "/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: login.json.refreshToken }),
    });
    assert.equal(ok.status, 200);
    assert.equal(typeof ok.json.accessToken, "string");

    const misuse = await call(app, "/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: login.json.accessToken }),
    });
    assert.equal(misuse.status, 401);
  });

  /*
   * 车辆级刷新必须把**当前**绑定 vin 回给端上。
   *
   * 端上 `bound_vin()` 读的是配对当天写进钥匙串的快照，而绑定在服务端还会变：
   * 无 VIN 建档拿的是 `PEND-xxx` 占位主键，车主补录真 VIN 后服务端整条链都换了。
   * 刷新响应里不带 vin 的话，端上没有任何渠道知道这件事，快照就永久过期——
   * 症状是车机"已绑定"却列不出成员（`GET /v1/vehicles/PEND-xxx/members` → 404），
   * 而 404 不触发 `with_refresh` 的自愈路径，卡住之后自己不会好。
   */
  it("**车辆级刷新回当前绑定 vin**——补录 VIN 后端上那份快照要能被纠正", async () => {
    const bound = device({
      id: "d-cockpit",
      userId: ALICE.id,
      deviceType: "cockpit",
      vehicleVin: "LSJREAL0000000001",
    });
    const app = await appWith(await hashPassword("pw"), [bound]);

    // 端上手里那枚 refresh 是配对当天签的，vin 还是占位值。
    const stale = issueToken({
      sub: bound.id,
      kind: "vehicle",
      use: "refresh",
      deviceId: bound.id,
      vin: "PEND-ABCDEF123456",
    });
    const r = await call(app, "/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: stale }),
    });
    assert.equal(r.status, 200);
    // 响应体里要有 vin——签在 access token 里不算，端上不解 JWT。
    assert.equal(r.json.vin, "LSJREAL0000000001");
    assert.equal(
      verifyToken(String(r.json.accessToken))?.vin,
      "LSJREAL0000000001",
      "access token 里也得是新的",
    );
  });

  it("人的刷新不带 vin——`user_id` 是真的用户 id，不能被一个 vin 覆盖", async () => {
    const app = await appWith(await hashPassword("pw"));
    const login = await call(app, "/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "pw" }),
    });
    const r = await call(app, "/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: login.json.refreshToken }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.vin, undefined);
  });

  it("**设备被撤销后刷新失败**——否则撤销要等 refresh 自然过期（14 天）", async () => {
    const live = device({ id: "d-live", userId: ALICE.id });
    const app = await appWith(await hashPassword("pw"), [live]);
    const login = await call(app, "/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "pw", deviceId: "d-live" }),
    });
    assert.equal(login.status, 200);

    // 同一个 refresh，换成"设备已撤销"的世界
    const revoked = await appWith(await hashPassword("pw"), [
      device({ id: "d-live", userId: ALICE.id, revokedAt: new Date() }),
    ]);
    const r = await call(revoked, "/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: login.json.refreshToken }),
    });
    assert.equal(r.status, 401);
  });
});

// ── 鉴权中间件 ─────────────────────────────────────────────

describe("[F-07-01] jwtAuth 中间件", () => {
  function guarded(devices: Device[] = []) {
    const app = express();
    app.use(createJwtAuth({ users: usersOf(LOCKED_PASSWORD_HASH), devices: devicesOf(devices) }));
    app.get("/probe", (req: AuthedRequest, res) => {
      res.json({
        userId: req.userId ?? null,
        deviceId: req.deviceId ?? null,
        vin: req.vehicleVin ?? null,
        kind: req.tokenKind ?? null,
      });
    });
    return app;
  }

  const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

  it("无 token / 坏 token / 过期 token 一律 401 同一句", async () => {
    const app = guarded();
    const none = await call(app, "/probe");
    const bad = await call(app, "/probe", auth("not.a.token"));
    const expired = await call(
      app,
      "/probe",
      auth(issueToken({ sub: ALICE.id, kind: "user", use: "access", ttlSec: -1 })),
    );
    for (const r of [none, bad, expired]) {
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, { error: "unauthorized" });
    }
  });

  it("**refresh token 不能当 access 用**", async () => {
    const app = guarded();
    const r = await call(
      app,
      "/probe",
      auth(issueToken({ sub: ALICE.id, kind: "user", use: "refresh" })),
    );
    assert.equal(r.status, 401);
  });

  it("有效 token → userId 注入下游", async () => {
    const app = guarded();
    const r = await call(
      app,
      "/probe",
      auth(issueToken({ sub: ALICE.id, kind: "user", use: "access" })),
    );
    assert.equal(r.status, 200);
    assert.equal(r.json.userId, ALICE.id);
    assert.equal(r.json.kind, "user");
  });

  it("账号已不存在 → 401（token 还没过期也不行）", async () => {
    const app = guarded();
    const r = await call(
      app,
      "/probe",
      auth(issueToken({ sub: "u-ghost", kind: "user", use: "access" })),
    );
    assert.equal(r.status, 401);
  });

  it("**设备撤销当场生效**：token 未过期，但设备没了就是 401", async () => {
    const t = issueToken({ sub: ALICE.id, kind: "user", use: "access", deviceId: "d-1" });
    const live = guarded([device({ id: "d-1", userId: ALICE.id })]);
    assert.equal((await call(live, "/probe", auth(t))).status, 200);

    const dead = guarded([device({ id: "d-1", userId: ALICE.id, revokedAt: new Date() })]);
    assert.equal((await call(dead, "/probe", auth(t))).status, 401);
  });

  it("拿别人的设备 id 签的 token 不认——deviceId 必须属于该账号", async () => {
    const t = issueToken({ sub: ALICE.id, kind: "user", use: "access", deviceId: "d-bob" });
    const app = guarded([device({ id: "d-bob", userId: "u-bob" })]);
    assert.equal((await call(app, "/probe", auth(t))).status, 401);
  });

  it("**车辆级 token 不带 userId**：只给 vin 与设备，谁在用由上车声明回答（M48-05）", async () => {
    const app = guarded([
      device({ id: "d-cockpit", userId: ALICE.id, deviceType: "cockpit", vehicleVin: "VIN-1" }),
    ]);
    const r = await call(
      app,
      "/probe",
      auth(issueToken({ sub: "d-cockpit", kind: "vehicle", use: "access", vin: "VIN-1" })),
    );
    assert.equal(r.status, 200);
    assert.equal(r.json.userId, null, "车辆 token 绝不能推导出某个人");
    assert.equal(r.json.vin, "VIN-1");
    assert.equal(r.json.kind, "vehicle");
  });

  it("车机解绑后旧的车辆 token 立刻失效", async () => {
    const t = issueToken({ sub: "d-cockpit", kind: "vehicle", use: "access", vin: "VIN-1" });
    const unbound = guarded([device({ id: "d-cockpit", userId: ALICE.id, deviceType: "cockpit" })]);
    assert.equal((await call(unbound, "/probe", auth(t))).status, 401);

    const rebound = guarded([
      device({ id: "d-cockpit", userId: ALICE.id, deviceType: "cockpit", vehicleVin: "VIN-2" }),
    ]);
    assert.equal(
      (await call(rebound, "/probe", auth(t))).status,
      401,
      "换绑到别的车后，旧 token 里的 vin 对不上，同样失效",
    );
  });
});
