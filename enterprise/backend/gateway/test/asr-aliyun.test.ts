/**
 * 阿里云百炼 ASR 档（ACR-015，`qwen3-asr-flash` 同步识别）。
 *
 * 盯四件事：
 *  1. **裸 PCM 要补 WAV 头再送**（与 Ark/本地档同一条纪律）：送错的表现不是报错，
 *     是识别出一堆噪声词；且 base64 data URI 的 mime 要跟着容器走。
 *  2. **选档单套**（ACR-017）：`ASR_ENGINE` 唯一决定（env-override 的优先级在
 *     配置层解析）；配置层不可达 + 缓存冷时按 env 逃生——断言打在生产用的
 *     `createConfiguredAsrProvider` 上，不是没人用的那个。
 *  3. **HTTP 200 + code/message 的失败形态必须抛错**（DashScope 部分错误不走 4xx，
 *     防御分支与本地档 `{"error":…}` 同理）。
 *  4. **usage 回报走成功路径**，识别失败没有可入账的 token。
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import type { AudioMeta } from "@carlife/shared";

import { createAsrProvider, createConfiguredAsrProvider, extractAliyunText, type AsrUsage } from "../src/asr";

const meta: AudioMeta = { durationMs: 1200, format: "pcm_s16le", sampleRateHz: 16_000, channels: 1 };

function pcm(): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) b.writeInt16LE(i * 100, i * 2);
  return b;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 拦下 fetch，记录请求 JSON 并返回指定回包。 */
function stubFetch(reply: { status?: number; body: unknown }) {
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: (reply.status ?? 200) >= 200 && (reply.status ?? 200) < 300,
      status: reply.status ?? 200,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    };
  }) as unknown as typeof fetch;
  return seen;
}

function aliyunProvider(env: Record<string, string> = {}) {
  return createAsrProvider({
    ASR_ENGINE: "aliyun",
    DASHSCOPE_API_KEY: "sk-test",
    ...env,
  } as NodeJS.ProcessEnv);
}

const okReply = (text: string) => ({
  output: { choices: [{ message: { content: [{ text }] } }] },
  usage: {
    seconds: 2,
    input_tokens_details: { text_tokens: 0 },
    output_tokens_details: { text_tokens: 6 },
  },
});

describe("阿里云 ASR 档", () => {
  it("正常回包取 output.choices[0].message.content[0].text", async () => {
    stubFetch({ body: okReply("你好暖暖") });
    assert.equal(await aliyunProvider().transcribe(pcm(), meta), "你好暖暖");
  });

  it("裸 PCM 补 WAV 头成 data:audio/wav 的 base64，且请求带模型与中文钉死", async () => {
    const seen = stubFetch({ body: okReply("好") });
    await aliyunProvider().transcribe(pcm(), meta);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/services\/aigc\/multimodal-generation\/generation$/);
    assert.equal(seen[0].headers.authorization, "Bearer sk-test");
    assert.equal(seen[0].body.model, "qwen3-asr-flash");
    const audio: string = seen[0].body.input.messages[0].content[0].audio;
    assert.match(audio, /^data:audio\/wav;base64,/);
    // WAV 头 44 字节 + 32 字节 PCM；base64 解回来核对 RIFF 魔数。
    const bytes = Buffer.from(audio.split(",")[1], "base64");
    assert.equal(bytes.length, 76);
    assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
    assert.equal(seen[0].body.parameters.asr_options.language, "zh");
    assert.equal(seen[0].body.parameters.asr_options.enable_itn, false);
  });

  it("HTTP 200 + code/message 的失败形态抛 asr_failed，不当成空转写", async () => {
    stubFetch({ body: { code: "InvalidApiKey", message: "Invalid API-key provided." } });
    await assert.rejects(() => aliyunProvider().transcribe(pcm(), meta), /asr_failed aliyun=InvalidApiKey/);
  });

  it("非 2xx 抛 asr_failed 并带状态码", async () => {
    stubFetch({ status: 429, body: { code: "Throttling" } });
    await assert.rejects(() => aliyunProvider().transcribe(pcm(), meta), /asr_failed status=429/);
  });

  it("成功路径回报 usage（文本 token 明细 + 实测耗时）", async () => {
    stubFetch({ body: okReply("好") });
    let usage: AsrUsage | undefined;
    await aliyunProvider().transcribe(pcm(), meta, (u) => (usage = u));
    assert.equal(usage?.model, "qwen3-asr-flash");
    assert.equal(usage?.outputTokens, 6);
  });

  it("模型与端点可换（DASHSCOPE_BASE_URL / ALIYUN_ASR_MODEL）", async () => {
    const seen = stubFetch({ body: okReply("好") });
    await aliyunProvider({
      DASHSCOPE_BASE_URL: "https://ws-1.cn-beijing.maas.aliyuncs.com/api/v1",
      ALIYUN_ASR_MODEL: "qwen3-asr-flash-2026-01-01",
    }).transcribe(pcm(), meta);
    assert.match(seen[0].url, /^https:\/\/ws-1\.cn-beijing\.maas\.aliyuncs\.com\/api\/v1\//);
    assert.equal(seen[0].body.model, "qwen3-asr-flash-2026-01-01");
  });
});

