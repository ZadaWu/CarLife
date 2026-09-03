/**
 * 会话空闲过期与主动关闭（施工单 M22-01，F-07-09）。
 *
 * 这份测试盯三件事：
 *
 *  1. **边界不能错方向。** 正好卡在阈值上算没过期——错一格的代价是
 *     "刚好半小时那次白说了"，而车主不会知道发生了什么。
 *  2. **软关闭不删历史。** 关掉的是"还能不能接着说"，不是"还能不能翻阅"。
 *     `GET /messages` 对已关闭会话必须照常 200——这条最容易被后人"顺手"加个 404 破掉。
 *  3. **过期要落定。** 判出过期就得写 `closedAt`，否则运营页上看不出这个会话已经结束，
 *     而它再也收不了消息了。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import express from "express";

import { SESSION_EXPIRED } from "@carlife/shared";

import { createHttpRouter, sessionIdleMs } from "../src/http";
import { SessionBus } from "../src/stream/session-bus";

const MIN = 60_000;

interface Row {
  closedAt: Date | null;
  updatedAt: Date;
}

/** 只实现本单用得到的那几个方法；其余按用不到处理。 */
function fakeRepo(rows: Map<string, Row>) {
  return {
    async sessionExists(id: string) {
      return rows.has(id);
    },
    async sessionState(id: string) {
      const r = rows.get(id);
      if (!r) return { exists: false, closedAt: null, lastActiveAt: null };
      return { exists: true, closedAt: r.closedAt, lastActiveAt: r.updatedAt };
    },
    async closeSession(id: string, at: Date) {
      const r = rows.get(id);
      if (!r) return null;
      // 幂等：已关闭的不改 closedAt
      if (!r.closedAt) r.closedAt = at;
      return r.closedAt;
    },
    async historyPage() {
      return { messages: [{ messageId: "m1" }], hasMore: false, nextBefore: null };
    },
    async appendMessage() {},
    async createSession() {},
    // M48-05：发消息时归属取会话的（车机上请求里没有人）。
    async sessionUserId() {
      return "demo-user";
    },
  } as never;
}

function appWith(rows: Map<string, Row>) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = "u1";
    next();
  });
  app.use(createHttpRouter(fakeRepo(rows), new SessionBus(), { transcribe: async () => "x" } as never));
  return app;
}

