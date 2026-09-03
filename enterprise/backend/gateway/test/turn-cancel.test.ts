/**
 * 打断这一轮：网关侧（施工单 M33-01，F-08-08 / F-14-04）。
 *
 * 四件事，每一件都对应一条曾经想反了的判断：
 *
 *  1. **被打断的助手半句照常落库，只是标 `cancelled`。** 工单初稿写的是"不落库"，
 *     理由是"污染下一轮上下文"——那是把模型上下文（LangGraph 检查点）和权威历史（PG）
 *     混为一谈了。AC-08-6 明写"已产生内容不丢失"。
 *  2. **一个字都没吐就被取消 → 不落库。** 空消息只是噪声。
 *  3. **被打断的一轮不给会话起名字。** 半句话不配当标题，与 `retracted` 同一条理由。
 *  4. **未命中不是错误**：runtime 回 `turnId: null` 时网关照样 200，
 *     并且**立刻**推一条 `state: idle`——端上此刻已经不出声了，状态却还挂在 speaking。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import express from "express";

import { createHttpRouter } from "../src/http";
import { SessionBus } from "../src/stream/session-bus";

interface Row {
  userId: string;
  title: string | null;
  closedAt: Date | null;
  updatedAt: Date;
}

interface Appended {
  messageId: string;
  role: string;
  content: string;
  cancelled?: boolean;
}

/** 这一轮 runtime 该吐哪些事件（NDJSON 每行一条）。 */
let turnLines: string[] = [];
/** runtime 的 cancel 端点该回什么。 */
let cancelReply: { cancelled: boolean; turnId: string | null; sideEffectInFlight: boolean } | "500" = {
  cancelled: true,
  turnId: "t1",
  sideEffectInFlight: false,
};
let cancelCalls: Array<{ url: string; body: unknown }> = [];
let titleCalls = 0;
let appended: Appended[] = [];
/** turn 端点在被放行之前挂住——好让测试有机会在"这一轮还在跑"时发取消。 */
let releaseTurn: (() => void) | undefined;

const realFetch = globalThis.fetch;

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.endsWith("/cancel")) {
      cancelCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      if (cancelReply === "500") return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(cancelReply), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/title")) {
      titleCalls += 1;
      return new Response(JSON.stringify({ title: "某个名字" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/turn")) {
      // 事件流挂到 releaseTurn 被调用为止：这样取消才能落在"轮还在跑"的窗口里。
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseTurn = () => {
            controller.enqueue(new TextEncoder().encode(`${turnLines.join("\n")}\n`));
            controller.close();
          };
        },
      });
      return new Response(body, { status: 200 });
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
    async closeSession() {
      return null;
    },
    async appendMessage(m: Appended) {
      appended.push(m);
    },
    async createSession() {},
    async historyPage() {
      return { messages: [], hasMore: false, nextBefore: null };
    },
    // M48-05：发消息时归属取会话的（车机上请求里没有人）。桩里回 demo 身份。
    async sessionUserId() {
      return "demo-user";
    },
    async sessionTitle() {
      return null;
    },
    async setSessionTitle() {
      return true;
    },
    async userSessionPage() {
      return { sessions: [], hasMore: false, nextCursor: null };
    },
  } as never;
}

function appWith(rows: Map<string, Row>, bus: SessionBus) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = "u1";
    next();
  });
  app.use(createHttpRouter(fakeRepo(rows), bus, { transcribe: async () => "x" } as never));
  return app;
}

