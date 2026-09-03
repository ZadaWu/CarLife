/**
 * 会话试听（M60-02）：音频从哪来、存不存、谁能听。
 *
 * 盯的是六件都能悄悄错掉的事：
 *
 *  1. **录音要挂在 messageId 上**。原来落盘的名字是 `<sessionId>-<时间戳>`，
 *     事后没有任何东西认得它属于哪一句；挂错了的表现是"点了别人的播放键"。
 *  2. **哨兵段一段都不许存**（AC-52-5）。它不建轮，所以这条边界由结构保证
 *     ——本用例钉住"结构真的保证了"，而不是靠谁记得写 if。
 *  3. **存过的不再合成**。补合成花的是真钱，第二次点播放还去打供应商，
 *     就成了按播放次数计费。
 *  4. **档位取当时下发的那个**，不是配置层的当前值。否则今天切一次引擎，
 *     整部历史的音色跟着变。
 *  5. **车主的录音补不出来**：没存过就是没存过，不能拿 TTS 合成一段
 *     "车主的话"顶上——那是伪造证据。
 *  6. **审计写不进去就不给字节**。音频没法脱敏，它与 reveal 同级。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { AudioMeta } from "@carlife/shared";

import { createMessageAudioRouter, audioObjectKey } from "../src/console/message-audio";
import { createHttpRouter } from "../src/http";
import { SessionBus } from "../src/stream/session-bus";
import { parseDoubaoNdjson, TtsSynthesisError } from "../src/tts/synthesize";
import type { AsrProvider } from "../src/asr";

// ── 假件 ────────────────────────────────────────────────────────────

const meta: AudioMeta = { durationMs: 1200, format: "pcm_s16le", sampleRateHz: 16_000, channels: 1 };

interface StoredObject {
  body: Buffer;
  contentType: string;
}

function fakeStore() {
  const objects = new Map<string, StoredObject>();
  return {
    objects,
    store: {
      async put(key: string, body: Buffer, contentType: string) {
        objects.set(key, { body, contentType });
      },
      async get(key: string) {
        const o = objects.get(key);
        return o ? { body: new Uint8Array(o.body), contentType: o.contentType } : null;
      },
      async remove(key: string) {
        objects.delete(key);
      },
      async ensureBucket() {},
    },
  };
}

function fakeAudioRepo() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    repo: {
      async put(m: { messageId: string; kind: string }) {
        rows.set(`${m.messageId}:${m.kind}`, m as Record<string, unknown>);
      },
      async get(messageId: string, kind: string) {
        return (rows.get(`${messageId}:${kind}`) as never) ?? null;
      },
      async presenceOf(ids: string[]) {
        const out = new Map<string, string[]>();
        for (const [k] of rows) {
          const [id, kind] = k.split(":");
          if (ids.includes(id)) out.set(id, [...(out.get(id) ?? []), kind]);
        }
        return out as never;
      },
    },
  };
}

/** 只回一条消息的假 chat 仓储。 */
const chatWith = (message: Record<string, unknown> | null) =>
  ({
    async consoleMessage() {
      return message;
    },
  }) as never;

const auditOk = (recorded: unknown[]) =>
  ({
    async recordStrict(e: unknown) {
      recorded.push(e);
      return "aud-1";
    },
  }) as never;

const auditBroken = () =>
  ({
    async recordStrict() {
      throw new Error("audit down");
    },
  }) as never;

const configOf = (values: Record<string, string>) =>
  ({
    async runtimeValues() {
      return new Map(Object.entries(values));
    },
  }) as never;

