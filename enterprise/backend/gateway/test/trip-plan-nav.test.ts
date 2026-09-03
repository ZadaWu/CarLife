/**
 * 出发导航规划的网关通道（施工单 M66-03）。
 *
 * 盯四件事：行程只认鉴权身份（body 里塞 plan 被忽略）；起点补法（fix → home → no_origin 且不打 runtime）；
 * runtime 500 / 抛 / 超时一律 200 failed；ready 时 plan 原样透传。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { TripPlanRepository, CommittedTripPlan, OwnerProfileRepository } from "@carlife/db";
import type { NavPlan, TripPlanSnapshot } from "@carlife/shared";

import { createTripPlanRouter, originAgeMinutes } from "../src/http/trip-plan";

const PLAN: TripPlanSnapshot = {
  status: "confirmed",
  destination: "杭州",
  startDate: "2026-09-02",
  days: 1,
  party: "带我妈",
  skeleton: [{ day: 1, theme: "西湖", spots: [{ name: "灵隐寺", lat: 30.2419, lon: 120.0987 }] }],
  caveats: [],
  updatedTurnId: "t",
};

const NAV_PLAN: NavPlan = {
  origin: { lat: 31.23, lon: 121.47, source: "fix" },
  destination: { name: "灵隐寺", lat: 30.2419, lon: 120.0987 },
  strategy: "highway",
  strategyReason: "默认走高速",
  summary: { distanceKm: 186.5, durationMin: 209, tollYuan: 71 },
  waypoints: [{ name: "下沙服务区", lat: 30.307762, lon: 120.365516, atMinute: 143 }],
  legMinutes: [143, 66],
  constraints: [],
  caveats: [],
  computedAt: "2026-09-02T08:00:00.000Z",
};

function memRepo(rows: CommittedTripPlan[]): TripPlanRepository {
  return {
    async commit() {
      throw new Error("端点只读，不该调它");
    },
    async cancelCurrent() {
      throw new Error("端点只读，不该调它");
    },
    async currentForUser(userId) {
      return rows.find((r) => r.userId === userId && r.status === "confirmed") ?? null;
    },
  } as TripPlanRepository;
}

const row: CommittedTripPlan = {
  planId: "p1",
  userId: "demo-user",
  sessionId: "sess-1",
  status: "confirmed",
  plan: PLAN,
  committedAt: new Date("2026-09-01T10:00:00Z"),
} as CommittedTripPlan;

function owners(home?: { city: string; lat: number; lon: number }): OwnerProfileRepository {
  return {
    async currentForUser(userId: string) {
      return { userId, home: home ?? { city: "浙江杭州", lat: 30.2741, lon: 120.1551 }, updatedAt: new Date() };
    },
  } as unknown as OwnerProfileRepository;
}

/** 假 runtime：记下收到的 body；`reply` 缺省 → 500；`delayMs` 用来触发网关超时。 */
function fakeRuntime(reply?: Record<string, unknown>, delayMs = 0) {
  const bodies: unknown[] = [];
  const app = express();
  app.use(express.json());
  app.post("/internal/trip/nav-plan", (req, res) => {
    bodies.push(req.body);
    setTimeout(() => {
      if (!reply) {
        res.status(500).json({ error: "boom" });
        return;
      }
      res.json(reply);
    }, delayMs);
  });
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, bodies, close: () => server.close() };
}

function appWith(opts: { repo: TripPlanRepository; userId: string | null; runtimeUrl?: string; owners?: OwnerProfileRepository; timeoutMs?: number }) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = opts.userId ?? undefined;
    next();
  });
  app.use(createTripPlanRouter(opts.repo, opts.owners, opts.runtimeUrl, opts.timeoutMs));
  return app;
}

