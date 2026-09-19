/**
 * 账号级事件通道（ACR-031）——`GET /v1/events`。
 *
 * 这条通道存在的理由是一个真实现象：车主在手机端聊完，走到车机上，
 * 那段对话不在会话列表里（2026-09-12）。服务端一直有数据，是**协议里没有
 * 一层能表达"你的另一个端刚做了什么"**。所以这份测试盯的不是"代码跑通了"，
 * 而是那条链上每一段都不会悄悄断：
 *
 *  1. **发一轮消息，另一条连接要收到**——这是整条通道的存在意义，端到端走真 HTTP。
 *  2. **连上先对齐**。少了这一条，重连之后到下一次变动之前，列表一直是旧的。
 *  3. **没声明谁在用车时回 400 而不是空流**。空流看起来像"同步坏了"，
 *     而真实原因是车辆级 token 还没声明上车，两者的修法完全不同。
 *  4. **不写 `id:` 行**。写了的话浏览器 `EventSource` 会记成 `lastEventId`，
 *     重连带回来一个本通道根本不认识的游标。
 *  5. **断开要退订干净**。这张表的键是用户，泄漏会随注册用户数单调增长。
 *  6. **开关关掉就等于没有这条通道**（不用发版的回滚手段）。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import express from "express";

import { createHttpRouter } from "../src/http";
import { createStreamRouter } from "../src/stream";
import { SessionBus } from "../src/stream/session-bus";
import { UserBus } from "../src/stream/user-bus";

interface Row {
  userId: string;
  title: string | null;
  closedAt: Date | null;
  updatedAt: Date;
}

const realFetch = globalThis.fetch;

/** runtime 的两个内部端点：一轮回复 + 起名字。 */
function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.endsWith("/title")) {
      return new Response(JSON.stringify({ title: "充电口位置" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/turn")) {
      const lines = [
        JSON.stringify({ type: "update", kind: "delta", turnId: "t1", text: "在车尾左侧。" }),
        JSON.stringify({ type: "update", kind: "turn_end", turnId: "t1", messageId: "m1" }),
      ];
      return new Response(`${lines.join("\n")}\n`, { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

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
      r.closedAt ??= at;
      return r.closedAt;
    },
    async appendMessage() {},
    async createSession() {},
    async historyPage() {
      return { messages: [], hasMore: false, nextBefore: null };
    },
    async sessionUserId(id: string) {
      return rows.get(id)?.userId ?? null;
    },
    async sessionTitle(id: string) {
      const r = rows.get(id);
      return r ? r.title : undefined;
    },
    async setSessionTitle(id: string, title: string) {
      const r = rows.get(id);
      if (!r || r.title !== null) return false;
      r.title = title;
      return true;
    },
    async userSessionPage() {
      return { sessions: [], hasMore: false, nextCursor: null };
    },
  } as never;
}

/** `userId = null` 模拟车辆级 token 还没声明上车。 */
function appWith(rows: Map<string, Row>, userBus: UserBus, userId: string | null) {
  const bus = new SessionBus();
  const app = express();
  app.use((req, _res, next) => {
    if (userId !== null) (req as express.Request & { userId?: string }).userId = userId;
    next();
  });
  app.use(createStreamRouter(fakeRepo(rows), bus, userBus));
  app.use(
    createHttpRouter(
      fakeRepo(rows),
      bus,
      { transcribe: async () => "x" } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      userBus,
    ),
  );
  return app;
}

interface Live {
  port: number;
  /** 已收到的事件（`data:` 行解析出来的）。 */
  events: Array<{ kind: string; reason: string; sessionId?: string }>;
  /** 原始帧文本，用来断言「没有 id: 行」。 */
  raw: string;
  close(): Promise<void>;
}

/** 起服务、开一条 `/v1/events`、把帧持续收进数组。 */
async function openChannel(app: express.Express): Promise<Live> {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const controller = new AbortController();
  const live: Live = {
    port,
    events: [],
    raw: "",
    async close() {
      controller.abort();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  const res = await realFetch(`http://127.0.0.1:${port}/v1/events`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  void (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const text = decoder.decode(value, { stream: true });
        live.raw += text;
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const env = JSON.parse(line.slice(6)) as {
            event: { kind: string; reason: string; sessionId?: string };
          };
          live.events.push(env.event);
        }
      }
    } catch {
      /* abort 时正常结束 */
    }
  })();
  return live;
}

/** 等到某个 reason 出现；超时就返回 false（调用方给出可读的断言信息）。 */
async function waitFor(live: Live, reason: string, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (live.events.some((e) => e.reason === reason)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

async function post(port: number, path: string, body: unknown): Promise<number> {
  const r = await realFetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.status;
}

const activeRow = (userId = "u1"): Row => ({
  userId,
  title: null,
  closedAt: null,
  updatedAt: new Date(),
});

beforeEach(() => {
  delete process.env.ACCOUNT_EVENTS_ENABLED;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ACCOUNT_EVENTS_ENABLED;
});

describe("[ACR-031] 账号级事件通道", () => {
  it("连上先收到一条 connected——重连即对齐是通道自带的语义，不靠每个端各写一遍", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const live = await openChannel(appWith(rows, new UserBus(), "u1"));
    try {
      assert.ok(await waitFor(live, "connected"), "连上之后没有收到对齐事件");
      assert.equal(live.events[0].kind, "sessions_changed");
    } finally {
      await live.close();
    }
  });

  it("另一个端发了一轮消息，这条连接要收到 message——这是整条通道的存在意义", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const live = await openChannel(appWith(rows, new UserBus(), "u1"));
    try {
      assert.equal(await post(live.port, "/v1/session/s1/messages", { content: "充电口在哪" }), 202);
      assert.ok(
        await waitFor(live, "message"),
        `发完消息没收到 message，收到的是 ${JSON.stringify(live.events)}`,
      );
      const evt = live.events.find((e) => e.reason === "message");
      assert.equal(evt?.sessionId, "s1");
    } finally {
      await live.close();
    }
  });

  it("关闭会话也要推——列表里那条要变成「已结束」", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const live = await openChannel(appWith(rows, new UserBus(), "u1"));
    try {
      assert.equal(await post(live.port, "/v1/session/s1/close", {}), 200);
      assert.ok(await waitFor(live, "closed"), "关闭会话没有推事件");
    } finally {
      await live.close();
    }
  });

  it("一条 `id:` 行都不写——写了的话 EventSource 会带一个本通道不认识的游标回来", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const live = await openChannel(appWith(rows, new UserBus(), "u1"));
    try {
      assert.ok(await waitFor(live, "connected"));
      assert.ok(!live.raw.includes("id: "), `帧里出现了 id: 行——${JSON.stringify(live.raw)}`);
    } finally {
      await live.close();
    }
  });

  it("没声明谁在用车时回 400，而不是一条永远不来事件的空流", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const app = appWith(rows, new UserBus(), null);
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const r = await realFetch(`http://127.0.0.1:${port}/v1/events`);
      assert.equal(r.status, 400);
      assert.equal(((await r.json()) as { error: string }).error, "active_user_required");
    } finally {
      server.close();
    }
  });

  it("开关关掉就等于没有这条通道（不用发版的回滚手段）", async () => {
    process.env.ACCOUNT_EVENTS_ENABLED = "false";
    const rows = new Map([["s1", activeRow()]]);
    const app = appWith(rows, new UserBus(), "u1");
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const r = await realFetch(`http://127.0.0.1:${port}/v1/events`);
      assert.equal(r.status, 503);
    } finally {
      server.close();
    }
  });

  it("断开之后订阅要清干净——这张表的键是用户，泄漏会随注册用户数单调增长", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const userBus = new UserBus();
    const live = await openChannel(appWith(rows, userBus, "u1"));
    assert.ok(await waitFor(live, "connected"));
    assert.equal(userBus.subscriberCount("u1"), 1);
    await live.close();
    const until = Date.now() + 2000;
    while (Date.now() < until && userBus.subscriberCount("u1") !== 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(userBus.subscriberCount("u1"), 0, "连接断了但订阅还挂着");
  });
});
