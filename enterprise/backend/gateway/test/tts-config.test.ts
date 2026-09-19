/**
 * 端上取合成端点（`GET /v1/tts/config`）。
 *
 * 两条盯得最紧的：
 *   **响应里绝不能出现密钥** —— 这条线是为"换个 URL"建的，
 *     顺手把 key 带上是最自然也最致命的一步（§8.2 A 类只写不读）。
 *   **配置层挂了要 503，不能给默认值** —— `TtsClient` 的默认端点是豆包，
 *     一次抖动就把开发机接上计费引擎，而且悄无声息。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { ConfigStore } from "@carlife/db";

import { createTtsConfigRouter } from "../src/http/tts-config";

/** 只喂 `runtimeValues`——路由用不到 ConfigStore 的其它面。 */
function storeOf(values: Record<string, string> | Error): ConfigStore {
  return {
    async runtimeValues() {
      if (values instanceof Error) throw values;
      return new Map(Object.entries(values));
    },
  } as unknown as ConfigStore;
}

function appWith(store: ConfigStore, userId: string | null = "demo-user") {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createTtsConfigRouter(store));
  return app;
}

async function get(app: express.Express, path: string) {
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, text: await r.text() };
  } finally {
    server.close();
  }
}

const body = (text: string) => JSON.parse(text) as Record<string, unknown>;

describe("GET /v1/tts/config", () => {
  it("未鉴权 401", async () => {
    assert.equal((await get(appWith(storeOf({}), null), "/v1/tts/config")).status, 401);
  });

  it("默认下发 mock 档", async () => {
    const r = await get(appWith(storeOf({})), "/v1/tts/config");
    assert.equal(r.status, 200);
    const b = body(r.text);
    assert.equal(b.engine, "mock");
    assert.equal(b.billed, false);
    // ACR-018：下发的是网关自己的合成端点，不是 mock-tts 的 8794。
    assert.match(String(b.url), /^http:\/\/127\.0\.0\.1:\d+\/v1\/tts\/speech$/);
    // 端上按它定复查间隔；缺了会退化成"每句播报一次往返"
    assert.ok(Number(b.refreshMs) > 0);
  });

  it("切到 doubao 仍标记计费，但**下发的仍是网关自己**（ACR-018）", async () => {
    const r = await get(appWith(storeOf({ TTS_ENGINE: "doubao" })), "/v1/tts/config");
    const b = body(r.text);
    assert.equal(b.engine, "doubao");
    assert.equal(b.billed, true);
    assert.match(String(b.url), /^http:\/\/127\.0\.0\.1:\d+\/v1\/tts\/speech$/);
  });

  /*
   * 端云边界的守门断言。上面几条按档位分开写，容易被"改一档忘一档"绕过；
   * 这一条把三档一起过一遍，且判据是**否定式**的：响应里不许出现任何
   * 供应商域名。新增第四档时它会先红。
   */
  it("任何档的下发里都不出现供应商域名", async () => {
    for (const engine of ["mock", "doubao", "aliyun"]) {
      const r = await get(appWith(storeOf({ TTS_ENGINE: engine })), "/v1/tts/config");
      assert.equal(r.text.includes("bytedance.com"), false, `${engine} 档下发了火山地址`);
      assert.equal(r.text.includes("aliyuncs.com"), false, `${engine} 档下发了阿里云地址`);
      assert.equal(r.text.includes("8794"), false, `${engine} 档下发了 mock-tts 地址`);
    }
  });

  it("响应里不含任何密钥 —— 哪怕配置表里满是密钥", async () => {
    const r = await get(
      appWith(
        storeOf({
          TTS_ENGINE: "doubao",
          BYTEDANCE_TTS_API_KEY: "sk-tts-secret",
          DEEPSEEK_API_KEY: "sk-llm-secret",
          CARLIFE_CONFIG_MASTER_KEY: "master-key-secret",
        }),
      ),
      "/v1/tts/config",
    );
    assert.equal(r.text.includes("sk-tts-secret"), false);
    assert.equal(r.text.includes("sk-llm-secret"), false);
    assert.equal(r.text.includes("master-key-secret"), false);
    // 字段白名单固定：多出来的字段就是下一个泄漏口
    assert.deepEqual(
      Object.keys(body(r.text)).sort(),
      ["billed", "engine", "keyRequired", "refreshMs", "resourceId", "speaker", "streamSpeech", "url"],
    );
  });

  it("aliyun 档：url 按请求 Host 补成网关门面的绝对地址，计费但端上不需要 vendor 密钥", async () => {
    const r = await get(
      appWith(storeOf({ TTS_ENGINE: "aliyun", DASHSCOPE_API_KEY: "sk-dash-secret" })),
      "/v1/tts/config",
    );
    const b = body(r.text);
    assert.equal(b.engine, "aliyun");
    assert.equal(b.billed, true);
    assert.equal(b.keyRequired, false);
    // 端上能打到 /v1/tts/config 就能打到同源门面；相对路径不许漏到端上。
    assert.match(String(b.url), /^http:\/\/127\.0\.0\.1:\d+\/v1\/tts\/speech$/);
    // DASHSCOPE 密钥与豆包密钥同一条纪律：不下端。
    assert.equal(r.text.includes("sk-dash-secret"), false);
  });

  it("keyRequired 恒 false——ACR-018 之后端上不持有任何 vendor 密钥", async () => {
    for (const engine of ["doubao", "mock", "aliyun"]) {
      const b = body((await get(appWith(storeOf({ TTS_ENGINE: engine })), "/v1/tts/config")).text);
      assert.equal(b.keyRequired, false, `${engine} 档不该要求端上有 key`);
    }
  });

  it("配置层不可用时 503，不给默认端点", async () => {
    const r = await get(appWith(storeOf(new Error("db down"))), "/v1/tts/config");
    assert.equal(r.status, 503);
    // 关键：不能顺手回一份"默认配置"——那份默认是**豆包**
    assert.equal(r.text.includes("openspeech.bytedance.com"), false);
  });
});