async function call(
  app: express.Express,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await realFetch(`http://127.0.0.1:${port}${path}`, {
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

/** 等 fire-and-forget 的那条链跑完（它不 await，只能轮询）。 */
async function settle(check: () => boolean, ms = 1500): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

const activeRow = (): Row => ({ userId: "u1", title: null, closedAt: null, updatedAt: new Date() });

beforeEach(() => {
  turnLines = [];
  cancelCalls = [];
  titleCalls = 0;
  appended = [];
  releaseTurn = undefined;
  cancelReply = { cancelled: true, turnId: "t1", sideEffectInFlight: false };
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("[M33-01][AC-08-6] 被打断的一轮怎么落库", () => {
  it("已产生的半句照常落库，标 cancelled；不给会话起名字", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const bus = new SessionBus();
    const app = appWith(rows, bus);

    const accepted = await call(app, "POST", "/v1/session/s1/messages", { content: "帮我规划三天" });
    const turnId = String(accepted.body.turnId);
    turnLines = [
      JSON.stringify({ type: "update", kind: "delta", turnId, text: "第一天先去" }),
      JSON.stringify({ type: "update", kind: "turn_end", turnId, messageId: "m-assist" }),
    ];
    cancelReply = { cancelled: true, turnId, sideEffectInFlight: false };

    // 轮还挂着的时候打断
    await settle(() => releaseTurn !== undefined);
    const cancelled = await call(app, "POST", "/v1/session/s1/cancel", {});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.turnId, turnId);

    releaseTurn!();
    await settle(() => appended.some((m) => m.role === "assistant"));

    const assistant = appended.find((m) => m.role === "assistant");
    assert.ok(assistant, "助手那条必须在——AC-08-6：已产生内容不丢失");
    assert.equal(assistant!.content, "第一天先去", "内容就是被截断的那半句");
    assert.equal(assistant!.cancelled, true, "标出来，否则读起来像是好端端说了一半");
    assert.equal(titleCalls, 0, "半句话不配给这段对话起名字");
  });

  it("一个字都没吐就被取消：助手消息不落库（空消息只是噪声）", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const app = appWith(rows, new SessionBus());

    const accepted = await call(app, "POST", "/v1/session/s1/messages", { content: "帮我规划三天" });
    const turnId = String(accepted.body.turnId);
    turnLines = [JSON.stringify({ type: "update", kind: "turn_end", turnId, messageId: "m-assist" })];
    cancelReply = { cancelled: true, turnId, sideEffectInFlight: false };

    await settle(() => releaseTurn !== undefined);
    await call(app, "POST", "/v1/session/s1/cancel", {});
    releaseTurn!();

    // 给 fire-and-forget 一点时间，然后断言"就是没有"
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(appended.filter((m) => m.role === "assistant").length, 0);
    assert.equal(appended.filter((m) => m.role === "user").length, 1, "用户那条照常在");
  });

  it("没被打断的一轮：既不标 cancelled，也照常起名字（对照组）", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const app = appWith(rows, new SessionBus());

    const accepted = await call(app, "POST", "/v1/session/s1/messages", { content: "明天天气" });
    const turnId = String(accepted.body.turnId);
    turnLines = [
      JSON.stringify({ type: "update", kind: "delta", turnId, text: "明天多云。" }),
      JSON.stringify({ type: "update", kind: "turn_end", turnId, messageId: "m-assist" }),
    ];

    await settle(() => releaseTurn !== undefined);
    releaseTurn!();
    await settle(() => titleCalls > 0);

    const assistant = appended.find((m) => m.role === "assistant");
    assert.equal(assistant?.cancelled, undefined);
    assert.equal(titleCalls, 1);
  });
});

describe("[M33-01][AC-14-4] 取消端点的语义", () => {
  it("未命中任何轮：200 + turnId=null，**不是 404**", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const app = appWith(rows, new SessionBus());
    cancelReply = { cancelled: true, turnId: null, sideEffectInFlight: false };

    const r = await call(app, "POST", "/v1/session/s1/cancel", {});

    assert.equal(r.status, 200);
    assert.equal(r.body.cancelled, true);
    assert.equal(r.body.turnId, null);
  });

  it("会话不存在才是 404", async () => {
    const app = appWith(new Map(), new SessionBus());
    const r = await call(app, "POST", "/v1/session/nope/cancel", {});
    assert.equal(r.status, 404);
    assert.equal(cancelCalls.length, 0, "会话都不存在，不该去打扰 runtime");
  });

  it("sideEffectInFlight 原样透传——不许在网关抹成「已取消」", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const app = appWith(rows, new SessionBus());
    cancelReply = { cancelled: true, turnId: "t9", sideEffectInFlight: true };

    const r = await call(app, "POST", "/v1/session/s1/cancel", {});

    assert.equal(r.body.sideEffectInFlight, true);
  });

  it("runtime 不可达：照样 200——端上的声音已经停了，报错他也处置不了", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const app = appWith(rows, new SessionBus());
    cancelReply = "500";

    const r = await call(app, "POST", "/v1/session/s1/cancel", {});

    assert.equal(r.status, 200);
    assert.equal(r.body.turnId, null);
  });

  it("取消当场推一条 state:idle——不等 runtime 那条 turn_end", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const bus = new SessionBus();
    const app = appWith(rows, bus);
    cancelReply = { cancelled: true, turnId: "t9", sideEffectInFlight: false };

    const seen: Array<{ type: string; kind?: string; state?: string }> = [];
    const off = bus.subscribe("s1", null, (env) =>
      seen.push(env.event as unknown as { type: string; kind?: string; state?: string }),
    );

    await call(app, "POST", "/v1/session/s1/cancel", {});
    off();

    const idle = seen.filter((e) => e.type === "update" && e.kind === "state" && e.state === "idle");
    assert.equal(idle.length, 1);
  });

  it("带 turnId 时原样转给 runtime", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const app = appWith(rows, new SessionBus());

    await call(app, "POST", "/v1/session/s1/cancel", { turnId: "turn-abc" });

    assert.deepEqual(cancelCalls[0]?.body, { turnId: "turn-abc" });
  });
});
