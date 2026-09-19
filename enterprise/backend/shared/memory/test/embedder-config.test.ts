/**
 * embedder 配置解析（施工单 M95-01）。**零依赖**：不连 DashScope、不连 Ollama。
 *
 * 要钉住的四件事：缺省是 DashScope 那组；key 的优先级；缺 key 给空串并只 warn 一次（不抛——
 * 抛会在 `new Memory()` 里打死 runtime 启动）；`ollama` 档不带 `apiKey` 字段。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  DASHSCOPE_EMBEDDING_BASE_URL,
  DASHSCOPE_EMBEDDING_MODEL,
  OLLAMA_EMBEDDING_BASE_URL,
  OLLAMA_EMBEDDING_MODEL,
  resetEmbedderWarnings,
  resolveEmbedderConfig,
} from "../src/embedder-config";

describe("resolveEmbedderConfig：缺省与 key 的取法（M95-01）", () => {
  beforeEach(() => resetEmbedderWarnings());

  it("空 env → openai / DashScope 兼容口 / text-embedding-v4 / 768，apiKey 是空串且 warn 一次", () => {
    const warnings: string[] = [];
    const r = resolveEmbedderConfig({}, (m) => warnings.push(m));
    assert.deepEqual(r, {
      provider: "openai",
      config: {
        model: DASHSCOPE_EMBEDDING_MODEL,
        baseURL: DASHSCOPE_EMBEDDING_BASE_URL,
        embeddingDims: 768,
        apiKey: "",
      },
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /缺 API key/);
    // 第二次解析不再 warn——runtime 里 defaultConfig() 可能被调多次，日志不该被刷屏。
    resolveEmbedderConfig({}, (m) => warnings.push(m));
    assert.equal(warnings.length, 1);
  });

  it("只有 DASHSCOPE_API_KEY → 回落用它，且不 warn", () => {
    const warnings: string[] = [];
    const r = resolveEmbedderConfig({ DASHSCOPE_API_KEY: "ds" }, (m) => warnings.push(m));
    assert.equal(r.config.apiKey, "ds");
    assert.equal(warnings.length, 0);
  });

  it("MEM0_EMBEDDING_API_KEY 优先于 DASHSCOPE_API_KEY", () => {
    const r = resolveEmbedderConfig({ MEM0_EMBEDDING_API_KEY: "mk", DASHSCOPE_API_KEY: "ds" });
    assert.equal(r.config.apiKey, "mk");
  });

  it("provider=ollama → 本机那组缺省，且没有 apiKey 字段", () => {
    const warnings: string[] = [];
    const r = resolveEmbedderConfig({ MEM0_EMBEDDING_PROVIDER: "ollama" }, (m) => warnings.push(m));
    assert.deepEqual(r, {
      provider: "ollama",
      config: { model: OLLAMA_EMBEDDING_MODEL, baseURL: OLLAMA_EMBEDDING_BASE_URL, embeddingDims: 768 },
    });
    assert.equal("apiKey" in r.config, false);
    assert.equal(warnings.length, 0, "ollama 没有 key 的概念，不该为缺 key 出声");
  });

  it("显式 MODEL / BASE_URL / DIMS 覆盖缺省，DIMS 是 number", () => {
    const r = resolveEmbedderConfig({
      DASHSCOPE_API_KEY: "ds",
      MEM0_EMBEDDING_MODEL: "text-embedding-v3",
      MEM0_EMBEDDING_BASE_URL: "https://example.test/v1",
      MEM0_EMBEDDING_DIMS: "1024",
    });
    assert.equal(r.config.model, "text-embedding-v3");
    assert.equal(r.config.baseURL, "https://example.test/v1");
    assert.equal(r.config.embeddingDims, 1024);
    assert.equal(typeof r.config.embeddingDims, "number");
  });
});
