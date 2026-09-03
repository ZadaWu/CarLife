/**
 * TTS 引擎解析（`config/tts.ts`）。
 *
 * 这几条断言里最要紧的是两件事：
 *
 * 1. **回落方向**——认不出的引擎名必须落到 mock。反过来写（回落 doubao）
 *    单测一样会绿，而代价要到月底账单上才看得见。
 * 2. **下发给端上的 `url` 恒是网关自己**（ACR-018）。这一条是端云边界本身：
 *    只要它退回成供应商地址，端上就又要拿着 vendor 密钥直连了。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveTts, isTtsEngine, DOUBAO_TTS_URL, TTS_GATEWAY_PATH } from "../src/config/tts";

const values = (o: Record<string, string>) => new Map(Object.entries(o));

describe("resolveTts", () => {
  it("默认档是 mock，且不计费", () => {
    const r = resolveTts(values({}));
    assert.equal(r.engine, "mock");
    assert.equal(r.billed, false);
    assert.match(r.upstreamUrl, /^http:\/\/localhost:8794\//);
  });

  it("doubao 档的上游是官方端点并标记计费", () => {
    const r = resolveTts(values({ TTS_ENGINE: "doubao" }));
    assert.equal(r.engine, "doubao");
    assert.equal(r.upstreamUrl, DOUBAO_TTS_URL);
    assert.equal(r.billed, true);
  });

  it("MOCK_TTS_URL 可改（端口冲突时要能挪）", () => {
    const r = resolveTts(
      values({ TTS_ENGINE: "mock", MOCK_TTS_URL: "http://127.0.0.1:9999/api/v3/tts/unidirectional" }),
    );
    assert.equal(r.upstreamUrl, "http://127.0.0.1:9999/api/v3/tts/unidirectional");
  });

  /*
   * ACR-018 的核心断言。分开成三条 it 会让"三档都一样"这件事读起来像巧合，
   * 而它恰恰是刻意的：端上只认识一个后端。
   */
  it("三档下发给端上的 url 都是网关自己，供应商地址只在 upstreamUrl 里", () => {
    for (const engine of ["mock", "doubao", "aliyun"] as const) {
      const r = resolveTts(values({ TTS_ENGINE: engine }));
      assert.equal(r.url, TTS_GATEWAY_PATH, `${engine} 档不该把供应商地址下发到端上`);
    }
    // 反向断言：端上拿到的那个字段里，永远不该出现供应商域名。
    for (const engine of ["mock", "doubao", "aliyun"] as const) {
      const r = resolveTts(values({ TTS_ENGINE: engine }));
      assert.equal(r.url.includes("bytedance.com"), false);
      assert.equal(r.url.includes("aliyuncs.com"), false);
    }
  });

  it("认不出的引擎名回落 mock —— 回落方向永远是不花钱的那个", () => {
    for (const bad of ["Doubao", "DOUBAO", "bytedance", "seed-tts-2.0", "", "  "]) {
      const r = resolveTts(values({ TTS_ENGINE: bad }));
      assert.equal(r.engine, "mock", `"${bad}" 不该被当成豆包`);
      assert.equal(r.billed, false);
    }
  });

  it("首尾空格不影响正常取值（后台粘贴很容易带上）", () => {
    assert.equal(resolveTts(values({ TTS_ENGINE: " doubao " })).engine, "doubao");
  });

  it("音色与资源 id 跟着走，空串不覆盖默认值", () => {
    const r = resolveTts(
      values({ BYTEDANCE_TTS_SPEAKER: "zh_male_test", BYTEDANCE_TTS_RESOURCE_ID: "" }),
    );
    assert.equal(r.speaker, "zh_male_test");
    assert.equal(r.resourceId, "seed-tts-2.0");
  });

  it("解析结果里没有任何密钥字段（它会被下发到端上）", () => {
    const r = resolveTts(values({ BYTEDANCE_TTS_API_KEY: "sk-secret", DEEPSEEK_API_KEY: "sk-x" }));
    assert.equal(JSON.stringify(r).includes("sk-"), false);
  });

  // ── aliyun 档（ACR-015）
  it("aliyun 档：url 是网关门面的相对路径、计费但端上不需要 vendor 密钥", () => {
    const r = resolveTts(values({ TTS_ENGINE: "aliyun" }));
    assert.equal(r.engine, "aliyun");
    assert.equal(r.url, TTS_GATEWAY_PATH);
    // DashScope 的地址由 synthesizeDashScope 自己拼，这里没有可给的上游。
    assert.equal(r.upstreamUrl, "");
    assert.equal(r.billed, true);
    assert.equal(r.keyRequired, false);
    assert.equal(r.speaker, "Cherry");
    assert.equal(r.resourceId, "qwen3-tts-flash");
  });

  it("aliyun 档：模型与音色可换，DASHSCOPE 密钥不进解析结果", () => {
    const r = resolveTts(
      values({ TTS_ENGINE: "aliyun", ALIYUN_TTS_VOICE: "Serena", ALIYUN_TTS_MODEL: "qwen3-tts-instruct-flash", DASHSCOPE_API_KEY: "sk-ali" }),
    );
    assert.equal(r.speaker, "Serena");
    assert.equal(r.resourceId, "qwen3-tts-instruct-flash");
    assert.equal(JSON.stringify(r).includes("sk-"), false);
  });

  it("keyRequired 恒为 false——ACR-018 之后端上不持有任何 vendor 密钥", () => {
    for (const engine of ["mock", "doubao", "aliyun"] as const) {
      assert.equal(resolveTts(values({ TTS_ENGINE: engine })).keyRequired, false, engine);
    }
  });
});

describe("isTtsEngine", () => {
  it("只认三个值", () => {
    assert.equal(isTtsEngine("mock"), true);
    assert.equal(isTtsEngine("doubao"), true);
    assert.equal(isTtsEngine("aliyun"), true);
    assert.equal(isTtsEngine("say"), false);
    assert.equal(isTtsEngine(undefined), false);
  });
});
