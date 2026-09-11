/**
 * 已确认行程只读端点（M13-03）。
 *
 * 盯两件事：归属只认鉴权身份（查错人不报错，只是把别人的行程端上了 HUD）；
 * 「还没确认过」是常态——必须 200 {plan:null}，404 会让轮询端反复告警。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type {
  TripPlanRepository,
  TripPlanReviewRepository,
  CommittedTripPlan,
  StoredTripPlanReview,
} from "@carlife/db";
import type { TripPlanSnapshot } from "@carlife/shared";

import { createTripPlanRouter } from "../src/http/trip-plan";

const PLAN: TripPlanSnapshot = {
  status: "confirmed",
  destination: "广州",
  startDate: "2026-08-12",
  days: 4,
  skeleton: [{ day: 1, theme: "亲子", spots: [{ name: "长隆" }] }],
  caveats: ["酒店价格为估算"],
  updatedTurnId: "t",
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
      return (
        [...rows]
          .filter((r) => r.userId === userId && r.status === "confirmed")
          .sort((a, b) => b.committedAt.getTime() - a.committedAt.getTime())[0] ?? null
      );
    },
    // 活动行程（M72-03）：内存版只按人过滤、按确认时间升序，上限 10 与仓储默认一致。
    async activeForUser(userId, _today, limit = 10) {
      return rows
        .filter((r) => r.userId === userId && r.status === "confirmed")
        .sort((a, b) => a.committedAt.getTime() - b.committedAt.getTime())
        .slice(0, limit);
    },
  } as TripPlanRepository;
}

/** 内存版核查仓储：只实现网关会碰的两个方法。 */
function memReviews(rows: StoredTripPlanReview[]): TripPlanReviewRepository {
  return {
    async insert() {
      throw new Error("端点只读，不该调它");
    },
    async latestForPlan(planId) {
      return rows.filter((r) => r.planId === planId).sort((a, b) => (a.reviewedAt < b.reviewedAt ? 1 : -1))[0] ?? null;
    },
    async latestForPlans(planIds) {
      const out = new Map<string, StoredTripPlanReview>();
      for (const id of planIds) {
        const hit = await this.latestForPlan(id);
        if (hit) out.set(id, hit);
      }
      return out;
    },
    async ack(userId, reviewId) {
      const hit = rows.find((r) => r.reviewId === reviewId && r.userId === userId);
      if (!hit) return null;
      if (!hit.ackedAt) hit.ackedAt = "2026-09-08T08:00:00.000Z";
      return hit;
    },
  };
}

const review = (over: Partial<StoredTripPlanReview> = {}): StoredTripPlanReview => ({
  reviewId: "r1",
  planId: "p1",
  userId: "demo-user",
  reviewedAt: "2026-08-11T22:10:00.000Z",
  signature: "cloudy|#-",
  days: [{ day: 1, date: "2026-08-12", kind: "cloudy", label: "多云" }],
  changes: [],
  severity: "none",
  ...over,
});

function appWith(
  repo: TripPlanRepository,
  userId: string | null,
  runtimeUrl?: string,
  reviews?: TripPlanReviewRepository,
) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createTripPlanRouter(repo, undefined, runtimeUrl, undefined, reviews));
  return app;
}

async function postAck(app: express.Express, planId: string, body: unknown) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/trip-plan/${planId}/review/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

