/**
 * 端上的合成端点（`POST /v1/tts/speech`，ACR-018；aliyun 门面形态源自 ACR-015）。
 *
 * 盯的四件事在 ACR-018 之后多了一条最要紧的：**三档都能从这里出声**，
 * 因为端上已经没有别的路可走了。原来 doubao / mock 是端上直连供应商，
 * 这个端点只服务 aliyun 一档；现在它是唯一入口，某一档在这里坏掉，
 * 症状就是"切了引擎没声音"，且两侧都不报错。

 * 原有的四件事：
 *  1. **响应必须是端上 `parse_ndjson_audio` 认的形状**——base64 分片行 + 20000000
 *     终止行。这里错一个字段名，端上的症状是"切了引擎没声音"且两侧都不报错
 *     （与 carlife-net 那条 runtime_config 测试同一个道理，协议两端各锁一份）。
 *  2. **一切失败折成非零 code 的 NDJSON 行**，不用 HTTP 非 200——状态码进不了
 *     端上的错误消息，message 才进得去。
 *  3. **没配 DASHSCOPE_API_KEY 时明说没配**，不拿空值去打计费接口（与豆包档
 *     "没 key 拒绝合成"同一条纪律）。
 *  4. **未鉴权 401**——门面花真钱，不能像 mock-tts 那样裸奔。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { ConfigStore } from "@carlife/db";

import { createTtsSpeechRouter, audioToDoubaoNdjson } from "../src/http/tts-speech";

function storeOf(values: Record<string, string>): ConfigStore {
  return {
    async runtimeValues() {
      return new Map(Object.entries(values));
    },
  } as unknown as ConfigStore;
}

/** 假 DashScope + 假 OSS：合成回音频 URL，下载回 wav 字节。 */
function fakeFetch(opts: {
  wav?: Buffer;
  synthStatus?: number;
  synthBody?: unknown;
  /** 豆包协议上游（doubao / mock 两档）回的 mp3 字节。 */
  mp3?: Buffer;
}): { impl: typeof fetch; seen: { url: string; body?: any; headers?: any }[] } {
  const seen: { url: string; body?: any; headers?: any }[] = [];
  const impl = (async (url: string | URL, init?: { body?: string; headers?: any }) => {
    const u = String(url);
    seen.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers });
    // 豆包协议上游（火山 openspeech 或本机 mock-tts）：回 NDJSON。
    if (u.includes("/api/v3/tts/unidirectional")) {
      const mp3 = opts.mp3 ?? Buffer.from("ID3-mp3-bytes");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ code: 0, data: mp3.toString("base64") }) +
          "\n" +
          JSON.stringify({ code: 20_000_000, message: "OK", data: null }) +
          "\n",
      };
    }
    if (u.includes("multimodal-generation")) {
      return {
        ok: (opts.synthStatus ?? 200) < 300,
        status: opts.synthStatus ?? 200,
        json: async () =>
          opts.synthBody ?? { output: { audio: { url: "https://oss.example/audio.wav" } }, usage: { characters: 4 } },
        text: async () => JSON.stringify(opts.synthBody ?? {}),
      };
    }
    // OSS 下载
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        const b = opts.wav ?? Buffer.from("RIFFwav-bytes");
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function appWith(store: ConfigStore, fetchImpl: typeof fetch, userId: string | null = "demo-user") {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createTtsSpeechRouter(store, { fetchImpl }));
  return app;
}

async function post(app: express.Express, body: unknown, path = "/v1/tts/speech") {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Api-Key": "whatever" },
      body: JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
  } finally {
    server.close();
  }
}

const doubaoBody = { req_params: { text: "你好暖暖", speaker: "Cherry", audio_params: { format: "mp3" } } };

/** 端上 parse_ndjson_audio 的最小 TS 复刻：按行拼 base64 音频，非零码即错。 */
function parseNdjson(text: string): { audio: Buffer; error?: { code: number; message: string } } {
  const chunks: Buffer[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as { code: number; message?: string; data?: string | null };
    if (parsed.code !== 0 && parsed.code !== 20_000_000) {
      return { audio: Buffer.alloc(0), error: { code: parsed.code, message: parsed.message ?? "" } };
    }
    if (parsed.data) chunks.push(Buffer.from(parsed.data, "base64"));
  }
  return { audio: Buffer.concat(chunks) };
}