async function post(app: express.Express, body: unknown) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/trip-plan/nav-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("POST /v1/trip-plan/nav-plan", () => {
  it("无 userId → 401；无已确认行程 → 200 failed/no_plan", async () => {
    const rt = fakeRuntime({ plan: NAV_PLAN });
    try {
      const a = await post(appWith({ repo: memRepo([row]), userId: null, runtimeUrl: rt.url }), {});
      assert.equal(a.status, 401);
      const b = await post(appWith({ repo: memRepo([]), userId: "demo-user", runtimeUrl: rt.url }), {});
      assert.equal(b.status, 200);
      assert.deepEqual(b.body, { status: "failed", reason: "no_plan" });
      assert.equal(rt.bodies.length, 0);
    } finally {
      rt.close();
    }
  });

  it("body 有 origin → fix + ageMinutes；转发的是仓储里的 plan（body 塞的 plan 被忽略）；ready 原样透传", async () => {
    const rt = fakeRuntime({ plan: NAV_PLAN, elapsedMs: 7878 });
    try {
      const at = new Date(Date.now() - 5 * 60_000).toISOString();
      const r = await post(appWith({ repo: memRepo([row]), userId: "demo-user", runtimeUrl: rt.url }), {
        origin: { lat: 31.23, lon: 121.47, at },
        vin: "VIN1",
        plan: { destination: "别人的行程", skeleton: [] },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "ready");
      assert.deepEqual(r.body.plan, NAV_PLAN, "plan 原样透传");
      assert.equal(typeof r.body.elapsedMs, "number");
      const sent = rt.bodies[0] as { userId: string; plan: TripPlanSnapshot; origin: Record<string, unknown>; vin?: string };
      assert.equal(sent.userId, "demo-user");
      assert.equal(sent.plan.destination, "杭州", "转发的是仓储里那份");
      assert.equal(sent.origin.source, "fix");
      assert.equal(sent.origin.ageMinutes, 5);
      assert.equal(sent.vin, "VIN1");
    } finally {
      rt.close();
    }
  });

  it("无 origin 有常住地 → source:home；两者皆无 → failed/no_origin 且不打 runtime", async () => {
    const rt = fakeRuntime({ plan: NAV_PLAN });
    try {
      const a = await post(appWith({ repo: memRepo([row]), userId: "demo-user", runtimeUrl: rt.url, owners: owners() }), {});
      assert.equal(a.body.status, "ready");
      const sent = rt.bodies[0] as { origin: Record<string, unknown> };
      assert.deepEqual(sent.origin, { lat: 30.2741, lon: 120.1551, source: "home" });

      const b = await post(appWith({ repo: memRepo([row]), userId: "demo-user", runtimeUrl: rt.url }), {});
      assert.deepEqual(b.body, { status: "failed", reason: "no_origin" });
      assert.equal(rt.bodies.length, 1, "没有起点不该打 runtime");
    } finally {
      rt.close();
    }
  });

  it("runtime 500 / skipped / 超时 → 200 failed（超时 reason 是 timeout）；没配 runtimeUrl → failed", async () => {
    const bad = fakeRuntime(undefined);
    const skipped = fakeRuntime({ skipped: "failed" });
    const slow = fakeRuntime({ plan: NAV_PLAN }, 300);
    try {
      const origin = { lat: 31.23, lon: 121.47 };
      const a = await post(appWith({ repo: memRepo([row]), userId: "demo-user", runtimeUrl: bad.url }), { origin });
      assert.equal(a.status, 200);
      assert.equal(a.body.status, "failed");
      const b = await post(appWith({ repo: memRepo([row]), userId: "demo-user", runtimeUrl: skipped.url }), { origin });
      assert.equal(b.body.status, "failed");
      const c = await post(appWith({ repo: memRepo([row]), userId: "demo-user", runtimeUrl: slow.url, timeoutMs: 50 }), { origin });
      assert.equal(c.body.status, "failed");
      assert.equal(c.body.reason, "timeout");
      const d = await post(appWith({ repo: memRepo([row]), userId: "demo-user" }), { origin });
      assert.deepEqual(d.body, { status: "failed", reason: "failed" });
    } finally {
      bad.close();
      skipped.close();
      slow.close();
    }
  });

  it("originAgeMinutes：ISO → 分钟；非法/缺省 → undefined", () => {
    const now = Date.parse("2026-09-02T08:10:00.000Z");
    assert.equal(originAgeMinutes("2026-09-02T08:00:00.000Z", now), 10);
    assert.equal(originAgeMinutes("2026-09-02T09:00:00.000Z", now), 0, "未来时刻钳到 0");
    assert.equal(originAgeMinutes("nonsense", now), undefined);
    assert.equal(originAgeMinutes(undefined, now), undefined);
  });
});
