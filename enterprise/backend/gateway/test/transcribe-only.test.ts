/**
 * 只转写通道（施工单 M25-01，F-52-01）。
 *
 * 这份测试盯两件事：
 *
 *  1. **不建轮。** 哨兵段的转写绝不能进会话——`repo.appendMessage` 与
 *     `bus.append` 一次都不许被调。这条是 AC-52-5（判定后即弃）在网关侧的一半；
 *     另一半（端上判定后丢弃）在 cockpit 的 Rust 测试里。
 *  2. **错误路径与既有音频分支同语义。** meta 非法 400、超长 400、ASR 挂 502——
 *     端上（M25-04 的显式降级）依赖这些码区分"我传错了"和"链路坏了"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { AudioMeta } from "@carlife/shared";
import { MAX_CAPTURE_DURATION_MS } from "@carlife/shared";

import { createHttpRouter } from "../src/http";
import { SessionBus } from "../src/stream/session-bus";

function meta(durationMs = 1200): AudioMeta {
  return { durationMs, format: "pcm_s16le", sampleRateHz: 16_000, channels: 1 };
}

/** 任何会话/消息操作被调都直接炸——本通道不该碰它们。 */
function explodingRepo(calls: string[]) {
  const boom = (name: string) => async () => {
    calls.push(name);
    throw new Error(`transcribe-only 不该调 repo.${name}`);
  };
  return {
    sessionExists: boom("sessionExists"),
    sessionState: boom("sessionState"),
    closeSession: boom("closeSession"),
    historyPage: boom("historyPage"),
    appendMessage: boom("appendMessage"),
    createSession: boom("createSession"),
    // M48-05：只转写路径不该碰会话归属；真被调到就是走错了路。
    sessionUserId: boom("sessionUserId"),
  } as never;
}

async function call(
  asr: { transcribe: (audio: Buffer, m: AudioMeta) => Promise<string> },
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ status: number; body: Record<string, unknown>; repoCalls: string[]; busEvents: number }> {
  const repoCalls: string[] = [];
  const bus = new SessionBus();
  let busEvents = 0;
  const origAppend = bus.append.bind(bus);
  bus.append = (...args: Parameters<typeof origAppend>) => {
    busEvents += 1;
    return origAppend(...args);
  };

  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = "u1";
    next();
  });
  app.use(createHttpRouter(explodingRepo(repoCalls), bus, asr as never));

  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/asr/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/pcm_s16le", ...headers },
      body,
    });
    return {
      status: r.status,
      body: (await r.json()) as Record<string, unknown>,
      repoCalls,
      busEvents,
    };
  } finally {
    server.close();
  }
}

const okAsr = { transcribe: async () => "你好暖暖" };

describe("POST /v1/asr/transcribe（只转写，不建轮）", () => {
  it("返回文本与时长，且 repo 与 bus 零触碰", async () => {
    const r = await call(okAsr, { "x-audio-meta": JSON.stringify(meta()) }, Buffer.from([1, 2]));
    assert.equal(r.status, 200);
    assert.equal(r.body.text, "你好暖暖");
    assert.equal(r.body.durationMs, 1200);
    assert.deepEqual(r.repoCalls, [], "不建轮：任何 repo 方法都不许被调");
    assert.equal(r.busEvents, 0, "不进事件总线");
  });

  it("meta 缺失或非法 → 400 invalid_audio_meta", async () => {
    for (const h of [{}, { "x-audio-meta": "not-json" }, { "x-audio-meta": "{}" }]) {
      const r = await call(okAsr, h, Buffer.from([1]));
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_audio_meta");
    }
  });

  it("超过时长上限 → 400 audio_too_long（与 /messages 音频分支同上限）", async () => {
    const r = await call(
      okAsr,
      { "x-audio-meta": JSON.stringify(meta(MAX_CAPTURE_DURATION_MS + 1)) },
      Buffer.from([1]),
    );
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "audio_too_long");
  });

  it("ASR 抛错 → 502 asr_failed，repo 仍零触碰", async () => {
    const bad = {
      transcribe: async () => {
        throw new Error("ark down");
      },
    };
    const r = await call(bad, { "x-audio-meta": JSON.stringify(meta()) }, Buffer.from([1]));
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "asr_failed");
    assert.deepEqual(r.repoCalls, []);
  });

  it("**空结果（非语音段）→ 200 空文本，不是 502**——502 会喂 TranscribeGuard 的连续失败计数，车内安静三段哨兵就降级、暖暖唤不醒（2026-08-28 CJK 守门上线当天真实踩到）", async () => {
    const empty = {
      transcribe: async () => {
        throw new Error("asr_empty_result");
      },
    };
    const r = await call(empty, { "x-audio-meta": JSON.stringify(meta()) }, Buffer.from([1]));
    assert.equal(r.status, 200);
    assert.equal(r.body.text, "");
    assert.equal(r.body.durationMs, 1200);
    assert.deepEqual(r.repoCalls, [], "空结果同样不建轮");
  });
});
