/**
 * [F-20-03][AC-20-1] provider：DashScope 请求体形状（模型、温度 0、data URL、超时）、解析失败重跑一次、
 * HTTP 错误抛 VisionProviderError；fake provider 按 sha8 回放；按 env 选档。
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  DEFAULT_DEEPSEEK_VISION,
  VisionProviderError,
  composeVisionProvider,
  createDashScopeVisionProvider,
  createDeepSeekVisionProvider,
  createFakeVisionProvider,
  createVisionProviderFromEnv,
  defaultDetectVendor,
  extractJsonObject,
  sha8,
  visionModeFromEnv,
} from "../src/vision/provider";

const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function fakeFetch(replies: Array<{ status?: number; content?: string; body?: unknown }>): { fetch: typeof fetch; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const r = replies[Math.min(i, replies.length - 1)];
    i += 1;
    const payload = r.body ?? { choices: [{ message: { content: r.content ?? "" } }] };
    return new Response(JSON.stringify(payload), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const DETECT_OK = JSON.stringify({ frame: { quality: {}, cut_off_sides: ["right"], item_count: 1 }, items: [{ category: "warning_light", bbox: [1, 2, 30, 40], confidence: 0.9 }] });

describe("[F-20-03][AC-20-1] DashScope provider", () => {
  it("请求体：模型名、温度 0、data URL、system 提示词；命中兼容口 chat/completions", async () => {
    const ff = fakeFetch([{ content: DETECT_OK }]);
    const p = createDashScopeVisionProvider({ apiKey: "k", fetch: ff.fetch, detectModel: "m-detect", describeModel: "m-desc" });
    const r = await p.detect(IMG);
    assert.equal(r.items.length, 1);
    assert.deepEqual(r.frame.cut_off_sides, ["right"]);
    const call = ff.calls[0];
    assert.ok(call.url.endsWith("/compatible-mode/v1/chat/completions"));
    assert.equal(call.body.model, "m-detect");
    assert.equal(call.body.temperature, 0);
    const msgs = call.body.messages as Array<{ role: string; content: unknown }>;
    assert.equal(msgs[0].role, "system");
    const user = msgs[1].content as Array<{ type: string; image_url?: { url: string } }>;
    assert.ok(user[0].image_url!.url.startsWith("data:image/png;base64,"));
  });
  it("解析失败重跑一次；第二次成功就算成功", async () => {
    const ff = fakeFetch([{ content: "```json\n{not json" }, { content: "```json\n" + DETECT_OK + "\n```" }]);
    const p = createDashScopeVisionProvider({ apiKey: "k", fetch: ff.fetch });
    const r = await p.detect(IMG);
    assert.equal(ff.calls.length, 2);
    assert.equal(r.items.length, 1);
  });
  it("两次都不可解析 → VisionProviderError；HTTP 错误 → VisionProviderError 且不重试", async () => {
    const bad = fakeFetch([{ content: "no" }]);
    await assert.rejects(createDashScopeVisionProvider({ apiKey: "k", fetch: bad.fetch }).detect(IMG), VisionProviderError);
    assert.equal(bad.calls.length, 2);
    const http = fakeFetch([{ status: 500, body: { error: { code: "x" } } }]);
    await assert.rejects(createDashScopeVisionProvider({ apiKey: "k", fetch: http.fetch }).detect(IMG), /HTTP 500/);
    assert.equal(http.calls.length, 1);
  });
  it("describe 用描述档模型、schema 校验描述子；verifyPair 两张图、只认三选一", async () => {
    const ff = fakeFetch([
      { content: JSON.stringify({ category: "warning_light", shape: "person", color: "red", state: "lit", text: [], elements: ["diagonal_band"], literal: "红色 人形 斜带", confidence: 1, quality: {}, undeterminable: [] }) },
      { content: JSON.stringify({ verdict: "same" }) },
    ]);
    const p = createDashScopeVisionProvider({ apiKey: "k", fetch: ff.fetch, describeModel: "m-desc" });
    const d = await p.describe(IMG, { bbox: [1, 2, 3, 4], category: "warning_light" });
    assert.equal(d.shape, "person");
    assert.equal(ff.calls[0].body.model, "m-desc");
    assert.equal(await p.verifyPair(IMG, IMG), "same");
    const user = (ff.calls[1].body.messages as Array<{ content: unknown }>)[1].content as unknown[];
    assert.equal(user.filter((c) => (c as { type: string }).type === "image_url").length, 2);
  });
  it("extractJsonObject 剥围栏与前后文", () => {
    assert.equal(extractJsonObject("好的：```json\n{\"a\":1}\n```谢谢"), '{"a":1}');
  });
});

describe("[F-20-03][AC-20-1] DeepSeek provider 与两遍混搭（M80-05）", () => {
  it("**必须显式关思考**——v4 全系默认开，开着的话 token 全烧在 reasoning 上、正文是空字符串", async () => {
    const ff = fakeFetch([{ content: DETECT_OK }]);
    const p = createDeepSeekVisionProvider({ apiKey: "k", fetch: ff.fetch });
    await p.detect(IMG);
    assert.deepEqual(ff.calls[0].body.thinking, { type: "disabled" });
    assert.ok(ff.calls[0].url.startsWith("https://api.deepseek.com/"), ff.calls[0].url);
    assert.ok(ff.calls[0].url.endsWith("/chat/completions"));
  });

  it("两遍缺省同一个模型（它没有检测 / 描述之分），显式给了就用显式的", async () => {
    const ff = fakeFetch([{ content: DETECT_OK }]);
    const p = createDeepSeekVisionProvider({ apiKey: "k", fetch: ff.fetch });
    assert.equal(p.name, "deepseek");
    assert.equal(p.models.detect, DEFAULT_DEEPSEEK_VISION);
    assert.equal(p.models.describe, DEFAULT_DEEPSEEK_VISION);
    assert.equal(createDeepSeekVisionProvider({ apiKey: "k", fetch: ff.fetch, describeModel: "x" }).models.describe, "x");
  });

  it("**检测走一家、描述与核验走另一家**：定位精度与描述质量实测不在同一家手里", async () => {
    const a = fakeFetch([{ content: DETECT_OK }]);
    const b = fakeFetch([{ content: JSON.stringify({ category: "warning_light", shape: "person", color: "red", state: "lit", elements: ["diagonal_band"], text: [], literal: "", confidence: 0.9, quality: {}, undeterminable: [] }) }]);
    const mixed = composeVisionProvider(
      createDashScopeVisionProvider({ apiKey: "k", fetch: a.fetch, detectModel: "qwen3-vl-flash" }),
      createDeepSeekVisionProvider({ apiKey: "k2", fetch: b.fetch }),
    );
    assert.equal(mixed.name, "dashscope+deepseek");
    assert.equal(mixed.models.detect, "qwen3-vl-flash");
    assert.equal(mixed.models.describe, DEFAULT_DEEPSEEK_VISION);
    await mixed.detect(IMG);
    await mixed.describe(IMG, { bbox: [1, 2, 30, 40], category: "warning_light" });
    assert.equal(a.calls.length, 1, "检测只打第一家");
    assert.equal(b.calls.length, 1, "描述只打第二家");
    assert.ok(a.calls[0].url.includes("dashscope"));
    assert.ok(b.calls[0].url.includes("deepseek"));
  });

  /*
   * 零框兜底（2026-09-19）：describe 那一家本来就是个会整图定位的视觉模型，只是精度不如专训的检测器。
   * 第一遍什么都没框到时那一刻的对照项是"什么都没有"，不用白不用 ——
   * 这也是 ACR-045 写下的「云端定位从此只是兜底」头一次有落点。
   */
  it("两家混搭时 describe 那一家兼任零框兜底；同一家时不装这个方法", async () => {
    const a = fakeFetch([{ content: DETECT_OK }]);
    const b = fakeFetch([{ content: DETECT_OK }]);
    const mixed = composeVisionProvider(
      createDashScopeVisionProvider({ apiKey: "k", fetch: a.fetch }),
      createDeepSeekVisionProvider({ apiKey: "k2", fetch: b.fetch }),
    );
    await mixed.detectFallback!(IMG);
    assert.equal(a.calls.length, 0, "兜底不该回头再问第一家");
    assert.equal(b.calls.length, 1);
    const same = createDashScopeVisionProvider({ apiKey: "k", fetch: a.fetch });
    assert.equal(composeVisionProvider(same, same).detectFallback, undefined, "同一家没有第二个人可问");
  });

  it("env：CARLIFE_VISION=deepseek 缺密钥就抛；两遍可各指一家；同一家时不套壳", () => {
    assert.throws(() => createVisionProviderFromEnv({ CARLIFE_VISION: "deepseek" }), /DEEPSEEK_API_KEY/);
    assert.equal(createVisionProviderFromEnv({ CARLIFE_VISION: "deepseek", DEEPSEEK_API_KEY: "k" })?.name, "deepseek");
    const mixed = createVisionProviderFromEnv({
      DASHSCOPE_API_KEY: "k",
      DEEPSEEK_API_KEY: "k2",
      CARLIFE_VISION_DESCRIBE_PROVIDER: "deepseek",
      CARLIFE_VISION_DETECT_MODEL: "qwen3-vl-flash",
      CARLIFE_VISION_DESCRIBE_MODEL: "deepseek-flash",
    });
    assert.equal(mixed?.name, "dashscope+deepseek");
    assert.equal(mixed?.models.detect, "qwen3-vl-flash");
    assert.equal(mixed?.models.describe, "deepseek-flash");
    // 两遍同一家：不该出现「dashscope+dashscope」这种套了一层的名字
    assert.equal(createVisionProviderFromEnv({ DASHSCOPE_API_KEY: "k" })?.name, "dashscope");
  });
});

