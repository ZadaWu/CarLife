/**
 * 会话标题的触发与落地（施工单 M28-01）。
 *
 * 这份测试盯四件最容易在后续改动里悄悄破掉的事：
 *
 *  1. **一个会话只起一次名字。** 已经有标题时连那次 LLM 调用都不该发出去——
 *     那是钱。只靠 DB 的条件更新兜底的话，第二轮第三轮每轮都要白烧一次。
 *  2. **被撤回的输出不参与起名。** 撤回意味着输出被内容审核拦了，
 *     拿它起名字等于把被拦的内容搬到列表上，而且会一直挂在那儿。
 *  3. **起名字失败不能影响这一轮。** 旁路挂了，助手消息照落、SSE 照走。
 *  4. **`/v1/sessions` 只给调用者自己的会话**，且不接受 query 里的 userId——
 *     让端上传 userId 就是把权限交给"端上传对了什么"。
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

/** 这一轮 runtime 该吐哪些事件（NDJSON 每行一条）。 */
let turnLines: string[] = [];
/** runtime 的 title 端点被叫了几次、拿到了什么。 */
let titleCalls: Array<{ userText: string; assistantText: string }> = [];
/** title 端点这次给什么。`null` = 直接 500。 */
let titleReply: string | null = "杭州周末行程";

const realFetch = globalThis.fetch;

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.endsWith("/title")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        userText?: string;
        assistantText?: string;
      };
      titleCalls.push({
        userText: body.userText ?? "",
        assistantText: body.assistantText ?? "",
      });
      if (titleReply === null) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ title: titleReply }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/turn")) {
      return new Response(`${turnLines.join("\n")}\n`, { status: 200 });
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
    async appendMessage() {},
    async createSession() {},
    async historyPage() {
      return { messages: [], hasMore: false, nextBefore: null };
    },
    // M48-05：发消息时归属取会话的（车机上请求里没有人）。桩里回 demo 身份。
    async sessionUserId() {
      return "demo-user";
    },
    async sessionTitle(id: string) {
      const r = rows.get(id);
      return r ? r.title : undefined;
    },
    async setSessionTitle(id: string, title: string) {
      const r = rows.get(id);
      // 条件更新：只写 null → 有值这一次，与 prisma 侧的 `where: { title: null }` 同语义。
      if (!r || r.title !== null) return false;
      r.title = title;
      return true;
    },
    async userSessionPage(q: { userId: string; limit: number; cursor?: string }) {
      const all = [...rows.entries()]
        .filter(([, r]) => r.userId === q.userId)
        .map(([id, r]) => ({
          sessionId: id,
          title: r.title,
          createdAt: r.updatedAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          closedAt: r.closedAt ? r.closedAt.toISOString() : null,
          messageCount: 0,
        }));
      return { sessions: all.slice(0, q.limit), hasMore: false, nextCursor: null };
    },
  } as never;
}

