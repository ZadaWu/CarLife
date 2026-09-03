/**
 * 上车声明与访客模式（施工单 M48-05，F-56-05/06 / F-07-10）。
 *
 * 这一单关掉了 FL-07 F-07-10「多驾驶者策略」两个月的未决——答案是**声明制**，
 * 不是识别制（不做人脸/声纹/蓝牙推断，设计 §7）。
 *
 * 盯得最紧的四条：
 *  - **车辆级 token 换不成任意人的身份**：声明必须落在这辆车的成员集合里。
 *  - **"没声明"≠"访客"**：忘了传字段是 400，访客要显式传 null——
 *    访客是要播报出来的降级，不该悄悄发生。
 *  - **人的 token 忽略声明**：已登录的人不能声明成另一个人。
 *  - **访客会话不进任何人的历史**：userId 落 NULL。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { AuthedRequest } from "../src/auth";
import { createHttpRouter, type BoardingDeps } from "../src/http";

const OWNER = "u-owner";
const DRIVER = "u-driver";
const OUTSIDER = "u-outsider";
const VIN = "LSJTEST0000000055";

/** 记录建会话时实际落库的归属，断言据此判定。 */
function repoStub() {
  const created: Array<{ sessionId: string; userId: string | null; deviceId: string | null }> = [];
  return {
    created,
    async createSession(sessionId: string, userId: string | null, deviceId?: string | null) {
      created.push({ sessionId, userId, deviceId: deviceId ?? null });
    },
    async sessionUserId(sessionId: string) {
      return created.find((c) => c.sessionId === sessionId)?.userId;
    },
    async sessionState() {
      return { exists: true, closedAt: null, lastActiveAt: null };
    },
    async appendMessage() {
      /* no-op */
    },
  };
}

const busStub = { append() {} };
const asrStub = { async transcribe() {
  return { text: "", model: "", inputTokens: 0, outputTokens: 0, durationMs: 0 };
} };

const boarding: BoardingDeps = {
  async ownerOf(vin) {
    return vin === VIN ? OWNER : null;
  },
  async activeMemberIds(vin) {
    return vin === VIN ? [DRIVER] : [];
  },
};

/**
 * `deps` 用 `null` 表示"不注入"而不是 `undefined`。
 *
 * JS 的默认参数在实参**是 undefined 时也会生效**——写成
 * `deps: BoardingDeps | undefined = boarding` 的话，显式传 undefined 拿到的
 * 仍然是 boarding，那条"未注入"的用例就永远测不到它想测的东西
 * （第一版正是如此，当场 201 !== 400）。
 */
function appAs(
  identity: { userId?: string; vehicleVin?: string; deviceId?: string },
  repo = repoStub(),
  deps: BoardingDeps | null = boarding,
) {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req as AuthedRequest, identity);
    next();
  });
  app.use(
    createHttpRouter(repo as never, busStub as never, asrStub as never, undefined, deps ?? undefined),
  );
  return { app, repo };
}

async function createSession(app: express.Express, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  } finally {
    server.close();
  }
}

describe("[F-56-05] 人的 token：声明被忽略", () => {
  it("正常建会话，归属是登录者", async () => {
    const { app, repo } = appAs({ userId: DRIVER, deviceId: "d-1" });
    const r = await createSession(app, {});
    assert.equal(r.status, 201);
    assert.equal(repo.created[0]!.userId, DRIVER);
    assert.equal(repo.created[0]!.deviceId, "d-1", "会话归 (userId, deviceId)");
    assert.equal(r.json.guest, false);
  });

  it("**已登录的人不能声明成另一个人**——允许了就等于把整套隔离作废", async () => {
    const { app, repo } = appAs({ userId: DRIVER });
    const r = await createSession(app, { activeUserId: OWNER });
    assert.equal(r.status, 201);
    assert.equal(repo.created[0]!.userId, DRIVER, "声明被忽略，仍是本人");
  });
});

