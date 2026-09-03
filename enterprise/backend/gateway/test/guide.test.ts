/**
 * 景区导览触发通道（M36-02）。
 *
 * 盯三件事：鉴权与参数校验在网关这一侧；runtime 的 brief **原样透传**（网关红线：
 * 不挑不拣不改写）；失败一律 200 + status:"failed"——"景区太冷门没查到"不是一次报错。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";

import { createGuideRouter } from "../src/http/guide";

function appWith(userId: string | null, runtimeUrl?: string, timeoutMs?: number) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createGuideRouter(runtimeUrl, timeoutMs));
  return app;
}

async function post(app: express.Express, body: unknown) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/guide/brief`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

/** 假 runtime：记录收到的入参，按 reply 回包（undefined = 500）。 */
function fakeRuntime(reply?: Record<string, unknown>, opts: { delayMs?: number } = {}) {
  const seen: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.post("/internal/guide/brief", (req, res) => {
    seen.push(req.body);
    const send = () => (reply ? res.json(reply) : res.status(500).json({ error: "boom" }));
    if (opts.delayMs) setTimeout(send, opts.delayMs);
    else send();
  });
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

const BRIEF = {
  spot: "普陀山",
  spots: [{ name: "普济寺", platform: "抖音" }],
  comfort: [],
  caveats: ["游玩顺序来自攻略整理（未经坐标校验）"],
  findings: [],
  branchSources: { access: "submission", spots: "submission", comfort: "submission" },
  sourcesVerified: { matched: 1, claimed: 1 },
  generatedAt: "2026-08-28T00:00:00Z",
};

test("未鉴权 401；spotName 空 400——两道校验都在转发之前", async () => {
  const rt = fakeRuntime({ brief: BRIEF, cached: false });
  try {
    const unauth = await post(appWith(null, rt.url), { spotName: "普陀山" });
    assert.equal(unauth.status, 401);
    const noSpot = await post(appWith("u1", rt.url), { spotName: "  " });
    assert.equal(noSpot.status, 400);
    assert.equal(rt.seen.length, 0, "校验不过不许打扰 runtime");
  } finally {
    rt.close();
  }
});

test("成功路径：入参透传（含 selfDrive），brief 逐字原样返回，status=ready", async () => {
  const rt = fakeRuntime({ brief: BRIEF, cached: true, computedAt: "2026-08-28T01:00:00Z" });
  try {
    const r = await post(appWith("u1", rt.url), {
      spotName: " 普陀山 ",
      city: "舟山",
      selfDrive: true,
      junk: "不该透传的字段",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "ready");
    assert.equal(r.body.cached, true);
    // 网关红线：brief 原样透传——深比较逐字一致，改写任何字段都算违规。
    assert.deepEqual(r.body.brief, BRIEF);
    assert.deepEqual(rt.seen[0], { spotName: "普陀山", city: "舟山", selfDrive: true });
  } finally {
    rt.close();
  }
});

test("body 缺 city/date 时从当前行程补齐——缓存键与队列路径同源（M40-02 走查追修）", async () => {
  const rt = fakeRuntime({ brief: BRIEF, cached: true });
  const plans = {
    async currentForUser() {
      return {
        planId: "p1",
        userId: "u1",
        sessionId: "s1",
        status: "confirmed",
        plan: { destination: "舟山 · 普陀山+朱家尖", startDate: "2026-09-01", days: 2, skeleton: [], caveats: [], status: "confirmed", updatedTurnId: "t" },
        committedAt: new Date(),
      };
    },
  } as never;
  try {
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { userId?: string }).userId = "u1";
      next();
    });
    const { createGuideRouter } = await import("../src/http/guide");
    app.use(createGuideRouter(rt.url, undefined, plans));
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      await fetch(`http://127.0.0.1:${port}/v1/guide/brief`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spotName: "千步沙景区" }),
      });
      assert.deepEqual(rt.seen[0], {
        spotName: "千步沙景区",
        city: "舟山 · 普陀山+朱家尖",
        date: "2026-09-01",
      });
      // body 显式给了 city/date 时仍以 body 为准（既有行为不变）
      await fetch(`http://127.0.0.1:${port}/v1/guide/brief`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spotName: "千步沙景区", city: "舟山", date: "2026-10-01" }),
      });
      assert.deepEqual(rt.seen[1], { spotName: "千步沙景区", city: "舟山", date: "2026-10-01" });
    } finally {
      server.close();
    }
  } finally {
    rt.close();
  }
});

test("runtime skipped / 5xx / 未配地址：一律 200 + status=failed，不冒 5xx", async () => {
  const skipped = fakeRuntime({ skipped: "failed" });
  const boom = fakeRuntime(undefined);
  try {
    for (const rt of [skipped, boom]) {
      const r = await post(appWith("u1", rt.url), { spotName: "普陀山" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { status: "failed" });
    }
    const noRuntime = await post(appWith("u1", undefined), { spotName: "普陀山" });
    assert.equal(noRuntime.status, 200);
    assert.deepEqual(noRuntime.body, { status: "failed" });
  } finally {
    skipped.close();
    boom.close();
  }
});

test("超时：预算内没回来就当这次没查成（200 failed），不挂死请求", async () => {
  const slow = fakeRuntime({ brief: BRIEF }, { delayMs: 300 });
  try {
    const r = await post(appWith("u1", slow.url, 50), { spotName: "普陀山" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "failed" });
  } finally {
    slow.close();
  }
});
