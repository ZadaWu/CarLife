/**
 * ⑥用车流水上报入口（M11-01）。
 *
 * 这份测试盯的是三种"落库成功但数据是错的"结局——它们都不报错：
 * 越权写到别人账下、重试变成两条行程、整批因一条脏数据被拒后端上无限重试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { TripInput, TripStore, StoredTrip } from "@carlife/memory";

import { createTelemetryRouter, MAX_BATCH } from "../src/telemetry";

/** 内存 TripStore，`append` 保持与 Prisma 实现一致的 upsert 语义。 */
function memoryStore() {
  const rows = new Map<string, TripInput & { id: string }>();
  const store: TripStore = {
    async append(trip) {
      rows.set(trip.id, trip);
    },
    async range(userId, from, to) {
      return [...rows.values()].filter(
        (r) => r.userId === userId && r.endedAt >= from && r.endedAt <= to,
      ) as StoredTrip[];
    },
  };
  return { store, rows };
}

/** 起一个只挂 telemetry 路由的 app，userId 由测试注入（模拟 demoAuth）。 */
function appWith(store: TripStore, userId: string | null = "u-real") {
  const app = express();
  app.use((req, _res, next) => {
    // 用 null 表示"未鉴权"。**不能用 undefined**——JS 的默认参数会把显式传入的
    // undefined 替换成默认值，那条"没有身份就拒绝"的测试会静默地在测有身份的路径。
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createTelemetryRouter(store));
  return app;
}

async function post(app: express.Express, body: unknown) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/telemetry/trips`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const trip = (over: Partial<TripInput & { id: string }> = {}) => ({
  id: "t-1",
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_600_000,
  distanceKm: 12.5,
  roadType: "city" as const,
  ...over,
});

describe("⑥流水上报：归属只认鉴权上下文", () => {
  it("**请求体里的 userId 被丢弃**——否则任何客户端都能往别人账下写流水", async () => {
    const { store, rows } = memoryStore();
    const r = await post(appWith(store, "u-real"), {
      trips: [{ ...trip(), userId: "u-victim" }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.accepted, 1);
    assert.equal([...rows.values()][0].userId, "u-real", "必须落在鉴权身份名下");
  });

  it("没有鉴权身份时拒绝落库", async () => {
    const { store, rows } = memoryStore();
    const r = await post(appWith(store, null), { trips: [trip()] });
    assert.equal(r.status, 401);
    assert.equal(rows.size, 0);
  });
});

describe("⑥流水上报：幂等", () => {
  it("**同一条连发三次只有一行**——重复行程会把日均里程直接算成两倍", async () => {
    const { store, rows } = memoryStore();
    const app = appWith(store);
    for (let i = 0; i < 3; i += 1) await post(app, { trips: [trip()] });
    assert.equal(rows.size, 1);
  });

  it("缺 id 直接拒绝，不代生成", async () => {
    const { store, rows } = memoryStore();
    const { id: _drop, ...noId } = trip();
    const r = await post(appWith(store), { trips: [noId] });
    assert.equal(r.body.accepted, 0);
    assert.equal(rows.size, 0);
    assert.match(String((r.body.rejected as Array<{ reason: string }>)[0].reason), /id 必须由端上生成/);
  });
});

describe("⑥流水上报：部分成功", () => {
  it("**一条非法不让整批失败**——整批拒绝会让端上无限重试同一批", async () => {
    const { store, rows } = memoryStore();
    const r = await post(appWith(store), {
      trips: [
        trip({ id: "ok-1" }),
        trip({ id: "bad-1", distanceKm: -3 }),
        trip({ id: "ok-2", startedAt: 1_700_000_700_000, endedAt: 1_700_000_900_000 }),
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.accepted, 2);
    assert.equal((r.body.rejected as unknown[]).length, 1);
    assert.equal(rows.size, 2);
  });

  it("拒绝原因要指出是哪条规则——「数据非法」让端上无从修起", async () => {
    const { store } = memoryStore();
    const r = await post(appWith(store), {
      // 放电不是充电：endSoc < startSoc
      trips: [trip({ id: "bad", charge: { startSoc: 80, endSoc: 30, at: 1_700_000_100_000 } })],
    });
    const reason = String((r.body.rejected as Array<{ reason: string }>)[0].reason);
    assert.match(reason, /charge\.endSoc/);
    assert.match(reason, /放电/);
  });

  it("服务端不替端上补默认值：非法就是拒绝，不猜一个值洗干净", async () => {
    const { store, rows } = memoryStore();
    await post(appWith(store), { trips: [trip({ id: "x", roadType: "offroad" as never })] });
    assert.equal(rows.size, 0);
  });
});

describe("⑥流水上报：批次边界", () => {
  it("空批与非数组返回 400", async () => {
    const { store } = memoryStore();
    assert.equal((await post(appWith(store), { trips: [] })).status, 400);
    assert.equal((await post(appWith(store), {})).status, 400);
  });

  it(`超过 ${MAX_BATCH} 条返回 413`, async () => {
    const { store, rows } = memoryStore();
    const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => trip({ id: `t-${i}` }));
    const r = await post(appWith(store), { trips: many });
    assert.equal(r.status, 413);
    assert.equal(rows.size, 0, "超限时一条都不该落库");
  });
});
