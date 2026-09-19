/**
 * 行程路径对比端点带上**未落库的草案**（turn-ced8b400，2026-09-18）。
 *
 * 走查现象：一条排出了三天行程的对话，后台三列里「最终行程」一片空白，读的人得到的结论是
 * "这次什么都没排出来"。根因是这个端点只读 `trip_plans`，而"排了但没确认"最常见——
 * 那份东西在 `working_tasks` 里。
 *
 * 这里守四条：有草案就带上；三道门（车主查不到 / 没有活跃任务 / 草案属于别的对话）各自不带；
 * 以及**不注入 tasks 时行为与从前一字不差**（草案是加法，不是前提）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import express from "express";

import { createTripRouteRouter, type TripRouteDeps } from "../src/console/trip-route";

const SESSION = "sess-abc";
const DRAFT_PLAN = {
  days: 3,
  destination: "舟山＋杭州西湖",
  skeleton: [
    { day: 1, theme: "西湖边缓步", spots: [{ name: "湖滨公园", lat: 30.2566, lon: 120.1588 }] },
    { day: 2, theme: "嵊泗海岛慢游", spots: [{ name: "嵊泗列岛", lat: 30.7118, lon: 122.4666 }] },
  ],
};

/** 活跃任务的替身。`sessionIds` 存的是**轮次键**，与库里的真实形状一致。 */
function task(over: Record<string, unknown> = {}) {
  return {
    id: "wt-1",
    userId: "u1",
    kind: "trip",
    status: "drafting",
    draft: DRAFT_PLAN,
    constraints: [],
    version: 1,
    openedAt: 0,
    touchedAt: Date.parse("2026-09-18T13:50:54.017Z"),
    expiresAt: 0,
    sessionIds: [`${SESSION}#1789739392041`],
    ...over,
  };
}

function appWith(over: Partial<TripRouteDeps> = {}) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { console?: unknown }).console = { subject: "ops-1", role: "ops" };
    next();
  });
  app.use(
    createTripRouteRouter({
      audits: { async listBySession() { return []; } } as never,
      plans: { async listBySessionPrefix() { return []; } } as never,
      chat: { async sessionUserId() { return "u1"; } } as never,
      tasks: { async get() { return task(); } } as never,
      ...over,
    }),
  );
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

describe("[F-18-15] /console/trip-route 带上未落库的草案", () => {
  it("有草案就带上：目的地、天数、更新时刻与逐天骨架", async () => {
    const { status, body } = await get(appWith(), `/console/trip-route/${SESSION}`);
    assert.equal(status, 200);
    const draft = body.draft as unknown as { destination: string; days: number; updatedAt: string; plan: typeof DRAFT_PLAN; status: string };
    assert.ok(draft, "草案没带上来——后台三列的「最终行程」会是空的");
    assert.equal(draft.destination, "舟山＋杭州西湖");
    assert.equal(draft.days, 3);
    assert.equal(draft.status, "drafting");
    assert.equal(draft.updatedAt, "2026-09-18T13:50:54.017Z");
    assert.equal(draft.plan.skeleton.length, 2);
  });

  it("草案属于别的对话就不带——`tasks.get` 给的是这个人眼下那一份，不核对会挂错会话名下", async () => {
    const app = appWith({ tasks: { async get() { return task({ sessionIds: ["sess-other#1"] }); } } as never });
    const { body } = await get(app, `/console/trip-route/${SESSION}`);
    assert.equal(body.draft, undefined);
  });

  it("车主查不到 / 没有活跃任务 / 草案没有逐天骨架：三样都不带，也不报错", async () => {
    for (const over of [
      { chat: { async sessionUserId() { return null; } } as never },
      { tasks: { async get() { return null; } } as never },
      { tasks: { async get() { return task({ draft: { destination: "x" } }); } } as never },
    ]) {
      const { status, body } = await get(appWith(over), `/console/trip-route/${SESSION}`);
      assert.equal(status, 200);
      assert.equal(body.draft, undefined);
    }
  });

  it("不注入 tasks 时行为与从前一字不差（草案是加法，不是前提）", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { console?: unknown }).console = { subject: "ops-1", role: "ops" };
      next();
    });
    app.use(
      createTripRouteRouter({
        audits: { async listBySession() { return []; } } as never,
        plans: { async listBySessionPrefix() { return []; } } as never,
        chat: { async sessionUserId() { throw new Error("不该被调用"); } } as never,
      }),
    );
    const { status, body } = await get(app, `/console/trip-route/${SESSION}`);
    assert.equal(status, 200);
    assert.equal(body.draft, undefined);
    assert.deepEqual(body.audits, []);
    assert.deepEqual(body.plans, []);
  });
});
