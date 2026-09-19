/**
 * [F-20-03][AC-20-1] 端侧检测器当第一遍（施工单 M80-07）：像素框 → 0–1000 归一化、类别名只作 symbolHint 带出去（M80-15）、
 * frame 留空、服务出错抛 VisionProviderError；它不做描述与核验；env 选档只允许它当检测那一遍。
 * fetch 用桩——训练服务不在单测里起。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VisionProviderError, composeVisionProvider, createDeepSeekVisionProvider, createVisionProviderFromEnv } from "../src/vision/provider";
import { createYoloDetectProvider, toNormalizedBBox } from "../src/vision/yolo";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

function fakeFetch(reply: { status?: number; body: unknown }): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

/** 2026-09-09 真跑 tesla-01（2000×1333）时训练服务的原样响应，两个框、两个错名字。 */
const PREDICT_TESLA = {
  ok: true,
  detections: [
    { cls: 24, name: "regen_limited", conf: 0.2774, xyxy: [1115.7, 487.4, 1192.4, 526.6] },
    { cls: 7, name: "airbag_warning", conf: 0.2607, xyxy: [1131.0, 585.0, 1195.4, 648.4] },
  ],
  imageW: 2000,
  imageH: 1333,
  ms: 73,
};

describe("[F-20-03][AC-20-1] yolo 检测 provider", () => {
  it("请求：POST /predict 带 model / conf / imgsz，原始字节当 body，content-type 按魔数", async () => {
    const ff = fakeFetch({ body: PREDICT_TESLA });
    const p = createYoloDetectProvider({ baseURL: "http://localhost:8799/", model: "train-x", conf: 0.3, imgsz: 1280, fetch: ff.fetch });
    await p.detect(PNG);
    const { url, init } = ff.calls[0];
    assert.equal(url, "http://localhost:8799/predict?model=train-x&conf=0.3&imgsz=1280");
    assert.equal(init.method, "POST");
    assert.equal((init.headers as Record<string, string>)["content-type"], "image/png");
    assert.equal(p.name, "yolo");
    assert.deepEqual(p.models, { detect: "yolo:train-x", describe: "-" });
  });

  it("缺省推理边长 = 训练尺寸 960（1280 会让误报翻倍，1600 以上零框）", async () => {
    const ff = fakeFetch({ body: PREDICT_TESLA });
    await createYoloDetectProvider({ baseURL: "http://t", model: "m", fetch: ff.fetch }).detect(PNG);
    assert.ok(ff.calls[0].url.endsWith("&imgsz=960"), ff.calls[0].url);
  });

  it("像素框 → 0–1000 归一化整数框；类别一律 warning_light，**类别名只作 symbolHint**（M80-15）；frame 留空", async () => {
    const ff = fakeFetch({ body: PREDICT_TESLA });
    const r = await createYoloDetectProvider({ baseURL: "http://t", model: "m", fetch: ff.fetch }).detect(PNG);
    assert.equal(r.frame.item_count, 2);
    assert.deepEqual(r.frame.cut_off_sides, [], "yolo 不知道有没有裁到边");
    assert.deepEqual(r.items[0].bbox, [558, 366, 596, 395]);
    assert.deepEqual(r.items[1].bbox, [566, 439, 598, 486]);
    for (const [i, it] of r.items.entries()) {
      assert.equal(it.category, "warning_light");
      assert.ok(!("name" in it) && it.literal === undefined && it.shape === undefined, "检测器的名字不占描述子字段");
      assert.equal(it.symbolHint, PREDICT_TESLA.detections[i].name);
    }
    assert.equal(r.items[0].confidence, 0.2774);
  });

  it("缺省 conf 0.3（ACR-045：G 版权重 0.3 认对不变、多报更少）", async () => {
    const ff = fakeFetch({ body: PREDICT_TESLA });
    await createYoloDetectProvider({ baseURL: "http://t", model: "m", fetch: ff.fetch }).detect(PNG);
    assert.match(ff.calls[0].url, /conf=0\.3&/);
  });

  it("归一化：贴边裁剪、退化框丢弃、零尺寸图返回 null", () => {
    assert.deepEqual(toNormalizedBBox([-5, -5, 2005, 1340], 2000, 1333), [0, 0, 1000, 1000]);
    assert.equal(toNormalizedBBox([10, 10, 10.2, 10.1], 2000, 1333), null, "四舍五入后右下不大于左上就丢");
    assert.equal(toNormalizedBBox([0, 0, 10, 10], 0, 0), null);
  });

  it("没框到东西 → 空 items、item_count 0，不抛", async () => {
    const ff = fakeFetch({ body: { ok: true, detections: [], imageW: 100, imageH: 100 } });
    const r = await createYoloDetectProvider({ baseURL: "http://t", model: "m", fetch: ff.fetch }).detect(PNG);
    assert.equal(r.items.length, 0);
    assert.equal(r.frame.item_count, 0);
  });

  it("服务 404（模型不存在）/ 不可达 → VisionProviderError，让 observePhoto 收成 unreadable", async () => {
    const nf = fakeFetch({ status: 404, body: { error: "model_not_found" } });
    await assert.rejects(createYoloDetectProvider({ baseURL: "http://t", model: "nope", fetch: nf.fetch }).detect(PNG), (e: unknown) => e instanceof VisionProviderError && /model_not_found/.test((e as Error).message));
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await assert.rejects(createYoloDetectProvider({ baseURL: "http://t", model: "m", fetch: dead }).detect(PNG), /不可达/);
  });

  it("它不做描述、不做核验——这两遍必须由 composeVisionProvider 派给视觉模型", async () => {
    const ff = fakeFetch({ body: PREDICT_TESLA });
    const yolo = createYoloDetectProvider({ baseURL: "http://t", model: "m", fetch: ff.fetch });
    await assert.rejects(yolo.describe(PNG, { bbox: [1, 1, 2, 2], category: "warning_light" }), /只做检测/);
    await assert.rejects(yolo.verifyPair(PNG, PNG), /只做检测/);
    const ds = fakeFetch({ body: { choices: [{ message: { content: JSON.stringify({ category: "warning_light", shape: "person", color: "red", state: "lit", elements: ["diagonal_band"], text: [], literal: "", confidence: 0.9, quality: {}, undeterminable: [] }) } }] } });
    const mixed = composeVisionProvider(yolo, createDeepSeekVisionProvider({ apiKey: "k", fetch: ds.fetch }));
    assert.equal(mixed.name, "yolo+deepseek");
    assert.equal(mixed.models.detect, "yolo:m");
    await mixed.detect(PNG);
    await mixed.describe(PNG, { bbox: [1, 1, 2, 2], category: "warning_light" });
    assert.equal(ff.calls.length, 1, "检测打训练服务");
    assert.equal(ds.calls.length, 1, "描述打 DeepSeek");
  });

  it("env：yolo 只能当检测那一遍；缺 VISION_TRAINER_URL / CARLIFE_VISION_YOLO_MODEL 启动期就抛", () => {
    const base = { DASHSCOPE_API_KEY: "k", DEEPSEEK_API_KEY: "k2", VISION_TRAINER_URL: "http://localhost:8799", CARLIFE_VISION_YOLO_MODEL: "train-x" };
    assert.equal(createVisionProviderFromEnv({ ...base, CARLIFE_VISION_DETECT_PROVIDER: "yolo", CARLIFE_VISION_DESCRIBE_PROVIDER: "deepseek" })?.name, "yolo+deepseek");
    assert.equal(createVisionProviderFromEnv({ ...base, CARLIFE_VISION_DETECT_PROVIDER: "yolo" })?.name, "yolo+dashscope");
    assert.throws(() => createVisionProviderFromEnv({ ...base, CARLIFE_VISION_DESCRIBE_PROVIDER: "yolo" }), /描述那一遍不能选 yolo/);
    assert.throws(() => createVisionProviderFromEnv({ ...base, VISION_TRAINER_URL: "", CARLIFE_VISION_DETECT_PROVIDER: "yolo" }), /VISION_TRAINER_URL/);
    assert.throws(() => createVisionProviderFromEnv({ ...base, CARLIFE_VISION_YOLO_MODEL: "", CARLIFE_VISION_DETECT_PROVIDER: "yolo" }), /CARLIFE_VISION_YOLO_MODEL/);
  });
});