describe("[F-20-03][AC-20-1] fake provider 与 env 选档", () => {
  it("按图片 sha8 回放：detect 取框、describe 按 bbox 找回描述子、无 fixture 抛错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vision-fx-"));
    writeFileSync(
      join(dir, `${sha8(IMG)}.json`),
      JSON.stringify({
        frame: { quality: {}, cut_off_sides: [], item_count: 1 },
        items: [{ category: "warning_light", bbox: [1, 2, 30, 40], shape: "lamp", color: "green", state: "lit", text: [], elements: ["straight_lines"], literal: "绿色 灯形 直线", confidence: 1, quality: {}, undeterminable: [] }],
      }),
    );
    const p = createFakeVisionProvider({ fixturesDir: dir });
    const r = await p.detect(IMG);
    assert.equal(r.items[0].category, "warning_light");
    const d = await p.describe(IMG, { bbox: [1, 2, 30, 40], category: "warning_light" });
    assert.equal(d.shape, "lamp");
    await assert.rejects(p.describe(IMG, { bbox: [9, 9, 10, 10], category: "warning_light" }), /没有 bbox/);
    await assert.rejects(p.detect(Buffer.from("other")), /无 fixture/);
  });
  it("CARLIFE_VISION：off → null；fake → fake；dashscope 缺密钥 → 抛；非法值当 dashscope", () => {
    assert.equal(createVisionProviderFromEnv({ CARLIFE_VISION: "off" }), null);
    assert.equal(createVisionProviderFromEnv({ CARLIFE_VISION: "fake", CARLIFE_VISION_FIXTURES: "/tmp/x" })?.name, "fake");
    assert.throws(() => createVisionProviderFromEnv({ CARLIFE_VISION: "dashscope" }), /DASHSCOPE_API_KEY/);
    assert.equal(createVisionProviderFromEnv({ DASHSCOPE_API_KEY: "k", CARLIFE_VISION_DESCRIBE_MODEL: "x" })?.models.describe, "x");
    assert.equal(visionModeFromEnv({ CARLIFE_VISION: "weird" }), "dashscope");
  });
});

