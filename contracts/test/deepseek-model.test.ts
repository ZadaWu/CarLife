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
