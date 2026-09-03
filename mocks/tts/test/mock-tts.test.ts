/**
 * mock-tts 的契约测试。
 *
 * 断言的重点不是「能出声」，而是**帧的形状与真实服务一致**——这个 mock 的
 * 全部价值就在这里：形状对不上的话，它顶多算个能出声的玩具，
 * 换回真服务的那天该炸的还是会炸。
 *
 * 所以下面这些断言与 `clients/shared/rust/carlife-net/src/tts.rs::parse_ndjson_audio`
 * 的四条单测是**同一份契约的两侧**：那边解析、这边生成，改一边必须改另一边。
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { createTtsServer, CODE_DONE } from "../src/index";
import { detectEncoder } from "../src/synth";

const server = createTtsServer();
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const HEADERS = {
  "X-Api-Key": "mock-key",
  "X-Api-Resource-Id": "seed-tts-2.0",
  "Content-Type": "application/json",
};

/** 与 tts.rs 的请求体逐字段同形。 */
function payload(text: string, format = "mp3", sampleRate = 24_000) {
  return JSON.stringify({
    req_params: {
      text,
      speaker: "zh_female_vv_uranus_bigtts",
      audio_params: { format, sample_rate: sampleRate },
    },
  });
}

interface Frame {
  code: number;
  message?: string;
  data?: string | null;
  sentence?: unknown;
}

function frames(body: string): Frame[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Frame);
}

/** 复刻客户端侧的拼接逻辑：跳过元信息帧，把 data 依次解 base64 后相连。 */
function concatAudio(list: Frame[]): Buffer {
  return Buffer.concat(
    list.filter((f) => typeof f.data === "string").map((f) => Buffer.from(f.data as string, "base64")),
  );
}

const isMac = process.platform === "darwin";

describe("请求契约", () => {
  it("缺 X-Api-Key 是 HTTP 401，不是业务错误帧", async () => {
    const res = await fetch(`${base}/api/v3/tts/unidirectional`, {
      method: "POST",
      headers: { "X-Api-Resource-Id": "seed-tts-2.0", "Content-Type": "application/json" },
      body: payload("你好"),
    });
    assert.equal(res.status, 401);
  });

  it("缺 X-Api-Resource-Id 同样是 401", async () => {
    const res = await fetch(`${base}/api/v3/tts/unidirectional`, {
      method: "POST",
      headers: { "X-Api-Key": "mock-key", "Content-Type": "application/json" },
      body: payload("你好"),
    });
    assert.equal(res.status, 401);
  });

  it("空文本走业务错误帧（HTTP 200 + code 4xxxxxxx）", async () => {
    const res = await fetch(`${base}/api/v3/tts/unidirectional`, {
      method: "POST",
      headers: HEADERS,
      body: payload("   "),
    });
    assert.equal(res.status, 200);
    const [frame] = frames(await res.text());
    assert.equal(frame.code, 40_000_001);
    assert.equal(frame.data, null);
  });

  it("不认识的音频格式也走业务错误帧", async () => {
    const res = await fetch(`${base}/api/v3/tts/unidirectional`, {
      method: "POST",
      headers: HEADERS,
      body: payload("你好", "flac"),
    });
    const [frame] = frames(await res.text());
    assert.equal(frame.code, 40_000_001);
    assert.match(frame.message ?? "", /flac/);
  });
});

describe("响应契约", { skip: isMac ? false : "非 macOS，没有 say" }, () => {
  it("wav：分片帧 + 元信息帧 + 终止帧，顺序与真实服务一致", async () => {
    const res = await fetch(`${base}/api/v3/tts/unidirectional`, {
      method: "POST",
      headers: HEADERS,
      body: payload("你好，我是车生活助手。", "wav"),
    });
    assert.equal(res.status, 200);
    const list = frames(await res.text());

    // 终止帧必须是最后一行，且是那个特定的码——客户端拿它当正常结束。
    const last = list.at(-1)!;
    assert.equal(last.code, CODE_DONE);
    assert.equal(last.data, null);

    // 元信息帧：data 为 null 但 code 为 0，客户端要跳过而不是当结束。
    const meta = list.find((f) => f.code === 0 && f.data === null);
    assert.ok(meta, "缺少句级元信息帧");
    assert.ok((meta as { sentence?: unknown }).sentence);

    // 音频帧至少一条，且全部是合法 base64
    const audioFrames = list.filter((f) => typeof f.data === "string");
    assert.ok(audioFrames.length >= 1);

    const audio = concatAudio(list);
    assert.equal(audio.toString("ascii", 0, 4), "RIFF");
    assert.equal(audio.toString("ascii", 8, 12), "WAVE");
  });

  it("mp3：拼起来是真的 MPEG 帧，不是改了扩展名的 wav", async (t) => {
    if ((await detectEncoder()) === "none") {
      return t.skip("本机没有 lame/ffmpeg");
    }
    const res = await fetch(`${base}/api/v3/tts/unidirectional`, {
      method: "POST",
      headers: HEADERS,
      body: payload("好的，明天从深圳到黄山的长途我记下了。"),
    });
    const audio = concatAudio(frames(await res.text()));
    assert.ok(audio.length > 0);
    // MPEG audio frame sync：11 个 1（0xFF Ex/Fx），或 ID3 头。
    const isId3 = audio.toString("ascii", 0, 3) === "ID3";
    const isSync = audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0;
    assert.ok(isId3 || isSync, `不像 mp3：前 4 字节 ${audio.subarray(0, 4).toString("hex")}`);
  });

  it("长文本会切成多帧（分帧行为本身要被覆盖到）", async () => {
    const res = await fetch(`${base}/api/v3/tts/unidirectional`, {
      method: "POST",
      headers: HEADERS,
      // wav 体积大，一句话就能跨过 16 KiB 的切片阈值
      body: payload("这是一段用来验证分帧的比较长的中文播报文本。".repeat(3), "wav"),
    });
    const list = frames(await res.text());
    assert.ok(
      list.filter((f) => typeof f.data === "string").length > 1,
      "长文本应该切成多帧",
    );
  });

  it("pcm 是裸采样，不带 RIFF 头", async () => {
    const res = await fetch(`${base}/api/v3/tts/unidirectional`, {
      method: "POST",
      headers: HEADERS,
      body: payload("你好", "pcm"),
    });
    const audio = concatAudio(frames(await res.text()));
    assert.ok(audio.length > 0);
    assert.notEqual(audio.toString("ascii", 0, 4), "RIFF");
  });
});

describe("运维端点", () => {
  it("/health 打出引擎与编码器", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; engine: string; provenance: string };
    assert.equal(body.ok, true);
    assert.equal(body.engine, "macos-say");
    // 与 mock-dealer / mock-cabin 同一条纪律：上游要能如实标注数据来源。
    assert.equal(body.provenance, "simulated");
  });

  it("未知路径 404", async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  });
});
