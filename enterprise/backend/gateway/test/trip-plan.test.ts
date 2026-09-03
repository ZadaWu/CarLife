/**
 * 已确认行程只读端点（M13-03）。
 *
 * 盯两件事：归属只认鉴权身份（查错人不报错，只是把别人的行程端上了 HUD）；
 * 「还没确认过」是常态——必须 200 {plan:null}，404 会让轮询端反复告警。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { TripPlanRepository, CommittedTripPlan } from "@carlife/db";
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
  };
}

function appWith(repo: TripPlanRepository, userId: string | null, runtimeUrl?: string) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createTripPlanRouter(repo, undefined, runtimeUrl));
  return app;
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