describe("选档（ACR-017 单套开关）", () => {
  it("ASR_ENGINE=mock 路由到本机容器（原 local 档改名）", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ text: "本地" }) };
    }) as unknown as typeof fetch;
    await createAsrProvider({ ASR_ENGINE: "mock" } as NodeJS.ProcessEnv).transcribe(pcm(), meta);
    assert.match(seen[0], /\/v1\/audio\/transcriptions$/);
  });

  it("ASR_ENGINE=fake 经 env 注入生效，不访问网络——e2e 脚本的确定性机制", async () => {
    globalThis.fetch = (async () => {
      throw new Error("不该发请求");
    }) as unknown as typeof fetch;
    const p = createAsrProvider({ ASR_ENGINE: "fake", DASHSCOPE_API_KEY: "sk-x" } as NodeJS.ProcessEnv);
    assert.equal(await p.transcribe(pcm(), meta), "（模拟识别文本）");
  });

  it("ASR_ENGINE=aliyun 但没配 DASHSCOPE_API_KEY → 回落 Fake（与 Ark 档无 key 同语义）", async () => {
    const p = createAsrProvider({ ASR_ENGINE: "aliyun" } as NodeJS.ProcessEnv);
    assert.equal(await p.transcribe(pcm(), meta), "（模拟识别文本）");
  });

  it("不设 ASR_ENGINE 时行为与从前逐字节相同：有 ARK key 走 Ark，没有走 Fake", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "好" }] }] }),
      };
    }) as unknown as typeof fetch;
    await createAsrProvider({ ARK_API_KEY: "k" } as NodeJS.ProcessEnv).transcribe(pcm(), meta);
    assert.match(seen[0], /\/responses$/);
    assert.equal(
      await createAsrProvider({} as NodeJS.ProcessEnv).transcribe(pcm(), meta),
      "（模拟识别文本）",
    );
  });
});

describe("配置层不可达时的逃生（ACR-017 修正：断言打在生产用的 configured 工厂上）", () => {
  /** 只会抛错的假 store——模拟"数据库不可达 + 缓存冷启动"。 */
  const brokenStore = {
    version: async () => {
      throw new Error("db down");
    },
    runtimeValues: async () => {
      throw new Error("db down");
    },
  } as unknown as import("@carlife/db").ConfigStore;

  const savedEngine = process.env.ASR_ENGINE;
  afterEach(() => {
    if (savedEngine === undefined) delete process.env.ASR_ENGINE;
    else process.env.ASR_ENGINE = savedEngine;
  });

  it("env 钉了档：store 抛错也能按 env 构造——「数据库出问题 + 重启网关」正是钉档要兜住的组合", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ text: "本地" }) };
    }) as unknown as typeof fetch;
    process.env.ASR_ENGINE = "mock";
    const p = createConfiguredAsrProvider(brokenStore);
    await p.transcribe(pcm(), meta);
    assert.match(seen[0], /\/v1\/audio\/transcriptions$/, "逃生必须走 env 指定的 mock 档");
  });

  it("env 没钉档：错误如实抛——没有逃生配置时把错误藏起来只会让排查更难", async () => {
    delete process.env.ASR_ENGINE;
    const p = createConfiguredAsrProvider(brokenStore);
    await assert.rejects(() => p.transcribe(pcm(), meta), /db down/);
  });

  it("store 正常时选档听 store 的（env-override 在配置层解析，工厂不自己看 process.env）", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return { ok: true, status: 200, json: async () => ({ text: "本地" }) };
    }) as unknown as typeof fetch;
    const store = {
      version: async () => 1,
      runtimeValues: async () => new Map([["ASR_ENGINE", "mock"]]),
    } as unknown as import("@carlife/db").ConfigStore;
    const p = createConfiguredAsrProvider(store);
    await p.transcribe(pcm(), meta);
    assert.match(seen[0], /\/v1\/audio\/transcriptions$/);
  });
});
