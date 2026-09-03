/**
 * 闲聊旁路开关的上行链路（施工单 M33-04，F-45-08）。
 *
 * # 这组测试还的是 M18-05 留下的一笔债
 *
 * `clients/cockpit/src-tauri/src/commands/prefs.rs:42` 从 M18-05 起就挂着这句话：
 *
 * > ⚠️ 这只是端上偏好。**服务端还要收到它才算真关**（`TurnInput.fillerEnabled`）：
 * > 端上丢弃而服务端照产，判断逻辑仍在跑、指标仍在写，接 L1 后仍会烧钱。
 * > 上行链路本单未接。
 *
 * 于是 **AC-45-11「用户可彻底关闭该能力；关闭后不产生任何垫场事件与相关模型调用」
 * 一直是假的**。本文件盯的就是那条链路的网关这一段。
 *
 * 四条判据：
 *  1. JSON 体的 `fillerEnabled` 一路带到 runtime；
 *  2. 音频体走 `X-Filler-Enabled` 头（raw PCM 塞不进 JSON）；
 *  3. **端上没表态时不传这个键**——不是传 `true`：缺省语义由
 *     `TurnInput.fillerEnabled ?? true` 一处定义，网关补第二遍迟早分家；
 *  4. 脏值当没传，**消息照常受理**（它是可选元信息，为它挡掉一条真实消息不划算）。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import express from "express";

import { createHttpRouter } from "../src/http";
import { SessionBus } from "../src/stream/session-bus";

/** 转发给 runtime 的 turn 请求体，逐次记录。 */
let turnBodies: Array<Record<string, unknown>> = [];

const realFetch = globalThis.fetch;

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("/turn")) {
      turnBodies.push(JSON.parse(String(init?.body ?? "{}")));
      // 空流即可：本文件只关心请求体，不关心事件。
      return new Response("", { status: 200 });
    }
    if (url.endsWith("/title")) {
      return new Response(JSON.stringify({ title: null }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

function fakeRepo() {
  return {
    async sessionExists() {
      return true;
    },
    async sessionState() {
      return { exists: true, closedAt: null, lastActiveAt: new Date() };
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

function app() {
  const a = express();
  a.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = "u1";
    next();
  });
  a.use(
    createHttpRouter(fakeRepo(), new SessionBus(), {
      transcribe: async () => "听写出来的一句话",
    } as never),
  );
  return a;
}

async function post(
  a: express.Express,
  path: string,
  opts: { json?: unknown; audio?: Buffer; headers?: Record<string, string> },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = a.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await realFetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: opts.audio
        ? { "content-type": "audio/pcm_s16le", "x-audio-meta": AUDIO_META, ...opts.headers }
        : { "content-type": "application/json", ...opts.headers },
      body: opts.audio ?? JSON.stringify(opts.json ?? {}),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

const AUDIO_META = JSON.stringify({
  durationMs: 1200,
  format: "pcm_s16le",
  sampleRateHz: 16000,
  channels: 1,
});

/** 等 driveTurn 那条 fire-and-forget 把请求发出去。 */
async function settle(check: () => boolean, ms = 1500): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  turnBodies = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("[M33-04][AC-45-11] fillerEnabled 上行：JSON 分支", () => {
  it("false 一路带到 runtime", async () => {
    const a = app();
    await post(a, "/v1/session/s1/messages", { json: { content: "你好", fillerEnabled: false } });
    await settle(() => turnBodies.length > 0);
    assert.equal(turnBodies[0]?.fillerEnabled, false);
  });

  it("true 同样带过去（显式开着与没表态是两回事）", async () => {
    const a = app();
    await post(a, "/v1/session/s1/messages", { json: { content: "你好", fillerEnabled: true } });
    await settle(() => turnBodies.length > 0);
    assert.equal(turnBodies[0]?.fillerEnabled, true);
  });

  it("**没表态时这个键根本不出现**——缺省语义只有 runtime 一处定义", async () => {
    const a = app();
    await post(a, "/v1/session/s1/messages", { json: { content: "你好" } });
    await settle(() => turnBodies.length > 0);
    assert.equal(
      "fillerEnabled" in (turnBodies[0] ?? {}),
      false,
      "补一个 true 就是把同一个默认值写第二遍，两处迟早分家",
    );
  });

  it("脏值当没传，且**消息照常受理**（可选元信息不该挡掉一条真实消息）", async () => {
    const a = app();
    const res = await post(a, "/v1/session/s1/messages", {
      json: { content: "你好", fillerEnabled: "no" },
    });
    assert.equal(res.status, 202);
    await settle(() => turnBodies.length > 0);
    assert.equal("fillerEnabled" in (turnBodies[0] ?? {}), false);
  });
});

describe("[M33-04][AC-45-11] fillerEnabled 上行：音频分支走请求头", () => {
  it("X-Filler-Enabled: 0 → false", async () => {
    const a = app();
    await post(a, "/v1/session/s1/messages", {
      audio: Buffer.from([1, 2, 3, 4]),
      headers: { "x-filler-enabled": "0" },
    });
    await settle(() => turnBodies.length > 0);
    assert.equal(turnBodies[0]?.fillerEnabled, false);
    assert.equal(turnBodies[0]?.source, "voice", "source 不该被这次改动带偏");
  });

  it("X-Filler-Enabled: 1 → true", async () => {
    const a = app();
    await post(a, "/v1/session/s1/messages", {
      audio: Buffer.from([1, 2, 3, 4]),
      headers: { "x-filler-enabled": "1" },
    });
    await settle(() => turnBodies.length > 0);
    assert.equal(turnBodies[0]?.fillerEnabled, true);
  });

  it("头缺失或脏值 → 这个键不出现，消息照常受理", async () => {
    const a = app();
    const res = await post(a, "/v1/session/s1/messages", {
      audio: Buffer.from([1, 2, 3, 4]),
      headers: { "x-filler-enabled": "yes" },
    });
    assert.equal(res.status, 202);
    await settle(() => turnBodies.length > 0);
    assert.equal("fillerEnabled" in (turnBodies[0] ?? {}), false);
  });
});
