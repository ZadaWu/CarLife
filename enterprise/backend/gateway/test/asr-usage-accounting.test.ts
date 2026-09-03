/**
 * ASR 用量记账（成本归因）。
 *
 * 这份测试盯的是**账本不对的三种方式**，每一种都不会让任何功能坏掉，
 * 所以只能靠测试守：
 *
 *  1. **空转写不记账**。判空 throw 排在用量回报之前时，账面上"哨兵几乎不花钱"
 *     而账单照涨——车内大多数语音段是噪声与非语音，判空是哨兵路的**主导情形**。
 *     判据是"供应商收没收钱"（回包带 usage 就是收了），不是"我们拿没拿到文本"。
 *  2. **哨兵路不记账**。它是调用量最大的一路（§13 待确认 22），漏了它等于漏了大头。
 *  3. **两个入口混成一个 agent 名**。哨兵段与对话轮次量级差一个数量级，
 *     混在一起记就说不清钱花在哪（AC-38-8 要的"按端可拆解"）。
 *
 * 另有一条边界要守住：哨兵路只记次数/时长/token，**转写内容一个字都不许进**
 * （AC-52-5 判定后即弃）。
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import express from "express";

import type { AudioMeta } from "@carlife/shared";

import { createAsrProvider } from "../src/asr";
import { createHttpRouter } from "../src/http";
import { SessionBus } from "../src/stream/session-bus";

const meta: AudioMeta = { durationMs: 1200, format: "pcm_s16le", sampleRateHz: 16_000, channels: 1 };
const pcm = (): Buffer => Buffer.alloc(32);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 让云 provider 回一个"有 usage、但没有文本"的回包——空转写的真实形状。 */
function stubEmptyWithUsage(kind: "ark" | "aliyun") {
  const body =
    kind === "ark"
      ? { output: [], usage: { input_tokens: 120, output_tokens: 0 } }
      : {
          output: { choices: [] },
          usage: { seconds: 3, input_tokens_details: { text_tokens: 0 }, output_tokens_details: { text_tokens: 0 } },
        };
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe("空转写同样是收费调用（用量必须在判空之前回报）", () => {
  it("Ark 档：回包无文本但带 usage 时照样记账", async () => {
    stubEmptyWithUsage("ark");
    const provider = createAsrProvider({ ARK_API_KEY: "k" } as NodeJS.ProcessEnv);
    let reported: { inputTokens: number } | undefined;
    await assert.rejects(
      () => provider.transcribe(pcm(), meta, (u) => (reported = u)),
      /asr_empty_result/,
      "空转写仍然要抛，端上据此判 Miss",
    );
    assert.equal(reported?.inputTokens, 120, "音频已上传、模型已跑完——这次是要付钱的");
  });

  it("阿里云档：同上", async () => {
    stubEmptyWithUsage("aliyun");
    const provider = createAsrProvider({
      ASR_ENGINE: "aliyun",
      DASHSCOPE_API_KEY: "sk",
    } as NodeJS.ProcessEnv);
    let called = false;
    await assert.rejects(
      () => provider.transcribe(pcm(), meta, () => (called = true)),
      /asr_empty_result/,
    );
    assert.equal(called, true);
  });
});

describe("哨兵入口的用量归因", () => {
  /** 只回固定 usage 的假 provider。 */
  const provider = {
    async transcribe(_a: Buffer, _m: AudioMeta, onUsage?: (u: unknown) => void) {
      onUsage?.({ model: "qwen3-asr-flash", inputTokens: 7, outputTokens: 3, durationMs: 55 });
      return "你好暖暖";
    },
  };

  async function callSentinel(onUsage: (s: Record<string, unknown>) => void) {
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { userId?: string }).userId = "u1";
      next();
    });
    app.use(createHttpRouter({} as never, new SessionBus(), provider as never, onUsage as never));
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      return await fetch(`http://127.0.0.1:${port}/v1/asr/transcribe`, {
        method: "POST",
        headers: { "content-type": "audio/pcm_s16le", "x-audio-meta": JSON.stringify(meta) },
        body: new Uint8Array(32),
      });
    } finally {
      server.close();
    }
  }

  it("记账，且标记 source=sentinel（量最大的一路，漏了就是漏了大头）", async () => {
    const seen: Record<string, unknown>[] = [];
    const res = await callSentinel((s) => seen.push(s));
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].source, "sentinel");
    assert.equal(seen[0].inputTokens, 7);
  });

  it("不携带会话与轮次——哨兵段不建轮，编一个 id 只会造成能 join 回去的错觉", async () => {
    const seen: Record<string, unknown>[] = [];
    await callSentinel((s) => seen.push(s));
    assert.equal(seen[0].sessionId, undefined);
    assert.equal(seen[0].turnId, undefined);
  });

  it("样本里没有任何转写内容——AC-52-5 判定后即弃的边界", async () => {
    const seen: Record<string, unknown>[] = [];
    await callSentinel((s) => seen.push(s));
    assert.equal(JSON.stringify(seen[0]).includes("你好暖暖"), false);
  });
});
