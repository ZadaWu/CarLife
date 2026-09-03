/**
 * 会话详情的引擎标注（M60-01）：ASR 用了哪个档、TTS 下发了哪个档。
 *
 * 盯三件事，每一件都是"标签会说谎"的一种方式：
 *
 *  1. **闸门降级时标签必须报实际用的那个**。ACR-016 的闸门在超限时把 provider
 *     换成本机 mock，而配置里写的还是 aliyun——标签若去问配置，会把一次
 *     **免费的**转写记成云端档，等于在账面上记一笔没花的钱。
 *  2. **免费档也要有标签**。`llmUsage` 里 mock/fake 档没有行（它们不调 onUsage），
 *     所以这两个值只能来自这条路；漏了它们，界面上就分不清"用了 mock"与
 *     "这条老数据没记录"。
 *  3. **TTS 标签的语义是「下发档位」不是「已播放」**。合成在端上发生，服务端
 *     不知道那一句最终有没有出声。这条由界面措辞与 schema 注释共同守，
 *     这里只断言值的来源是 resolveTts 而不是别处。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { AudioMeta } from "@carlife/shared";

import { createHttpRouter, type AsrGate } from "../src/http";
import { SessionBus } from "../src/stream/session-bus";
import type { AsrProvider } from "../src/asr";

const meta: AudioMeta = { durationMs: 1200, format: "pcm_s16le", sampleRateHz: 16_000, channels: 1 };

const providerOf = (text: string): AsrProvider => ({
  async transcribe() {
    return text;
  },
});

/** 只记下 appendMessage 收到了什么的假仓储。 */
function recordingRepo(appended: Array<{ role: string; meta: unknown }>) {
  return {
    async sessionState() {
      return { exists: true, closedAt: null, lastActiveAt: new Date() };
    },
    async sessionUserId() {
      return "u1";
    },
    async appendMessage(m: { role: string }, metaArg?: unknown) {
      appended.push({ role: m.role, meta: metaArg });
    },
  } as never;
}

async function postAudio(app: express.Express, sessionId = "sess-x"): Promise<number> {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/session/${sessionId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "audio/pcm_s16le",
        "x-audio-meta": JSON.stringify(meta),
      },
      body: new Uint8Array(32),
    });
    return r.status;
  } finally {
    server.close();
  }
}

function appWith(gate: AsrGate | undefined, appended: Array<{ role: string; meta: unknown }>) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = "u1";
    next();
  });
  app.use(
    createHttpRouter(
      recordingRepo(appended),
      new SessionBus(),
      providerOf("云端识别"),
      undefined,
      undefined,
      gate,
    ),
  );
  return app;
}

describe("ASR 档位标注", () => {
  it("正常档：标签是闸门给的档位", async () => {
    const appended: Array<{ role: string; meta: unknown }> = [];
    await postAudio(appWith(async () => ({ provider: providerOf("x"), engine: "aliyun" }), appended));
    const user = appended.find((a) => a.role === "user");
    assert.deepEqual(user?.meta, { asrEngine: "aliyun" });
  });

  it("闸门降级：标签报 mock 而不是配置里的云档——否则等于记一笔没花的钱", async () => {
    const appended: Array<{ role: string; meta: unknown }> = [];
    // 闸门把 provider 换成本机档并如实回报 engine=mock（ACR-016 的降级路径）
    await postAudio(appWith(async () => ({ provider: providerOf("本地"), engine: "mock" }), appended));
    const user = appended.find((a) => a.role === "user");
    assert.deepEqual(user?.meta, { asrEngine: "mock" }, "降级后必须报实际用的那个");
  });

  it("免费档也有标签——llmUsage 里没有它们的行，这条路是唯一来源", async () => {
    for (const engine of ["mock", "fake"]) {
      const appended: Array<{ role: string; meta: unknown }> = [];
      await postAudio(appWith(async () => ({ provider: providerOf("x"), engine }), appended));
      assert.deepEqual(appended.find((a) => a.role === "user")?.meta, { asrEngine: engine });
    }
  });

  it("不注入闸门时标签为 null，不瞎猜一个档位", async () => {
    const appended: Array<{ role: string; meta: unknown }> = [];
    await postAudio(appWith(undefined, appended));
    assert.deepEqual(appended.find((a) => a.role === "user")?.meta, { asrEngine: null });
  });
});
