/**
 * 本地 ASR 档（ACR-003 立档，ACR-007 换成 llama.cpp `llama-server` + Qwen3-ASR GGUF）。
 *
 * 这份测试盯四件事，第一件是本档存在的全部理由：
 *
 *  1. **200 + `{"error":…}` 必须抛错。** whisper-server 时代失败返回 HTTP 200，
 *     body 里才有 error。只判 `res.ok` 会把失败当成"转写出空字符串"——空串进端上
 *     `wake::classify` 得 Miss、被就地丢弃，外部症状与 ASR 挂掉一模一样（暖暖听不见），
 *     而且更坏：网关认为这是成功，端上 `TranscribeGuard` 的连续失败计数器永不触发降级，
 *     界面连异常指示都没有。ACR-003 的 spike 里我们真踩了这个坑（20 条全部静默空转写）。
 *     llama-server 失败通常回非 2xx，但该分支保留且必须继续有效。
 *  2. **裸 PCM 要补 WAV 头再送。** 端上按契约送 pcm_s16le/16k/mono 无容器头，
 *     转写端点只认容器格式。送错的表现不是报错，是识别出一堆噪声词。
 *  3. **选档：`mock` 要能盖过仍然填着的 `ARK_API_KEY`。** 本档的动机场景正是
 *     "账号欠费但 key 还在"，如果 key 存在就走 Ark，这个开关等于没有。
 *  4. **Qwen3-ASR 的 asr_text 标记前缀必须剥掉**（llama.cpp #26749）。不剥则前缀
 *     混进端上控制口令的精确匹配，每条口令判 Miss——与繁体击穿是同一类症状。
 */

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import type { AudioMeta } from "@carlife/shared";

import { createAsrProvider } from "../src/asr";

const meta: AudioMeta = { durationMs: 1200, format: "pcm_s16le", sampleRateHz: 16_000, channels: 1 };

/** 一段可辨认的假 PCM：16 个 int16 样本。 */
function pcm(): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) b.writeInt16LE(i * 100, i * 2);
  return b;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 拦下 fetch，记录请求并返回指定回包。 */
function stubFetch(reply: { status?: number; body: unknown }) {
  const seen: { url: string; form: FormData }[] = [];
  globalThis.fetch = (async (url: string, init: { body: FormData }) => {
    seen.push({ url: String(url), form: init.body });
    return {
      ok: (reply.status ?? 200) >= 200 && (reply.status ?? 200) < 300,
      status: reply.status ?? 200,
      json: async () => reply.body,
    };
  }) as unknown as typeof fetch;
  return seen;
}

function localProvider(env: Record<string, string> = {}) {
  return createAsrProvider({ ASR_ENGINE: "mock", ...env } as NodeJS.ProcessEnv);
}