describe("[F-20-03][AC-20-1] 检测缺省档：云端定位退役（ACR-045）", () => {
  it("训练服务与权重都配了 → 缺省 yolo；缺一样 → 退回 base 并说明是兜底；显式选了就按显式的", () => {
    const both = defaultDetectVendor({ VISION_TRAINER_URL: "http://localhost:8799", CARLIFE_VISION_YOLO_MODEL: "train-x" }, "dashscope");
    assert.equal(both.vendor, "yolo");
    const noModel = defaultDetectVendor({ VISION_TRAINER_URL: "http://localhost:8799" }, "dashscope");
    assert.equal(noModel.vendor, "dashscope");
    assert.match(noModel.reason, /退役.*CARLIFE_VISION_YOLO_MODEL/);
    assert.equal(defaultDetectVendor({}, "deepseek").vendor, "deepseek");
    assert.equal(defaultDetectVendor({ CARLIFE_VISION_DETECT_PROVIDER: "dashscope", VISION_TRAINER_URL: "http://x", CARLIFE_VISION_YOLO_MODEL: "m" }, "dashscope").vendor, "dashscope");
  });

  it("createVisionProviderFromEnv：配了训练服务与权重、没显式选 → 检测是 yolo、描述仍是 base", () => {
    const p = createVisionProviderFromEnv({ DASHSCOPE_API_KEY: "k", VISION_TRAINER_URL: "http://localhost:8799", CARLIFE_VISION_YOLO_MODEL: "train-x" });
    assert.equal(p?.name, "yolo+dashscope");
    assert.equal(createVisionProviderFromEnv({ DASHSCOPE_API_KEY: "k" })?.name, "dashscope", "什么都没配 → 兜底仍是云端");
  });
});