describe("[F-56-05][AC-56-5] 车辆级 token：声明校验", () => {
  it("声明成生效成员 → 会话归那个人", async () => {
    const { app, repo } = appAs({ vehicleVin: VIN, deviceId: "cockpit-1" });
    const r = await createSession(app, { activeUserId: DRIVER });
    assert.equal(r.status, 201);
    assert.equal(repo.created[0]!.userId, DRIVER);
    assert.equal(r.json.guest, false);
  });

  it("声明成车主也可以（车主本人也是成员）", async () => {
    const { app, repo } = appAs({ vehicleVin: VIN });
    const r = await createSession(app, { activeUserId: OWNER });
    assert.equal(r.status, 201);
    assert.equal(repo.created[0]!.userId, OWNER);
  });

  it("**声明成名单外的人 → 400**：车辆级凭证换不成任意人的身份", async () => {
    const { app, repo } = appAs({ vehicleVin: VIN });
    const r = await createSession(app, { activeUserId: OUTSIDER });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "invalid_active_user");
    assert.equal(repo.created.length, 0, "被拒的声明不该留下任何会话");
  });

  it("**没带 activeUserId 字段 → 400，不静默当成访客**", async () => {
    const { app, repo } = appAs({ vehicleVin: VIN });
    const r = await createSession(app, {});
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "active_user_required");
    assert.equal(repo.created.length, 0);
  });

  it("空 body 同样是 400（忘了传与传空是同一回事）", async () => {
    const { app } = appAs({ vehicleVin: VIN });
    const r = await createSession(app);
    assert.equal(r.status, 400);
  });

  it("声明成空串或非字符串 → 400", async () => {
    for (const bad of ["", 42, {}, []]) {
      const { app } = appAs({ vehicleVin: VIN });
      const r = await createSession(app, { activeUserId: bad });
      assert.equal(r.status, 400, `bad=${JSON.stringify(bad)}`);
    }
  });

  it("被移除的成员当场声明不进来——名单是实时查的", async () => {
    const emptied: BoardingDeps = {
      async ownerOf() {
        return OWNER;
      },
      // 车主刚把 DRIVER 移除
      async activeMemberIds() {
        return [];
      },
    };
    const { app } = appAs({ vehicleVin: VIN }, repoStub(), emptied);
    const r = await createSession(app, { activeUserId: DRIVER });
    assert.equal(r.status, 400);
  });

  it("未注入 boarding 依赖时车机建不了会话（保持 M48-02 起的行为）", async () => {
    const { app } = appAs({ vehicleVin: VIN }, repoStub(), null);
    const r = await createSession(app, { activeUserId: DRIVER });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "active_user_required");
  });
});

describe("[F-56-06][AC-56-7] 访客模式", () => {
  it("显式声明 null → 会话归属为空，且回 guest:true 供端上播报降级", async () => {
    const { app, repo } = appAs({ vehicleVin: VIN, deviceId: "cockpit-1" });
    const r = await createSession(app, { activeUserId: null });
    assert.equal(r.status, 201);
    assert.equal(repo.created[0]!.userId, null, "访客会话 userId 落 NULL");
    assert.equal(r.json.guest, true, "静默降级会让用户以为助手忘了他的偏好");
  });

  it("访客会话不属于任何人——按 userId 查历史取不到它", async () => {
    const { app, repo } = appAs({ vehicleVin: VIN });
    await createSession(app, { activeUserId: null });
    const mine = repo.created.filter((c) => c.userId === OWNER || c.userId === DRIVER);
    assert.equal(mine.length, 0);
  });
});

describe("[F-07-10] 多驾驶者：同一台车机换人", () => {
  it("两次声明两个不同的人 → 两个会话各归各的，互不覆盖", async () => {
    const repo = repoStub();
    const first = appAs({ vehicleVin: VIN, deviceId: "cockpit-1" }, repo);
    await createSession(first.app, { activeUserId: OWNER });
    const second = appAs({ vehicleVin: VIN, deviceId: "cockpit-1" }, repo);
    await createSession(second.app, { activeUserId: DRIVER });

    assert.deepEqual(
      repo.created.map((c) => c.userId),
      [OWNER, DRIVER],
    );
    assert.notEqual(repo.created[0]!.sessionId, repo.created[1]!.sessionId, "换人就是新会话");
  });

  it("会话归属可被回查——发消息时用它而不是请求上下文（车机上后者没有人）", async () => {
    const repo = repoStub();
    const { app } = appAs({ vehicleVin: VIN }, repo);
    const r = await createSession(app, { activeUserId: DRIVER });
    const sid = r.json.sessionId as string;
    assert.equal(await repo.sessionUserId(sid), DRIVER);
  });
});