describe("POST /v1/tts/speech", () => {
  it("未鉴权 401", async () => {
    const { impl } = fakeFetch({});
    const r = await post(appWith(storeOf({}), impl, null), doubaoBody);
    assert.equal(r.status, 401);
  });

  it("合成成功：DashScope 回 URL → 下载 wav → 豆包 NDJSON 分片，端上拼回原字节", async () => {
    const wav = Buffer.from("RIFF" + "x".repeat(100_000)); // 跨多个分片
    const { impl, seen } = fakeFetch({ wav });
    const r = await post(appWith(storeOf({ TTS_ENGINE: "aliyun", DASHSCOPE_API_KEY: "sk-dash" }), impl), doubaoBody);
    assert.equal(r.status, 200);
    const parsed = parseNdjson(r.text);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.audio.equals(wav), true);
    // 请求侧：文本与音色进 DashScope，key 走 Authorization
    assert.equal(seen[0].body.input.text, "你好暖暖");
    assert.equal(seen[0].body.input.voice, "Cherry");
    assert.equal(seen[0].body.model, "qwen3-tts-flash");
  });

  it("没配 DASHSCOPE_API_KEY：明说没配，不打计费接口", async () => {
    const { impl, seen } = fakeFetch({});
    const r = await post(appWith(storeOf({ TTS_ENGINE: "aliyun" }), impl), doubaoBody);
    assert.equal(r.status, 200);
    const parsed = parseNdjson(r.text);
    assert.match(parsed.error?.message ?? "", /DASHSCOPE_API_KEY 未配置/);
    assert.equal(seen.length, 0);
  });

  it("DashScope 业务错误（200 + code/message）折成非零 code 行透传 message", async () => {
    const { impl } = fakeFetch({ synthBody: { code: "Throttling.RateQuota", message: "Requests throttled" } });
    const r = await post(appWith(storeOf({ TTS_ENGINE: "aliyun", DASHSCOPE_API_KEY: "sk" }), impl), doubaoBody);
    const parsed = parseNdjson(r.text);
    assert.match(parsed.error?.message ?? "", /Throttling\.RateQuota/);
  });

  it("DashScope 非 2xx 同样折成 NDJSON 错误行（不是 HTTP 透传）", async () => {
    const { impl } = fakeFetch({ synthStatus: 429, synthBody: { code: "Throttling" } });
    const r = await post(appWith(storeOf({ TTS_ENGINE: "aliyun", DASHSCOPE_API_KEY: "sk" }), impl), doubaoBody);
    assert.equal(r.status, 200);
    const parsed = parseNdjson(r.text);
    assert.match(parsed.error?.message ?? "", /status=429/);
  });

  it("aliyun 档的音色只来自 ALIYUN_TTS_VOICE，绝不用豆包音色名（实测 400 的坑）", async () => {
    /*
     * ACR-015 踩过的坑：拿 `zh_female_…` 这样的豆包音色名去打 DashScope 会
     * 400 "voice does not exist"。ACR-018 之后音色的选取与档位在
     * `synthesizeSpeech` 的同一个分支里决定，端上送什么都不影响——
     * 这一条把"不影响"钉住。
     */
    const { impl, seen } = fakeFetch({});
    await post(
      appWith(storeOf({ TTS_ENGINE: "aliyun", DASHSCOPE_API_KEY: "sk", ALIYUN_TTS_VOICE: "Serena" }), impl),
      // 端上送一个豆包音色名：采用它就会 400。
      { req_params: { text: "你好", speaker: "zh_female_vv_uranus_bigtts" } },
    );
    assert.equal(seen[0].body.input.voice, "Serena");
    // 没配 ALIYUN_TTS_VOICE 时落硬默认 Cherry，同样不许出现 zh_ 开头的豆包音色。
    const { impl: impl2, seen: seen2 } = fakeFetch({});
    await post(appWith(storeOf({ TTS_ENGINE: "aliyun", DASHSCOPE_API_KEY: "sk" }), impl2), {
      req_params: { text: "你好" },
    });
    assert.equal(seen2[0].body.input.voice, "Cherry");
  });

  it("空文本拒绝——不为一句空话花一次合成", async () => {
    const { impl, seen } = fakeFetch({});
    const r = await post(appWith(storeOf({ DASHSCOPE_API_KEY: "sk" }), impl), { req_params: { text: " " } });
    const parsed = parseNdjson(r.text);
    assert.match(parsed.error?.message ?? "", /text 缺失或为空/);
    assert.equal(seen.length, 0);
  });
});

