/**
 * `research.code` 消费者（施工单 M82-04）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";

import { MockLanguageModelV1 } from "ai/test";

import { loadLatestCodebook } from "../src/codebook/load";
import { handleCodeJob } from "../src/queue/code-handler";
import type { ResearchModel } from "../src/llm";

const book = loadLatestCodebook(join(new URL("..", import.meta.url).pathname.replace(/\/$/, ""), "codebooks"));

const coding = (unitId: string) => ({
  unitId,
  uncertain: false,
  scene: { code: "cabin", confidence: 0.9, rationale: "问按钮" },
  need_pain: [{ code: "feature-discovery", confidence: 0.9, rationale: "找不到功能" }],
  job: { code: "understand-car", confidence: 0.9, rationale: "想搞懂" },
  emotion: { code: "confusion", confidence: 0.7, rationale: "不知道是什么", intensity: 1, competing: null },
  deliverability: { code: "deliverable", confidence: 0.9, rationale: "可解释" },
  polarity: { code: "question", confidence: 0.9, rationale: "提问" },
});

function makeModel(): { model: ResearchModel; calls: () => number } {
  let n = 0;
  const model = new MockLanguageModelV1({
    defaultObjectGenerationMode: "json",
    doGenerate: async () => {
      n += 1;
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "stop" as const,
        usage: { promptTokens: 50, completionTokens: 30 },
        text: JSON.stringify({ codings: [coding("unit-1")] }),
      };
    },
  });
  return { model: { kind: "coder", agent: "research-coder", modelName: "deepseek-flash", model }, calls: () => n };
}

function fakeRepo(rows: Record<string, Record<string, unknown> | null>) {
  const inserted: Array<Record<string, unknown>> = [];
  return {
    inserted,
    repo: {
      units: { byId: async (id: string) => rows[id] ?? null },
      codings: {
        insertMany: async (xs: readonly Record<string, unknown>[]) => {
          inserted.push(...xs);
          return xs.length;
        },
      },
    } as never,
  };
}

const UNIT = {
  id: "unit-1",
  textRedacted: "这个按钮是干什么用的",
  context: { route: "cabin" },
};

describe("[M82-04] research.code 消费者", () => {
  it("空 unitIds 直接完成，不调模型", async () => {
    const { model, calls } = makeModel();
    const { repo } = fakeRepo({});
    const out = await handleCodeJob({ unitIds: [], codebookVersion: "0.1.0" }, { repo, model, systemPrompt: "p", book });
    assert.deepEqual(out, { units: 0, codings: 0, skipped: true });
    assert.equal(calls(), 0);
  });

  it("单元都取不到时也不调模型", async () => {
    const { model, calls } = makeModel();
    const { repo } = fakeRepo({ "unit-1": null });
    const out = await handleCodeJob({ unitIds: ["unit-1"], codebookVersion: "0.1.0" }, { repo, model, systemPrompt: "p", book });
    assert.equal(out.skipped, true);
    assert.equal(calls(), 0);
  });

  it("行为单元（没有脱敏文本）被跳过——它没有可编码的话语", async () => {
    const { model, calls } = makeModel();
    const { repo } = fakeRepo({ "unit-1": { id: "unit-1", textRedacted: null, context: {} } });
    const out = await handleCodeJob({ unitIds: ["unit-1"], codebookVersion: "0.1.0" }, { repo, model, systemPrompt: "p", book });
    assert.equal(out.skipped, true);
    assert.equal(calls(), 0);
  });

  it("正常一批：编码落库，带 codebook 版本 / coder / prompt_hash", async () => {
    const { model } = makeModel();
    const { repo, inserted } = fakeRepo({ "unit-1": UNIT });
    const out = await handleCodeJob({ unitIds: ["unit-1"], codebookVersion: "0.1.0" }, { repo, model, systemPrompt: "p", book });

    assert.equal(out.units, 1);
    assert.equal(out.codings, 6);
    assert.equal(inserted.length, 6);
    for (const row of inserted) {
      assert.equal(row.codebookVersion, "0.1.0");
      assert.equal(row.coder, "deepseek-flash");
      assert.match(String(row.promptHash), /^[0-9a-f]{64}$/);
    }
  });

  it("用量经回调交出去，reasoning 恒 0", async () => {
    const { model } = makeModel();
    const { repo } = fakeRepo({ "unit-1": UNIT });
    const seen: Array<{ reasoningTokens: number; agent: string }> = [];
    await handleCodeJob(
      { unitIds: ["unit-1"], codebookVersion: "0.1.0" },
      { repo, model, systemPrompt: "p", book, recordUsage: async (u) => void seen.push(u) },
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].agent, "research-coder");
    assert.equal(seen[0].reasoningTokens, 0);
  });
});