async function call(
  rows: Map<string, Row>,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = appWith(rows).listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const activeAgo = (minutesAgo: number): Map<string, Row> =>
  new Map([["s1", { closedAt: null, updatedAt: new Date(Date.now() - minutesAgo * MIN) }]]);

beforeEach(() => {
  delete process.env.CARLIFE_SESSION_IDLE_MIN;
});

describe("空闲阈值", () => {
  it("默认 30 分钟", () => {
    assert.equal(sessionIdleMs(), 30 * MIN);
  });

  it("可由 CARLIFE_SESSION_IDLE_MIN 覆盖", () => {
    process.env.CARLIFE_SESSION_IDLE_MIN = "5";
    assert.equal(sessionIdleMs(), 5 * MIN);
  });

  it("**非法值回落默认**——配成 0 等于每条消息都判过期，整个对话功能停摆", () => {
    for (const bad of ["0", "-1", "abc", ""]) {
      process.env.CARLIFE_SESSION_IDLE_MIN = bad;
      assert.equal(sessionIdleMs(), 30 * MIN, `「${bad}」应回落默认`);
    }
  });
});

describe("POST /messages：过期就不收", () => {
  it("29 分钟前活跃 → 照常受理", async () => {
    const rows = activeAgo(29);
    const r = await call(rows, "POST", "/v1/session/s1/messages", { content: "你好" });
    assert.notEqual(r.status, 409, "29 分钟不该过期");
    assert.equal(rows.get("s1")!.closedAt, null);
  });

  /**
   * 边界错一格的代价是"刚好半小时那次白说了"。写 `>` 不是 `>=`，并在这里钉住。
   * 用 29.99 而不是整 30：整 30 在测试里跑到判定那一行时已经过去几毫秒了，
   * 那样断的是"时钟快慢"不是"边界方向"。
   */
  it("**正好卡在阈值上算没过期**（严格大于）", async () => {
    const rows = new Map([["s1", { closedAt: null, updatedAt: new Date(Date.now() - 30 * MIN + 500) }]]);
    const r = await call(rows, "POST", "/v1/session/s1/messages", { content: "你好" });
    assert.notEqual(r.status, 409);
  });

  it("31 分钟前 → 409 session_expired，**且会话被标记关闭**", async () => {
    const rows = activeAgo(31);
    const r = await call(rows, "POST", "/v1/session/s1/messages", { content: "你好" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, SESSION_EXPIRED);
    assert.ok(rows.get("s1")!.closedAt, "判出过期就要落定——不落定的话运营页看不出它已经结束了");
  });

  it("**409 不是 404**——排障时要分得清「过期了」和「id 传错了」", async () => {
    assert.equal((await call(activeAgo(31), "POST", "/v1/session/s1/messages", { content: "x" })).status, 409);
    assert.equal((await call(activeAgo(1), "POST", "/v1/session/没这个/messages", { content: "x" })).status, 404);
  });

  it("已关闭的会话 → 409（不管它多新）", async () => {
    const rows = new Map([["s1", { closedAt: new Date(), updatedAt: new Date() }]]);
    const r = await call(rows, "POST", "/v1/session/s1/messages", { content: "你好" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, SESSION_EXPIRED);
  });
});

describe("POST /close：软关闭", () => {
  it("关掉并回 closedAt", async () => {
    const rows = activeAgo(1);
    const r = await call(rows, "POST", "/v1/session/s1/close", {});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(typeof r.body.closedAt === "number");
    assert.ok(rows.get("s1")!.closedAt);
  });

  /**
   * 幂等是必须的而不是讲究：端上「退下」会被连点，网络重试也会重发。
   * `closedAt` 被后一次覆盖之后，就再也说不清这段对话何时结束的。
   */
  it("**幂等**：连关两次，第二次仍 200 且 closedAt 不变", async () => {
    const rows = activeAgo(1);
    const first = await call(rows, "POST", "/v1/session/s1/close", {});
    const second = await call(rows, "POST", "/v1/session/s1/close", {});
    assert.equal(second.status, 200);
    assert.equal(second.body.closedAt, first.body.closedAt);
  });

  it("不存在的会话 → 404", async () => {
    assert.equal((await call(new Map(), "POST", "/v1/session/没这个/close", {})).status, 404);
  });
});

/**
 * 设计定稿 D4：软关闭只关"能不能接着说"，不关"能不能翻阅"。
 * 这一组是**守卫**——给 `GET /messages` 加一句"关了就 404"看起来很顺手，
 * 实际是把车主的历史弄丢了。
 */
describe("GET /messages：关了也照常给历史（D4 守卫）", () => {
  it("已关闭会话仍 200 且历史还在", async () => {
    const rows = new Map([["s1", { closedAt: new Date(), updatedAt: new Date() }]]);
    const r = await call(rows, "GET", "/v1/session/s1/messages");
    assert.equal(r.status, 200, "关掉的是能不能接着说，不是能不能翻阅");
    assert.equal((r.body.messages as unknown[]).length, 1);
  });

  it("过期（未显式关闭）的会话同样给历史", async () => {
    const r = await call(activeAgo(999), "GET", "/v1/session/s1/messages");
    assert.equal(r.status, 200);
  });

  it("**响应形状没变**——HistoryPage 是 Rust 契约生成物，本单刻意没动它", async () => {
    const r = await call(activeAgo(1), "GET", "/v1/session/s1/messages");
    assert.deepEqual(Object.keys(r.body).sort(), ["hasMore", "messages", "nextBefore"]);
  });
});