describe("TTS 日字符闸门（ACR-016）", () => {
  /** 只按预设答案回答的假闸门；记下被要了多少量。 */
  const quotaOf = (allowed: boolean) => {
    const seen: { kind: string; amount: number; limit: number }[] = [];
    return {
      seen,
      quota: {
        async consume(kind: "asr" | "tts", amount: number, limit: number) {
          seen.push({ kind, amount, limit });
          return { allowed, used: amount, limit };
        },
        async snapshot() {
          return { used: 0 };
        },
      },
    };
  };

  function appQuota(q: ReturnType<typeof quotaOf>["quota"], values: Record<string, string>, f: typeof fetch) {
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { userId?: string }).userId = "demo-user";
      next();
    });
    app.use(createTtsSpeechRouter(storeOf(values), { fetchImpl: f, quota: q }));
    return app;
  }

  it("按字符数消费，不是按次数——这一档按字符计费", async () => {
    const { impl } = fakeFetch({});
    const g = quotaOf(true);
    await post(appQuota(g.quota, { TTS_ENGINE: "aliyun", DASHSCOPE_API_KEY: "sk", TTS_DAILY_CHAR_LIMIT: "1000" }, impl), {
      req_params: { text: "一二三四五" },
    });
    assert.deepEqual(g.seen, [{ kind: "tts", amount: 5, limit: 1000 }]);
  });

  it("超限时回 NDJSON 错误行且一次都不打 DashScope", async () => {
    const { impl, seen } = fakeFetch({});
    const g = quotaOf(false);
    const r = await post(appQuota(g.quota, { TTS_ENGINE: "aliyun", DASHSCOPE_API_KEY: "sk", TTS_DAILY_CHAR_LIMIT: "10" }, impl), {
      req_params: { text: "你好" },
    });
    assert.equal(r.status, 200);
    const parsed = parseNdjson(r.text);
    assert.match(parsed.error?.message ?? "", /今日合成字符已达上界/);
    // 错误消息要给出路——事后没人记得开关叫什么。
    assert.match(parsed.error?.message ?? "", /TTS_DAILY_CHAR_LIMIT/);
    assert.equal(seen.length, 0, "超限不该发生任何一次云端合成");
  });

  it("不注入闸门时行为不变（默认不限那条纪律的代码面）", async () => {
    const { impl, seen } = fakeFetch({});
    // 显式钉 aliyun 档：ACR-018 之后不写 TTS_ENGINE 解析出的是 mock，
    // 而 mock 走豆包协议只有一次上游调用，"合成 + 下载各一次"就不成立了。
    const r = await post(appWith(storeOf({ TTS_ENGINE: "aliyun", DASHSCOPE_API_KEY: "sk" }), impl), doubaoBody);
    assert.equal(parseNdjson(r.text).error, undefined);
    assert.equal(seen.length, 2, "合成 + 下载各一次");
  });

  it("闸门对 doubao 档同样生效——这是 ACR-018 的直接收益", async () => {
    const { impl, seen } = fakeFetch({});
    const g = quotaOf(false);
    const r = await post(
      appQuota(g.quota, { TTS_ENGINE: "doubao", BYTEDANCE_TTS_API_KEY: "sk", TTS_DAILY_CHAR_LIMIT: "10" }, impl),
      { req_params: { text: "你好" } },
    );
    assert.match(parseNdjson(r.text).error?.message ?? "", /今日合成字符已达上界/);
    // 改之前这一档根本不过网关，闸门是拦不住的。
    assert.equal(seen.length, 0, "超限不该发生任何一次云端合成");
  });
});