async function get(app: express.Express, query = "") {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/trip-plan/current${query}`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

/**
 * 假的 runtime：记下两条重算各被调了几次，按 `reply` 决定回什么（undefined = 直接 500）。
 * `delayMs` 用来量"并发还是串行"——串行会让总耗时变成两条之和。
 */
function fakeRuntime(
  reply?: Record<string, unknown>,
  opts: { highlights?: Record<string, unknown>; delayMs?: number } = {},
) {
  let calls = 0;
  let highlightCalls = 0;
  const app = express();
  app.use(express.json());
  const later = (fn: () => void) =>
    opts.delayMs ? setTimeout(fn, opts.delayMs) : (fn(), undefined);
  app.post("/internal/trip/pretrip-refresh", (_req, res) => {
    calls += 1;
    later(() => {
      if (!reply) {
        res.status(500).json({ error: "boom" });
        return;
      }
      res.json(reply);
    });
  });
  app.post("/internal/trip/highlights-refresh", (_req, res) => {
    highlightCalls += 1;
    later(() => {
      if (!opts.highlights) {
        res.status(500).json({ error: "boom" });
        return;
      }
      res.json(opts.highlights);
    });
  });
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    get calls() {
      return calls;
    },
    get highlightCalls() {
      return highlightCalls;
    },
    close: () => server.close(),
  };
}

const HIGHLIGHTS = {
  destination: "广州",
  foods: [{ name: "陶陶居", note: "百年茶楼", sourceUrl: "https://a.com/x" }],
  spots: [{ name: "永庆坊", note: "骑楼老街" }],
  photoTips: [{ spot: "永庆坊", tip: "入夜拍月亮桥倒影" }],
  computedAt: "2026-08-28T02:00:00.000Z",
};

const row = (over: Partial<CommittedTripPlan> = {}): CommittedTripPlan => ({
  planId: "p1",
  userId: "demo-user",
  sessionId: "sess-1",
  status: "confirmed",
  plan: PLAN,
  committedAt: new Date("2026-08-11T10:00:00Z"),
  ...over,
});

describe("GET /v1/trip-plan/current", () => {
  it("未鉴权 401", async () => {
    const r = await get(appWith(memRepo([row()]), null));
    assert.equal(r.status, 401);
  });

  it("无行程 → 200 {plan:null}，不是 404", async () => {
    const r = await get(appWith(memRepo([]), "demo-user"));
    assert.equal(r.status, 200);
    assert.equal(r.body.plan, null);
  });

  it("有行程 → 快照 + committedAt；只认鉴权身份，别人的行程查不到", async () => {
    const rows = [row(), row({ planId: "p2", userId: "someone-else" })];
    const r = await get(appWith(memRepo(rows), "demo-user"));
    assert.equal(r.status, 200);
    assert.equal((r.body.plan as TripPlanSnapshot).destination, "广州");
    assert.equal(r.body.committedAt, "2026-08-11T10:00:00.000Z");
  });

  it("cancelled 之后回到 {plan:null}", async () => {
    const r = await get(appWith(memRepo([row({ status: "cancelled" })]), "demo-user"));
    assert.equal(r.body.plan, null);
  });

  it("取最新一条 confirmed（重复确认后 HUD 显示最后定的那份）", async () => {
    const older = row();
    const newer = row({
      planId: "p2",
      committedAt: new Date("2026-08-11T12:00:00Z"),
      plan: { ...PLAN, destination: "深圳" },
    });
    const r = await get(appWith(memRepo([older, newer]), "demo-user"));
    assert.equal((r.body.plan as TripPlanSnapshot).destination, "深圳");
  });
});

describe("打开 App 时按最新天气重算（M20-06）", () => {
  it("带 refreshPretrip=1：用 runtime 重算的物品与天气覆盖库里那份", async () => {
    const rt = fakeRuntime({
      pretripItems: [{ key: "umbrella", reason: "这一程有降雨" }],
      weather: { kind: "rain", label: "有雨" },
      computedAt: "2026-08-14T02:00:00.000Z",
    });
    try {
      const { status, body } = await get(
        appWith(memRepo([row()]), "demo-user", rt.url),
        "?refreshPretrip=1",
      );
      assert.equal(status, 200);
      const plan = body.plan as Record<string, unknown>;
      assert.deepEqual(plan.pretripItems, [{ key: "umbrella", reason: "这一程有降雨" }]);
      assert.deepEqual(plan.weather, { kind: "rain", label: "有雨" });
      // 行程本身一个字都不能被重算改掉——变的只有环境数据。
      assert.equal(plan.destination, "广州");
      assert.equal(body.pretripRefreshed, true);
      assert.equal(rt.calls, 1);
    } finally {
      rt.close();
    }
  });

  it("**runtime 挂了仍是 200 + 库里那份**（提示卡是配角，不能让 HUD 变成报错）", async () => {
    const rt = fakeRuntime(); // 500
    try {
      const { status, body } = await get(
        appWith(memRepo([row()]), "demo-user", rt.url),
        "?refreshPretrip=1",
      );
      assert.equal(status, 200);
      assert.equal((body.plan as Record<string, unknown>).destination, "广州");
      assert.equal(body.pretripRefreshed, false, "要能分辨这次是新算的还是库里的");
    } finally {
      rt.close();
    }
  });

  it("runtime 说 skipped（行程过期/重算失败）：同样回落库里那份", async () => {
    const rt = fakeRuntime({ skipped: "expired" });
    try {
      const { body } = await get(
        appWith(memRepo([row()]), "demo-user", rt.url),
        "?refreshPretrip=1",
      );
      assert.equal(body.pretripRefreshed, false);
    } finally {
      rt.close();
    }
  });

  it("**不带参数时一次 runtime 调用都不发**，响应形状与 M13-03 一字不差", async () => {
    const rt = fakeRuntime({ pretripItems: [{ key: "umbrella" }] });
    try {
      const { body } = await get(appWith(memRepo([row()]), "demo-user", rt.url));
      assert.equal(rt.calls, 0, "默认路径不能因为这条改行为——Rust 客户端在按 60 秒轮它");
      assert.equal(body.pretripRefreshed, undefined);
      assert.deepEqual(body.plan, PLAN);
    } finally {
      rt.close();
    }
  });
});

describe("目的地推荐的读时补齐（M32-02）", () => {
  it("带 refreshPretrip=1：推荐与物品一起回来，行程本身不变", async () => {
    const rt = fakeRuntime(
      { pretripItems: [{ key: "umbrella" }], weather: { kind: "rain", label: "有雨" } },
      { highlights: { destinationHighlights: HIGHLIGHTS } },
    );
    try {
      const { status, body } = await get(
        appWith(memRepo([row()]), "demo-user", rt.url),
        "?refreshPretrip=1",
      );
      assert.equal(status, 200);
      const plan = body.plan as Record<string, unknown>;
      assert.deepEqual(plan.destinationHighlights, HIGHLIGHTS);
      assert.deepEqual(plan.pretripItems, [{ key: "umbrella" }]);
      assert.equal(plan.destination, "广州", "行程本身一个字都不该被环境数据改掉");
      assert.equal(body.highlightsRefreshed, true);
      assert.equal(rt.highlightCalls, 1);
    } finally {
      rt.close();
    }
  });

  it("**两条重算并发，不串行**——串起来端上首帧要等两条之和", async () => {
    const rt = fakeRuntime(
      { pretripItems: [{ key: "umbrella" }] },
      { highlights: { destinationHighlights: HIGHLIGHTS }, delayMs: 300 },
    );
    try {
      const t0 = Date.now();
      const { body } = await get(
        appWith(memRepo([row()]), "demo-user", rt.url),
        "?refreshPretrip=1",
      );
      const elapsed = Date.now() - t0;
      assert.equal(body.highlightsRefreshed, true);
      assert.equal(body.pretripRefreshed, true);
      // 各 300ms：并发 ≈ 300ms，串行 ≈ 600ms。阈值取 500ms，两侧都留了余量。
      assert.ok(elapsed < 500, `两条重算应并发，实测 ${elapsed}ms（串行会 ≥600ms）`);
    } finally {
      rt.close();
    }
  });

  it("推荐失败不牵连物品：物品照常合进回包，highlightsRefreshed=false", async () => {
    const rt = fakeRuntime({ pretripItems: [{ key: "umbrella" }] }); // highlights 未给 → 500
    try {
      const { body } = await get(
        appWith(memRepo([row()]), "demo-user", rt.url),
        "?refreshPretrip=1",
      );
      const plan = body.plan as Record<string, unknown>;
      assert.deepEqual(plan.pretripItems, [{ key: "umbrella" }]);
      assert.equal(plan.destinationHighlights, undefined, "没搜到就是没有，不给空对象");
      assert.equal(body.highlightsRefreshed, false);
      assert.equal(body.pretripRefreshed, true);
    } finally {
      rt.close();
    }
  });

  it("runtime 说 skipped（过期 / 三段全空 / 失败）：一律当没有推荐", async () => {
    for (const skipped of ["expired", "empty", "failed"]) {
      const rt = fakeRuntime({ pretripItems: [] }, { highlights: { skipped } });
      try {
        const { body } = await get(
          appWith(memRepo([row()]), "demo-user", rt.url),
          "?refreshPretrip=1",
        );
        assert.equal(body.highlightsRefreshed, false, `skipped=${skipped}`);
        assert.equal((body.plan as Record<string, unknown>).destinationHighlights, undefined);
      } finally {
        rt.close();
      }
    }
  });

  it("**不带参数时推荐这条也一次都不发**，回的就是库里那份", async () => {
    const rt = fakeRuntime({ pretripItems: [] }, { highlights: { destinationHighlights: HIGHLIGHTS } });
    try {
      const { body } = await get(appWith(memRepo([row()]), "demo-user", rt.url));
      assert.equal(rt.highlightCalls, 0);
      assert.equal(body.highlightsRefreshed, undefined);
      assert.deepEqual(body.plan, PLAN, "默认路径回的就是库里那份，一字不多");
    } finally {
      rt.close();
    }
  });

  /*
   * M32-02 修订：推荐改为确认/变更后由 runtime 后台算好并**落库**。
   * 于是这条读时补齐降级成兜底——库里有就不该再烧一次按次计费的联网搜索。
   */
  it("库里已有推荐：**一次搜索都不发**，照样原样回给端上", async () => {
    const stored = { ...PLAN, destinationHighlights: HIGHLIGHTS };
    const rt = fakeRuntime({ pretripItems: [] }, { highlights: { destinationHighlights: HIGHLIGHTS } });
    try {
      const { body } = await get(
        appWith(memRepo([row({ plan: stored })]), "demo-user", rt.url),
        "?refreshPretrip=1",
      );
      assert.equal(rt.highlightCalls, 0, "库里那份就是它算出来的，再打一次只是白烧一次搜索");
      assert.deepEqual(
        (body.plan as Record<string, unknown>).destinationHighlights,
        HIGHLIGHTS,
        "不发那一跳不等于端上拿不到——它来自库里",
      );
      assert.equal(body.highlightsFromStore, true);
      assert.equal(body.highlightsRefreshed, false);
    } finally {
      rt.close();
    }
  });

  it("库里没有（老行程 / 后台那次没算成）：兜底那一跳照发", async () => {
    const rt = fakeRuntime({ pretripItems: [] }, { highlights: { destinationHighlights: HIGHLIGHTS } });
    try {
      const { body } = await get(
        appWith(memRepo([row()]), "demo-user", rt.url),
        "?refreshPretrip=1",
      );
      assert.equal(rt.highlightCalls, 1);
      assert.equal(body.highlightsFromStore, false);
      assert.equal(body.highlightsRefreshed, true);
    } finally {
      rt.close();
    }
  });
});

describe("活动行程列表与每程核查（M72-03）", () => {
  it("无行程 → plans 是空数组，plan 仍是 null（老字段一字不变）", async () => {
    const r = await get(appWith(memRepo([]), "demo-user"));
    assert.equal(r.status, 200);
    assert.equal(r.body.plan, null);
    assert.deepEqual(r.body.plans, []);
    assert.equal("review" in r.body, false);
  });

  it("两份活动行程 + 一份核查：只有那份带 review；review 字段等于当前行程那份；updatedAt 回退到 committedAt", async () => {
    const rows = [row(), row({ planId: "p2", committedAt: new Date("2026-08-11T12:00:00Z") })];
    const reviews = memReviews([review({ planId: "p2", reviewId: "r2" })]);
    const r = await get(appWith(memRepo(rows), "demo-user", undefined, reviews));
    assert.equal(r.status, 200);
    const plans = r.body.plans as Array<Record<string, unknown>>;
    assert.equal(plans.length, 2);
    const p1 = plans.find((p) => p.planId === "p1")!;
    const p2 = plans.find((p) => p.planId === "p2")!;
    assert.equal("review" in p1, false);
    assert.equal((p2.review as Record<string, unknown>).reviewId, "r2");
    assert.equal("userId" in (p2.review as Record<string, unknown>), false, "落库行的 userId / signature 不该回给端上");
    assert.equal(p2.updatedAt, "2026-08-11T12:00:00.000Z");
    // 当前行程 = 最新确认的 p2，它的核查也挂在顶层 review
    assert.equal((r.body.review as Record<string, unknown>).reviewId, "r2");
  });

  it("不传核查仓储：plans 每项无 review，ack 回 503", async () => {
    const r = await get(appWith(memRepo([row()]), "demo-user"));
    const plans = r.body.plans as Array<Record<string, unknown>>;
    assert.equal(plans.length, 1);
    assert.equal("review" in plans[0]!, false);
    const a = await postAck(appWith(memRepo([row()]), "demo-user"), "p1", { reviewId: "r1" });
    assert.equal(a.status, 503);
  });

  it("11 份活动行程只回 10 份（列表上限）", async () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      row({ planId: `p${i}`, committedAt: new Date(Date.UTC(2026, 7, 1 + i)) }),
    );
    const r = await get(appWith(memRepo(rows), "demo-user"));
    assert.equal((r.body.plans as unknown[]).length, 10);
  });

  it("别人的行程不进列表", async () => {
    const rows = [row(), row({ planId: "p-other", userId: "someone-else" })];
    const r = await get(appWith(memRepo(rows), "demo-user"));
    assert.deepEqual((r.body.plans as Array<{ planId: string }>).map((p) => p.planId), ["p1"]);
  });
});

describe("POST /v1/trip-plan/:planId/review/ack（M72-03）", () => {
  it("未鉴权 401", async () => {
    const a = await postAck(appWith(memRepo([row()]), null, undefined, memReviews([review()])), "p1", { reviewId: "r1" });
    assert.equal(a.status, 401);
  });

  it("缺 reviewId → 400", async () => {
    const a = await postAck(appWith(memRepo([row()]), "demo-user", undefined, memReviews([review()])), "p1", {});
    assert.equal(a.status, 400);
  });

  it("错 userId → 404；planId 对不上这份核查 → 404", async () => {
    const reviews = memReviews([review()]);
    const wrongUser = await postAck(appWith(memRepo([row()]), "someone-else", undefined, reviews), "p1", { reviewId: "r1" });
    assert.equal(wrongUser.status, 404);
    const wrongPlan = await postAck(appWith(memRepo([row()]), "demo-user", undefined, reviews), "p-other", { reviewId: "r1" });
    assert.equal(wrongPlan.status, 404);
  });

  it("正确 → 200 且 ackedAt 非空；重复 ack → 200 同一时间", async () => {
    const reviews = memReviews([review()]);
    const first = await postAck(appWith(memRepo([row()]), "demo-user", undefined, reviews), "p1", { reviewId: "r1" });
    assert.equal(first.status, 200);
    const acked = (first.body.review as Record<string, unknown>).ackedAt;
    assert.ok(acked);
    const again = await postAck(appWith(memRepo([row()]), "demo-user", undefined, reviews), "p1", { reviewId: "r1" });
    assert.equal(again.status, 200);
    assert.equal((again.body.review as Record<string, unknown>).ackedAt, acked);
  });
});