async function getAudio(app: express.Express, messageId: string) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/console/messages/${messageId}/audio`, {
      headers: { authorization: "Bearer admin-token" },
    });
    return {
      status: r.status,
      contentType: r.headers.get("content-type"),
      origin: r.headers.get("x-audio-origin"),
      engine: r.headers.get("x-audio-engine"),
      bytes: Buffer.from(await r.arrayBuffer()),
    };
  } finally {
    server.close();
  }
}

// ── 建轮时的录音转存 ────────────────────────────────────────────────

describe("车主录音的转存（M60-02）", () => {
  function appWithSink(saved: Array<Record<string, unknown>>) {
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { userId?: string }).userId = "u1";
      next();
    });
    const repo = {
      async sessionState() {
        return { exists: true, closedAt: null, lastActiveAt: new Date() };
      },
      async sessionUserId() {
        return "u1";
      },
      async appendMessage() {},
    } as never;
    app.use(
      createHttpRouter(
        repo,
        new SessionBus(),
        { async transcribe() { return "你好"; } } as AsrProvider,
        undefined,
        undefined,
        undefined,
        undefined,
        async (a) => {
          saved.push(a as unknown as Record<string, unknown>);
        },
      ),
    );
    return app;
  }

  async function post(app: express.Express, path: string) {
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "audio/pcm_s16le", "x-audio-meta": JSON.stringify(meta) },
        body: new Uint8Array(64),
      });
      return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
    } finally {
      server.close();
    }
  }

  it("建轮那条路：录音挂到刚落库的 messageId 上，且补了 WAV 头（裸 PCM 浏览器放不出来）", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const r = await post(appWithSink(saved), "/v1/session/sess-a/messages");
    assert.equal(r.status, 202);
    assert.equal(saved.length, 1);
    // messageId 由 TurnService 给，不在路由里拼——两者必须是同一个值。
    assert.equal(saved[0].messageId, r.body?.userMessageId);
    assert.equal(saved[0].sessionId, "sess-a");
    assert.equal(saved[0].mime, "audio/wav");
    assert.equal((saved[0].bytes as Buffer).subarray(0, 4).toString(), "RIFF");
  });

  it("哨兵那条路（/v1/asr/transcribe）一段都不存——它不建轮，也就没有消息可挂（AC-52-5）", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const r = await post(appWithSink(saved), "/v1/asr/transcribe");
    assert.equal(r.status, 200);
    assert.equal(saved.length, 0);
  });
});

// ── 试听端点 ────────────────────────────────────────────────────────

describe("GET /console/messages/:id/audio", () => {
  const assistant = {
    messageId: "msg-turn-1-a",
    sessionId: "sess-a",
    turnId: "turn-1",
    role: "assistant",
    source: "text",
    content: "前挡风起雾时先开 A/C 除雾。",
    ts: 1,
    asrEngine: null,
    ttsEngine: "mock",
  };

  function appWith(opts: {
    message: Record<string, unknown> | null;
    audio: ReturnType<typeof fakeAudioRepo>;
    store: ReturnType<typeof fakeStore>;
    values?: Record<string, string>;
    fetchCalls?: string[];
    audit?: unknown;
    recorded?: unknown[];
    fetchImpl?: typeof fetch;
  }) {
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { console?: unknown }).console = {
        subject: "console-admin",
        role: "admin",
      };
      next();
    });
    app.use(
      createMessageAudioRouter({
        chat: chatWith(opts.message),
        audit: (opts.audit ?? auditOk(opts.recorded ?? [])) as never,
        audio: opts.audio.repo as never,
        config: configOf(opts.values ?? { TTS_ENGINE: "mock", MOCK_TTS_URL: "http://mock.test/tts" }),
        store: opts.store.store as never,
        fetchImpl: opts.fetchImpl,
      }),
    );
    return app;
  }

  it("已存过：直接给存下来的字节，一次供应商调用都不发", async () => {
    const store = fakeStore();
    const audio = fakeAudioRepo();
    const key = audioObjectKey("sess-a", assistant.messageId, "tts", "audio/mpeg");
    await store.store.put(key, Buffer.from("stored-mp3"), "audio/mpeg");
    await audio.repo.put({
      messageId: assistant.messageId,
      kind: "tts",
      engine: "mock",
      origin: "resynth",
      mime: "audio/mpeg",
      bytes: 10,
      objectKey: key,
    } as never);

    // 注入一个"一调用就炸"的 fetch：真去合成了这条用例会红。
    const explode = (async () => {
      throw new Error("不该发起合成");
    }) as unknown as typeof fetch;
    const r = await getAudio(
      appWith({ message: assistant, audio, store, fetchImpl: explode }),
      assistant.messageId,
    );
    assert.equal(r.status, 200);
    assert.equal(r.bytes.toString(), "stored-mp3");
    assert.equal(r.origin, "resynth");
  });

  it("没存过的助手消息：按**当时下发的档位**补合成一次，存下来，并标 origin=resynth", async () => {
    const store = fakeStore();
    const audio = fakeAudioRepo();
    const seen: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      seen.push(String(url));
      return {
        ok: true,
        status: 200,
        async text() {
          return (
            JSON.stringify({ code: 0, data: Buffer.from("mp3-bytes").toString("base64") }) +
            "\n" +
            JSON.stringify({ code: 20_000_000, message: "OK", data: null }) +
            "\n"
          );
        },
      };
    }) as unknown as typeof fetch;
    const r = await getAudio(
      appWith({
        message: assistant,
        audio,
        store,
        fetchImpl: fakeFetch,
        // 配置层当前是 doubao，而这条消息记的是 mock——必须打 mock 的地址。
        values: { TTS_ENGINE: "doubao", MOCK_TTS_URL: "http://mock.test/tts" },
      }),
      assistant.messageId,
    );
    assert.equal(r.status, 200);
    assert.equal(r.bytes.toString(), "mp3-bytes");
    assert.equal(r.origin, "resynth");
    assert.equal(r.engine, "mock");
    assert.deepEqual(seen, ["http://mock.test/tts"]);
    // 落了库也落了对象——下一次点播放不再花钱。
    const row = (await audio.repo.get(assistant.messageId, "tts")) as unknown as {
      origin: string;
      objectKey: string;
    };
    assert.equal(row.origin, "resynth");
    assert.equal(store.objects.get(row.objectKey)?.body.toString(), "mp3-bytes");
  });

  it("车主那句没存过：404 audio_not_stored——**不拿 TTS 合成一段「车主的话」顶上**", async () => {
    const store = fakeStore();
    const audio = fakeAudioRepo();
    const user = { ...assistant, messageId: "msg-turn-1-u", role: "user", source: "voice", ttsEngine: null };
    const r = await getAudio(appWith({ message: user, audio, store }), user.messageId);
    assert.equal(r.status, 404);
    assert.match(r.bytes.toString(), /audio_not_stored/);
  });

  it("每次放行都留一条审计——音频没法脱敏，它与 reveal 同级", async () => {
    const store = fakeStore();
    const audio = fakeAudioRepo();
    const recorded: unknown[] = [];
    const key = audioObjectKey("sess-a", assistant.messageId, "tts", "audio/mpeg");
    await store.store.put(key, Buffer.from("x"), "audio/mpeg");
    await audio.repo.put({
      messageId: assistant.messageId,
      kind: "tts",
      engine: "mock",
      origin: "resynth",
      mime: "audio/mpeg",
      bytes: 1,
      objectKey: key,
    } as never);

    await getAudio(appWith({ message: assistant, audio, store, recorded }), assistant.messageId);
    assert.equal(recorded.length, 1);
    assert.equal((recorded[0] as { action: string }).action, "message.audio");
    assert.equal((recorded[0] as { target: string }).target, assistant.messageId);
  });

  it("审计写不进去：503，且一个字节都不给", async () => {
    const store = fakeStore();
    const audio = fakeAudioRepo();
    const r = await getAudio(
      appWith({ message: assistant, audio, store, audit: auditBroken() }),
      assistant.messageId,
    );
    assert.equal(r.status, 503);
    assert.match(r.bytes.toString(), /audit_unavailable/);
  });

  it("消息不存在：404，不去问存储", async () => {
    const store = fakeStore();
    const audio = fakeAudioRepo();
    const r = await getAudio(appWith({ message: null, audio, store }), "msg-nope");
    assert.equal(r.status, 404);
    assert.match(r.bytes.toString(), /message_not_found/);
  });
});

// ── 协议 ────────────────────────────────────────────────────────────

describe("parseDoubaoNdjson（端上 parse_ndjson_audio 的服务端对侧）", () => {
  it("拼接分片、跳过元信息行", () => {
    const body =
      JSON.stringify({ code: 0, data: Buffer.from("AAA").toString("base64") }) +
      "\n" +
      JSON.stringify({ code: 0, data: null, sentence: { text: "你好" } }) +
      "\n" +
      JSON.stringify({ code: 0, data: Buffer.from("BBB").toString("base64") }) +
      "\n" +
      JSON.stringify({ code: 20_000_000, message: "OK", data: null });
    assert.equal(parseDoubaoNdjson(body).toString(), "AAABBB");
  });

  it("非零业务码抛错并带上 message——只回一个数字的话排障无从下手", () => {
    assert.throws(
      () => parseDoubaoNdjson(JSON.stringify({ code: 40_000_001, message: "bad speaker" })),
      (e: unknown) => e instanceof TtsSynthesisError && /bad speaker/.test((e as Error).message),
    );
  });

  it("一个音频分片都没有 = 失败，不返回空 Buffer 冒充成功", () => {
    assert.throws(
      () => parseDoubaoNdjson(JSON.stringify({ code: 20_000_000, message: "OK", data: null })),
      TtsSynthesisError,
    );
  });
});