describe("audioToDoubaoNdjson", () => {
  it("每行都是合法 JSON，末行是 20000000 终止行", () => {
    const out = audioToDoubaoNdjson(Buffer.from("abc"));
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.at(-1).code, 20_000_000);
    assert.equal(Buffer.from(lines[0].data, "base64").toString(), "abc");
  });
});

/*
 * ACR-018 新增：doubao / mock 两档也从这个端点出声。
 *
 * 这一组是本单的核心断言面。改之前这两档是端上直连供应商，服务端一个字节
 * 都看不见；现在它们走同一个入口，密钥由服务端注入。少了这一组，
 * "端上删掉 vendor 客户端"就成了一个没有对侧证据的删除。
 */
describe("POST /v1/tts/speech · 豆包协议两档（ACR-018）", () => {
  it("doubao 档：打火山端点、密钥由服务端注入、回豆包 NDJSON", async () => {
    const { impl, seen } = fakeFetch({ mp3: Buffer.from("real-mp3") });
    const r = await post(
      appWith(storeOf({ TTS_ENGINE: "doubao", BYTEDANCE_TTS_API_KEY: "sk-server-side" }), impl),
      doubaoBody,
    );
    assert.equal(r.status, 200);
    assert.equal(parseNdjson(r.text).audio.toString(), "real-mp3");

    const upstream = seen.find((c) => c.url.includes("/api/v3/tts/unidirectional"));
    assert.ok(upstream, "应当打了豆包协议上游");
    assert.match(upstream.url, /^https:\/\/openspeech\.bytedance\.com\//);
    // 密钥在服务端注入——这正是本单要证明的那件事。
    assert.equal(upstream.headers["X-Api-Key"], "sk-server-side");
    // 而它绝不出现在回给端上的响应里。
    assert.equal(r.text.includes("sk-server-side"), false);
  });

  it("doubao 档没配密钥：明说没配，且一次都不打上游", async () => {
    const { impl, seen } = fakeFetch({});
    const r = await post(appWith(storeOf({ TTS_ENGINE: "doubao" }), impl), doubaoBody);
    const parsed = parseNdjson(r.text);
    assert.match(parsed.error?.message ?? "", /BYTEDANCE_TTS_API_KEY/);
    assert.equal(
      seen.filter((c) => c.url.includes("/api/v3/tts/unidirectional")).length,
      0,
      "没有真钥匙时不该拿占位值去打计费接口",
    );
  });

  it("mock 档：打本机 mock-tts，本机没配密钥也能出声", async () => {
    const { impl, seen } = fakeFetch({ mp3: Buffer.from("say-bytes") });
    const r = await post(appWith(storeOf({ TTS_ENGINE: "mock" }), impl), doubaoBody);
    assert.equal(r.status, 200);
    assert.equal(parseNdjson(r.text).audio.toString(), "say-bytes");
    const upstream = seen.find((c) => c.url.includes("/api/v3/tts/unidirectional"));
    assert.match(upstream!.url, /localhost:8794/);
  });

  it("音色由服务端定：端上带来的 speaker 不被采用", async () => {
    const { impl, seen } = fakeFetch({});
    // 端上送一个百炼音色名，而当前档是 doubao——采用它就会 400（ACR-015 实测过的坑）。
    await post(
      appWith(storeOf({ TTS_ENGINE: "doubao", BYTEDANCE_TTS_API_KEY: "sk-x" }), impl),
      { req_params: { text: "你好", speaker: "Cherry" } },
    );
    const upstream = seen.find((c) => c.url.includes("/api/v3/tts/unidirectional"));
    assert.equal(
      upstream!.body.req_params.speaker,
      "zh_female_vv_uranus_bigtts",
      "应当用配置层为当前档解析出的音色，而不是端上回传的那个",
    );
  });

  it("旧路径 /v1/tts/aliyun 仍可用——升级期旧客户端不该突然哑掉", async () => {
    const { impl } = fakeFetch({ mp3: Buffer.from("legacy-ok") });
    const r = await post(
      appWith(storeOf({ TTS_ENGINE: "mock" }), impl),
      doubaoBody,
      "/v1/tts/aliyun",
    );
    assert.equal(r.status, 200);
    assert.equal(parseNdjson(r.text).audio.toString(), "legacy-ok");
  });
});
