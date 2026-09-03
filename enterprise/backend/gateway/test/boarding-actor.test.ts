/**
 * 上车声明的代理身份（施工单 M54-13）。
 *
 * 这是一道**安全边界**，所以正向用例（"车机终于读得到了"）价值最低——
 * 下面每一条反向用例才是它存在的理由：出示别人的会话、已关闭的会话、
 * 访客会话、不是本机建的会话，都不能换来身份。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import { createBoardingActorMiddleware, type BoardingActorRequest } from "../src/auth/boarding-actor";

const DEVICE = "dev-cockpit-1";
const OTHER_DEVICE = "dev-cockpit-2";

/** 库里的四种会话形态。 */
const SESSIONS: Record<string, { userId: string | null; deviceId: string | null }> = {
  "sess-mine": { userId: "u-driver", deviceId: DEVICE },
  "sess-guest": { userId: null, deviceId: DEVICE },
  "sess-other-device": { userId: "u-owner", deviceId: OTHER_DEVICE },
  // 已关闭：仓储层把 userId 抹成 null 再返回（见 chat.ts 的 sessionActor）
  "sess-closed": { userId: null, deviceId: DEVICE },
};

const chat = {
  async sessionActor(id: string) {
    return SESSIONS[id];
  },
};

/** 起一个只跑本中间件的最小 app，回显它最终认定的身份。 */
function serve(pre: Partial<BoardingActorRequest>) {
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, pre);
    next();
  });
  app.use(createBoardingActorMiddleware(chat));
  app.get("/who", (req: BoardingActorRequest, res) => {
    res.json({ userId: req.userId ?? null, viaBoarding: req.actingViaBoarding ?? false });
  });
  return app;
}

async function ask(app: express.Express, sessionHeader?: string) {
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/who`, {
      headers: sessionHeader ? { "x-carlife-session": sessionHeader } : undefined,
    });
    return (await r.json()) as { userId: string | null; viaBoarding: boolean };
  } finally {
    server.close();
  }
}

const COCKPIT = { vehicleVin: "VIN1", deviceId: DEVICE, tokenKind: "vehicle" as const };

describe("[M54-13] 上车声明换身份", () => {
  it("本机建的、有归属人的会话 → 补上身份并打标", async () => {
    const r = await ask(serve(COCKPIT), "sess-mine");
    assert.equal(r.userId, "u-driver");
    assert.equal(r.viaBoarding, true, "标记必须打上——车主权限那道门要靠它拒绝");
  });

  it("**别的设备**建的会话换不来身份", async () => {
    const r = await ask(serve(COCKPIT), "sess-other-device");
    assert.equal(r.userId, null, "不校验 deviceId 的话，出示任意会话 id 就能冒充");
  });

  it("访客会话换不来身份——访客本就不代表任何人", async () => {
    assert.equal((await ask(serve(COCKPIT), "sess-guest")).userId, null);
  });

  it("已关闭的会话换不来身份（「退下」之后不该还能读个人数据）", async () => {
    assert.equal((await ask(serve(COCKPIT), "sess-closed")).userId, null);
  });

  it("会话不存在：不报错，只是没有身份", async () => {
    // 用 ASCII 值：HTTP 头不能带非 ASCII，第一版写了中文 id，红的是 fetch 不是被测代码。
    assert.equal((await ask(serve(COCKPIT), "sess-no-such")).userId, null);
  });

  it("不带请求头：原样放过", async () => {
    assert.equal((await ask(serve(COCKPIT))).userId, null);
  });

  it("**人的 token 不受影响**——已登录的人不会被会话头改成别人", async () => {
    const r = await ask(serve({ userId: "u-me", tokenKind: "user" }), "sess-mine");
    assert.equal(r.userId, "u-me", "人的身份来自 token，任何请求头都不许覆盖它");
    assert.equal(r.viaBoarding, false);
  });

  it("没有 deviceId 的车辆 token 不生效（拿什么去比对设备）", async () => {
    const r = await ask(serve({ vehicleVin: "VIN1", tokenKind: "vehicle" }), "sess-mine");
    assert.equal(r.userId, null);
  });

  it("库抖动时如实放过，不升级成 500", async () => {
    const app = express();
    app.use((req, _res, next) => { Object.assign(req, COCKPIT); next(); });
    app.use(createBoardingActorMiddleware({
      async sessionActor() { throw new Error("PG P1001"); },
    }));
    app.get("/who", (req: BoardingActorRequest, res) => res.json({ userId: req.userId ?? null }));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/who`);
      assert.equal(r.status, 200, "一次库抖动不该让车机身份全丢");
    } finally {
      server.close();
    }
  });
});