function appWith(rows: Map<string, Row>, bus: SessionBus, userId = "u1") {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId;
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

/** 等旁路那条 fire-and-forget 跑完（它不 await，所以只能轮询）。 */
async function settle(check: () => boolean, ms = 1500): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

const activeRow = (userId = "u1", title: string | null = null): Row => ({
  userId,
  title,
  closedAt: null,
  updatedAt: new Date(),
});

const answerTurn = [
  JSON.stringify({ type: "update", kind: "delta", turnId: "t1", text: "明天杭州多云。" }),
  JSON.stringify({ type: "update", kind: "turn_end", turnId: "t1", messageId: "m1" }),
];

beforeEach(() => {
  turnLines = answerTurn;
  titleCalls = [];
  titleReply = "杭州周末行程";
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("首轮结束后起名字", () => {
  it("落库 + 下发 update/title，且把车主原话与助手回答都交给旁路", async () => {
    const rows = new Map([["s1", activeRow()]]);
    const bus = new SessionBus();
    const seen: string[] = [];
    bus.subscribe("s1", null, (env) => {
      if (env.event.type === "update") seen.push(env.event.kind);
    });

    const r = await call(appWith(rows, bus), "POST", "/v1/session/s1/messages", {
      content: "明天去杭州要不要带伞",
    });
    assert.equal(r.status, 202);

    await settle(() => rows.get("s1")!.title !== null);
    assert.equal(rows.get("s1")!.title, "杭州周末行程");
    assert.equal(titleCalls.length, 1);
    assert.equal(titleCalls[0].userText, "明天去杭州要不要带伞");
    assert.equal(titleCalls[0].assistantText, "明天杭州多云。");
    assert.ok(seen.includes("title"), `未下发 update/title：${seen.join(",")}`);
  });

  it("已经有标题 → 一次调用都不发（那是钱）", async () => {
    const rows = new Map([["s1", activeRow("u1", "早就有的名字")]]);
    const bus = new SessionBus();
    await call(appWith(rows, bus), "POST", "/v1/session/s1/messages", { content: "再问一句" });
    await settle(() => titleCalls.length > 0, 300);
    assert.equal(titleCalls.length, 0);
    assert.equal(rows.get("s1")!.title, "早就有的名字");
  });

  it("这一轮被撤回 → 不起名字（被拦的内容不该出现在列表上）", async () => {
    turnLines = [
      JSON.stringify({ type: "update", kind: "delta", turnId: "t1", text: "不该说的话" }),
      JSON.stringify({
        type: "update",
        kind: "retract",
        turnId: "t1",
        replacement: "这条我没法回答",
        reason: "moderation",
      }),
      JSON.stringify({ type: "update", kind: "turn_end", turnId: "t1", messageId: "m1" }),
    ];
    const rows = new Map([["s1", activeRow()]]);
    await call(appWith(rows, new SessionBus()), "POST", "/v1/session/s1/messages", {
      content: "随便问点什么",
    });
    await settle(() => titleCalls.length > 0, 300);
    assert.equal(titleCalls.length, 0);
    assert.equal(rows.get("s1")!.title, null);
  });

  it("助手一个字都没说 → 不起名字（没内容可总结）", async () => {
    turnLines = [JSON.stringify({ type: "update", kind: "turn_end", turnId: "t1", messageId: "m1" })];
    const rows = new Map([["s1", activeRow()]]);
    await call(appWith(rows, new SessionBus()), "POST", "/v1/session/s1/messages", {
      content: "在吗",
    });
    await settle(() => titleCalls.length > 0, 300);
    assert.equal(titleCalls.length, 0);
  });

  it("旁路挂了 → 静默无标题，这一轮照常收口", async () => {
    titleReply = null;
    const rows = new Map([["s1", activeRow()]]);
    const bus = new SessionBus();
    const kinds: string[] = [];
    bus.subscribe("s1", null, (env) => {
      if (env.event.type === "update") kinds.push(env.event.kind);
    });
    const r = await call(appWith(rows, bus), "POST", "/v1/session/s1/messages", {
      content: "明天去杭州",
    });
    assert.equal(r.status, 202);
    await settle(() => kinds.includes("turn_end"));
    assert.ok(kinds.includes("turn_end"), "轮次没有收口");
    await settle(() => rows.get("s1")!.title !== null, 300);
    assert.equal(rows.get("s1")!.title, null);
    assert.ok(!kinds.includes("title"), "没写进库却下发了 title");
  });
});

describe("GET /v1/sessions", () => {
  it("只给调用者自己的会话，带标题", async () => {
    const rows = new Map([
      ["s1", activeRow("u1", "杭州周末行程")],
      ["s2", activeRow("u2", "别人的会话")],
      ["s3", activeRow("u1", null)],
    ]);
    const r = await call(appWith(rows, new SessionBus()), "GET", "/v1/sessions?limit=20");
    assert.equal(r.status, 200);
    const list = r.body.sessions as Array<{ sessionId: string; title: string | null }>;
    assert.deepEqual(
      list.map((x) => x.sessionId).sort(),
      ["s1", "s3"],
    );
    assert.equal(list.find((x) => x.sessionId === "s1")!.title, "杭州周末行程");
    assert.equal(list.find((x) => x.sessionId === "s3")!.title, null);
  });

  /**
   * **query 里的 userId 一律不认。** 认了的话，权限就落在了"端上传对了什么"上面。
   * 跨用户检索是运营的能力，在 `/console/sessions`（另一道角色门）。
   */
  it("query 里传别人的 userId 不生效", async () => {
    const rows = new Map([
      ["s1", activeRow("u1", "我的")],
      ["s2", activeRow("u2", "别人的")],
    ]);
    const r = await call(appWith(rows, new SessionBus()), "GET", "/v1/sessions?userId=u2");
    const list = r.body.sessions as Array<{ sessionId: string }>;
    assert.deepEqual(list.map((x) => x.sessionId), ["s1"]);
  });
});
