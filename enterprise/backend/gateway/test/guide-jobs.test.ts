/**
 * 导览后台任务通道（ACR-008）。
 *
 * 盯三件事：行程归属只认鉴权身份（查错人不报错，只是把别人的进度端上了屏）；
 * 状态查询是轮询面——runtime 关着/挂了一律 200 + jobs:null，不许 5xx；
 * 手动触发的行程上下文（城市/出发日）由网关从当前行程补，按钮只说"哪个景点"。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";

import type { TripPlanRepository, CommittedTripPlan } from "@carlife/db";
import type { TripPlanSnapshot } from "@carlife/shared";

import { createGuideJobsRouter } from "../src/http/guide-jobs";

const PLAN: TripPlanSnapshot = {
  status: "confirmed",
  destination: "舟山",
  startDate: "2026-09-01",
  days: 2,
  skeleton: [{ day: 1, spots: [{ name: "普陀山" }, { name: "朱家尖" }] }],
  caveats: [],
  updatedTurnId: "t",
};

function memRepo(rows: CommittedTripPlan[]): TripPlanRepository {
  return {
    async commit() {
      throw new Error("端点只读，不该调它");
    },
    async cancelCurrent() {
      throw new Error("只读");
    },
    async cancelById() {
      throw new Error("只读");
    },
    async update() {
      throw new Error("只读");
    },
    async setNav() {
      throw new Error("只读");
    },
    async currentForUser(userId) {
      return rows.find((r) => r.userId === userId && r.status === "confirmed") ?? null;
    },
    async list() {
      return [];
    },
    async query() {
      return [];
    },
  } as unknown as TripPlanRepository;
}

const ROW: CommittedTripPlan = {
  planId: "plan-1",
  userId: "u1",
  sessionId: "s1",
  status: "confirmed",
  plan: PLAN,
  committedAt: new Date("2026-08-29"),
};

function appWith(userId: string | null, repo: TripPlanRepository, runtimeUrl?: string) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createGuideJobsRouter(repo, runtimeUrl));
  return app;
}

async function call(app: express.Express, method: "GET" | "POST", path: string, body?: unknown) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

/** 假 runtime：记录入参，按需回状态/入队结果。 */
function fakeRuntime(replies: { status?: unknown; enqueue?: unknown }) {
  const seen: { path: string; body: unknown }[] = [];
  const app = express();
  app.use(express.json());
  app.post("/internal/guide/jobs-status", (req, res) => {
    seen.push({ path: "status", body: req.body });
    if (replies.status === undefined) res.status(503).json({ error: "guide_queue_disabled" });
    else res.json(replies.status);
  });
  app.post("/internal/guide/enqueue", (req, res) => {
    seen.push({ path: "enqueue", body: req.body });
    if (replies.enqueue === undefined) res.status(503).json({ error: "guide_queue_disabled" });
    else res.json(replies.enqueue);
  });
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

const JOBS = {
  spots: [
    { spotName: "普陀山", state: "ready", cached: true },
    { spotName: "朱家尖", state: "processing" },
  ],
  summary: { total: 2, ready: 1, processing: 1, pending: 0, failed: 0, unprocessed: 0 },
};

test("GET jobs：鉴权→查当前行程→转发 plan→原样返回（含 planId）", async () => {
  const rt = fakeRuntime({ status: { jobs: JOBS } });
  try {
    const r = await call(appWith("u1", memRepo([ROW]), rt.url), "GET", "/v1/guide/jobs");
    assert.equal(r.status, 200);
    assert.equal(r.body.planId, "plan-1");
    assert.deepEqual(r.body.jobs, JOBS, "jobs 原样透传——网关不挑不拣");
    assert.deepEqual(rt.seen[0], { path: "status", body: { plan: PLAN } });
  } finally {
    rt.close();
  }
});

test("GET jobs：未鉴权 401；没有行程 200+jobs:null；查的是自己的行程不是别人的", async () => {
  const rt = fakeRuntime({ status: { jobs: JOBS } });
  try {
    const unauth = await call(appWith(null, memRepo([ROW]), rt.url), "GET", "/v1/guide/jobs");
    assert.equal(unauth.status, 401);
    const other = await call(appWith("u2", memRepo([ROW]), rt.url), "GET", "/v1/guide/jobs");
    assert.equal(other.status, 200);
    assert.deepEqual(other.body, { jobs: null }, "u2 没有行程——不能把 u1 的进度端出去");
    assert.equal(rt.seen.length, 0, "没有行程就不该打扰 runtime");
  } finally {
    rt.close();
  }
});

test("GET jobs：runtime 关着（503）/没配地址——轮询面一律 200 + jobs:null，不冒 5xx", async () => {
  const disabled = fakeRuntime({});
  try {
    const r = await call(appWith("u1", memRepo([ROW]), disabled.url), "GET", "/v1/guide/jobs");
    assert.equal(r.status, 200);
    assert.equal(r.body.jobs, null);
    const noRt = await call(appWith("u1", memRepo([ROW]), undefined), "GET", "/v1/guide/jobs");
    assert.equal(noRt.status, 200);
    assert.equal(noRt.body.jobs, null);
  } finally {
    disabled.close();
  }
});

test("POST trigger：按钮只说景点名，城市/出发日由网关从当前行程补齐", async () => {
  const rt = fakeRuntime({ enqueue: { spot: { spotName: "朱家尖", state: "pending" } } });
  try {
    const r = await call(appWith("u1", memRepo([ROW]), rt.url), "POST", "/v1/guide/jobs/trigger", {
      spotName: "朱家尖",
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.spot, { spotName: "朱家尖", state: "pending" });
    assert.deepEqual(rt.seen[0], {
      path: "enqueue",
      body: {
        spotName: "朱家尖",
        city: "舟山",
        date: "2026-09-01",
        selfDrive: true,
        // 行程上下文随触发下发（2026-08-29 走查）：兄弟景点（小景点不拆 +
        // 跨页去重）、上一站（到达面写衔接不写全套出发）、末站标记（返程补能）。
        siblingSpots: ["普陀山"],
        prevSpot: "普陀山",
        isLastStop: true,
      },
    });
  } finally {
    rt.close();
  }
});

test("POST trigger：空 spotName 400；runtime 不可用回 failed 态而不是报错", async () => {
  const disabled = fakeRuntime({});
  try {
    const bad = await call(appWith("u1", memRepo([ROW]), disabled.url), "POST", "/v1/guide/jobs/trigger", {
      spotName: " ",
    });
    assert.equal(bad.status, 400);
    const down = await call(appWith("u1", memRepo([ROW]), disabled.url), "POST", "/v1/guide/jobs/trigger", {
      spotName: "普陀山",
    });
    assert.equal(down.status, 200);
    assert.equal((down.body.spot as { state: string }).state, "failed");
  } finally {
    disabled.close();
  }
});