describe("边收边播开关下发（M77 走查追修第二步）", () => {
  it("默认关：没配过 TTS_STREAM_SPEECH 时下发 false", async () => {
    const r = await get(appWith(storeOf({ TTS_ENGINE: "mock" })), "/v1/tts/config");
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text) as { streamSpeech: boolean };
    assert.equal(body.streamSpeech, false, "默认必须是关——它改的是播报形状，不该由缺省值替车主决定");
  });

  it("只有恰好是 on 才开：其它值（含 true/1/ON）一律当关", async () => {
    for (const v of ["on"]) {
      const r = await get(appWith(storeOf({ TTS_ENGINE: "mock", TTS_STREAM_SPEECH: v })), "/v1/tts/config");
      assert.equal((JSON.parse(r.text) as { streamSpeech: boolean }).streamSpeech, true, `${v} 该开`);
    }
    // 拼错的值不该被"宽容"成开——宽容的代价是没人知道它其实开着
    for (const v of ["off", "true", "1", "ON", "yes", ""]) {
      const r = await get(appWith(storeOf({ TTS_ENGINE: "mock", TTS_STREAM_SPEECH: v })), "/v1/tts/config");
      assert.equal((JSON.parse(r.text) as { streamSpeech: boolean }).streamSpeech, false, `${JSON.stringify(v)} 不该开`);
    }
  });

  it("开关不影响这条线的老纪律：响应里仍然没有任何密钥", async () => {
    const r = await get(
      appWith(storeOf({ TTS_ENGINE: "doubao", TTS_STREAM_SPEECH: "on", BYTEDANCE_TTS_API_KEY: "sk-绝不能出现" })),
      "/v1/tts/config",
    );
    assert.doesNotMatch(r.text, /sk-|API_KEY|绝不能出现/i);
  });
});
