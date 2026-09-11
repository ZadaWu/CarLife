import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_DEEPSEEK_MODEL, resolveDeepSeekModel } from "../src/constants";

describe("DeepSeek 模型统一配置", () => {
  it("默认模型是 deepseek-v4-flash", () => {
    assert.equal(DEFAULT_DEEPSEEK_MODEL, "deepseek-v4-flash");
    assert.equal(resolveDeepSeekModel(), DEFAULT_DEEPSEEK_MODEL);
    assert.equal(resolveDeepSeekModel(""), DEFAULT_DEEPSEEK_MODEL);
  });

  it("旧的 deepseek-chat 配置在读取时归一化", () => {
    assert.equal(resolveDeepSeekModel("deepseek-chat"), DEFAULT_DEEPSEEK_MODEL);
    assert.equal(resolveDeepSeekModel(" deepseek-chat "), DEFAULT_DEEPSEEK_MODEL);
  });

  it("非旧值保持原样，允许兼容端点使用自定义模型", () => {
    assert.equal(resolveDeepSeekModel("deepseek-v4-pro"), "deepseek-v4-pro");
  });
});

describe("DeepSeek 视觉档与每轮附件上限（M80）", () => {
  it("视觉档默认 deepseek-flash（V4.1 Flash 正式名，不靠别名），空值回落默认，非空原样", async () => {
    const { DEFAULT_DEEPSEEK_VISION_MODEL, resolveDeepSeekVisionModel } = await import("../src/constants");
    assert.equal(DEFAULT_DEEPSEEK_VISION_MODEL, "deepseek-flash");
    assert.equal(resolveDeepSeekVisionModel(), DEFAULT_DEEPSEEK_VISION_MODEL);
    assert.equal(resolveDeepSeekVisionModel("  "), DEFAULT_DEEPSEEK_VISION_MODEL);
    assert.equal(resolveDeepSeekVisionModel("deepseek-v4-pro-vision"), "deepseek-v4-pro-vision");
  });

  it("上限之间自洽：照片 + 视频 ≤ 总数；帧序图张数 = ceil(60s / 10s) = 6", async () => {
    const { TURN_ATTACHMENT_LIMITS: L, VIDEO_SHEET_PARAMS: V } = await import("../src/constants");
    assert.ok(L.maxImages + L.maxVideos <= L.maxTotal);
    assert.equal(Math.ceil(L.videoAnalyzedMs / V.segmentMs), 6);
    // 每张帧序图 5 帧：10s / 2s。
    assert.equal(V.segmentMs / V.frameIntervalMs, 5);
  });
});