describe("本地 ASR 档", () => {
  it("正常回包取 text 并去空白", async () => {
    stubFetch({ body: { text: "  暖暖，明天要带伞吗\n" } });
    assert.equal(await localProvider().transcribe(pcm(), meta), "暖暖，明天要带伞吗");
  });

  it("**剥掉 language + asr_text 标记前缀**（llama.cpp #26749）——否则口令精确匹配全 Miss", async () => {
    stubFetch({ body: { text: "language Chinese<asr_text>没事了" } });
    assert.equal(await localProvider().transcribe(pcm(), meta), "没事了");
  });

  it("上游修复后无前缀的输出原样通过（剥离是 no-op）", async () => {
    stubFetch({ body: { text: "暖暖，导航回家" } });
    assert.equal(await localProvider().transcribe(pcm(), meta), "暖暖，导航回家");
  });

  it("只有标记、没有正文 = 空转写，照样抛 asr_empty_result", async () => {
    stubFetch({ body: { text: "language Chinese<asr_text>" } });
    await assert.rejects(() => localProvider().transcribe(pcm(), meta), /asr_empty_result/);
  });

  it("**200 带 error 字段也要抛错**——不能当成空转写咽下去", async () => {
    stubFetch({ status: 200, body: { error: "failed to read audio data" } });
    await assert.rejects(
      () => localProvider().transcribe(pcm(), meta),
      /asr_failed local=failed to read audio data/,
      "200 + error 被当成成功的话，端上降级计数器永远不会触发",
    );
  });

  it("空文本抛错，不返回空串", async () => {
    stubFetch({ body: { text: "   " } });
    await assert.rejects(() => localProvider().transcribe(pcm(), meta), /asr_empty_result/);
  });

  it("非 2xx 抛错并带状态码", async () => {
    stubFetch({ status: 503, body: {} });
    await assert.rejects(() => localProvider().transcribe(pcm(), meta), /asr_failed status=503/);
  });

  it("裸 PCM 补成 WAV 再送：44 字节头 + 原样负载", async () => {
    const seen = stubFetch({ body: { text: "好" } });
    await localProvider().transcribe(pcm(), meta);
    const file = seen[0].form.get("file") as Blob;
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes.length, 44 + 32, "WAV 头 44 字节 + 32 字节 PCM");
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
    assert.equal(bytes.readUInt32LE(24), 16_000, "采样率来自 meta");
    assert.equal(bytes.readUInt16LE(22), 1, "单声道来自 meta");
    assert.deepEqual(bytes.subarray(44), pcm(), "负载不能被改动");
  });

  it("温度固定 0——转写要可复现，不要采样随机改写", async () => {
    const seen = stubFetch({ body: { text: "好" } });
    await localProvider().transcribe(pcm(), meta);
    assert.equal(seen[0].form.get("temperature"), "0");
  });

  it("默认强制中文（language=Chinese）——自动判语种在噪声段会吐任意语言", async () => {
    const seen = stubFetch({ body: { text: "好" } });
    await localProvider().transcribe(pcm(), meta);
    assert.equal(seen[0].form.get("language"), "Chinese");
  });

  it("LOCAL_ASR_LANGUAGE 置空 = 回到自动判定，不发 language 字段", async () => {
    const seen = stubFetch({ body: { text: "hello" } });
    await localProvider({ LOCAL_ASR_LANGUAGE: "" }).transcribe(pcm(), meta);
    assert.equal(seen[0].form.get("language"), null);
  });

  it("**强制中文时无 CJK 的输出按非语音丢弃**——葡萄牙语幻觉与指令回显都拦在这", async () => {
    stubFetch({ body: { text: "peguei lá para você" } });
    await assert.rejects(() => localProvider().transcribe(pcm(), meta), /asr_empty_result/);

    stubFetch({ body: { text: "language Chinese<asr_text>Transcribe audio to text (language: Chinese)" } });
    await assert.rejects(() => localProvider().transcribe(pcm(), meta), /asr_empty_result/);
  });

  it("中英夹杂但含 CJK 的正常话术不受守门影响", async () => {
    stubFetch({ body: { text: "language Chinese<asr_text>帮我放一首 Taylor Swift 的歌" } });
    assert.equal(await localProvider().transcribe(pcm(), meta), "帮我放一首 Taylor Swift 的歌");
  });

  it("语种置空时不做 CJK 守门——外语输出原样返回", async () => {
    stubFetch({ body: { text: "language English<asr_text>turn on the radio" } });
    assert.equal(
      await localProvider({ LOCAL_ASR_LANGUAGE: "" }).transcribe(pcm(), meta),
      "turn on the radio",
    );
  });

  it("端点可配，默认打本机 8795 的 transcriptions", async () => {
    let seen = stubFetch({ body: { text: "好" } });
    await localProvider().transcribe(pcm(), meta);
    assert.equal(seen[0].url, "http://127.0.0.1:8795/v1/audio/transcriptions");

    seen = stubFetch({ body: { text: "好" } });
    await localProvider({ LOCAL_ASR_URL: "http://127.0.0.1:9999/v1/audio/transcriptions" }).transcribe(pcm(), meta);
    assert.equal(seen[0].url, "http://127.0.0.1:9999/v1/audio/transcriptions");
  });

  it("**`local` 盖过仍然填着的 ARK_API_KEY**——欠费场景里 key 通常还在", async () => {
    const seen = stubFetch({ body: { text: "好" } });
    await localProvider({ ARK_API_KEY: "ark-still-configured" }).transcribe(pcm(), meta);
    assert.equal(seen[0].url, "http://127.0.0.1:8795/v1/audio/transcriptions", "有 key 也不该回落 Ark");
  });

  it("不设 ASR_ENGINE 时行为不变：有 key 走 Ark，没 key 走 Fake", async () => {
    const seen = stubFetch({ body: { output: [] } });
    const ark = createAsrProvider({ ARK_API_KEY: "k" } as NodeJS.ProcessEnv);
    await assert.rejects(() => ark.transcribe(pcm(), meta));
    assert.match(seen[0].url, /ark\.cn-beijing\.volces\.com/, "默认档必须还是 Ark");

    const fake = createAsrProvider({} as NodeJS.ProcessEnv);
    assert.equal(await fake.transcribe(pcm(), meta), "（模拟识别文本）");
  });
});
