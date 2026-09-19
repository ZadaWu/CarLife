/**
 * Coder（施工单 M82-04）。用 AI SDK 自带的 `MockLanguageModelV1`，不打网络。
 *
 * 重试那两条是重点：模型偶尔吐不出合法 JSON 是常态，
 * **但"两次都不行"必须抛**——吞掉的表现是这批单元永远没有编码，
 * 而镜头上只是少了一点分子，看不出来。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";

import { MockLanguageModelV1 } from "ai/test";

import { loadLatestCodebook } from "../src/codebook/load";
import { codeBatch, promptHashOf, renderCodebookPrompt, type CodableUnit } from "../src/coding/coder";
import type { ResearchModel } from "../src/llm";

const book = loadLatestCodebook(join(new URL("..", import.meta.url).pathname.replace(/\/$/, ""), "codebooks"));

const units: CodableUnit[] = [
  { id: "u1", textRedacted: "天一冷这个续行掉得也太快了吧", context: { route: "ownership" } },
  { id: "u2", textRedacted: "这个按钮是干什么用的", context: { route: "cabin" } },
  { id: "u3", textRedacted: "你帮我把胎压调一下", context: { route: "ownership", guardHit: true } },
];

const codingFor = (unitId: string, over: Record<string, unknown> = {}) => ({
  unitId,
  uncertain: false,
  scene: { code: "charging", confidence: 0.9, rationale: "提到掉电" },
  need_pain: [{ code: "cold-range-loss", confidence: 0.9, rationale: "天冷" }],
  job: { code: "keep-charged", confidence: 0.8, rationale: "关心电量" },
  emotion: { code: "frustration", confidence: 0.7, rationale: "太快了吧", intensity: 2, competing: null },
  deliverability: { code: "deliverable", confidence: 0.9, rationale: "可解释" },
  polarity: { code: "complaint", confidence: 0.9, rationale: "抱怨" },
  ...over,
});

/** 让 mock 依次返回给定的正文；`null` 表示这一次返回一段非法 JSON。 */
function fakeModel(responses: Array<unknown | null>): { model: ResearchModel; calls: () => number } {
  let n = 0;
  const model = new MockLanguageModelV1({
    defaultObjectGenerationMode: "json",
    doGenerate: async () => {
      const r = responses[Math.min(n, responses.length - 1)];
      n += 1;
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "stop" as const,
        usage: { promptTokens: 120, completionTokens: 80 },
        text: r === null ? "这不是 JSON，模型开始讲道理了" : JSON.stringify(r),
      };
    },
  });
  return {
    model: { kind: "coder", agent: "research-coder", modelName: "deepseek-flash", model },
    calls: () => n,
  };
}

const deps = (m: ResearchModel) => ({ model: m, systemPrompt: "你是编码员。", book });

describe("[M82-04] Coder 编码", () => {
  it("三个单元 → 每个单元六个轴各出行（need_pain 一码一行）", async () => {
    const { model } = fakeModel([{ codings: units.map((u) => codingFor(u.id)) }]);
    const res = await codeBatch(units, deps(model));

    assert.equal(res.codings.length, 18, "3 单元 × 6 行");
    for (const u of units) {
      const mine = res.codings.filter((c) => c.unitId === u.id);
      assert.equal(mine.length, 6);
      assert.deepEqual(
        [...new Set(mine.map((c) => c.axis))].sort(),
        ["deliverability", "emotion", "job", "need_pain", "polarity", "scene"],
      );
    }
  });

  it("prompt_hash 与 coder 一起给出——换 prompt 或换模型不能与旧编码混算一致率", async () => {
    const { model } = fakeModel([{ codings: [codingFor("u1")] }]);
    const res = await codeBatch([units[0]], deps(model));
    assert.equal(res.coder, "deepseek-flash");
    assert.match(res.promptHash, /^[0-9a-f]{64}$/);
    // 换提示词 → 换 hash；换 codebook → 也换 hash。
    assert.notEqual(promptHashOf("A", book.hash), promptHashOf("B", book.hash));
    assert.notEqual(promptHashOf("A", book.hash), promptHashOf("A", "别的 hash"));
  });

  it("非法 JSON 一次后重试成功", async () => {
    const { model, calls } = fakeModel([null, { codings: [codingFor("u1")] }]);
    const res = await codeBatch([units[0]], deps(model));
    assert.equal(res.retried, true);
    assert.equal(calls(), 2);
    assert.equal(res.codings.length, 6);
  });

  it("两次都失败 → 抛 research_coder_failed，不吞", async () => {
    const { model, calls } = fakeModel([null, null]);
    await assert.rejects(() => codeBatch([units[0]], deps(model)), /research_coder_failed/);
    assert.equal(calls(), 2, "只重试一次，不无限重试");
  });

  it("空批不走模型——空任务也调一次是白花钱且污染合法 JSON 率", async () => {
    const { model, calls } = fakeModel([{ codings: [] }]);
    await assert.rejects(() => codeBatch([], deps(model)), /research_coder_empty_batch/);
    assert.equal(calls(), 0);
  });

  it("超过 20 个单元直接抛——分批是调用方的事", async () => {
    const { model } = fakeModel([{ codings: [] }]);
    const many = Array.from({ length: 21 }, (_, i) => ({ ...units[0], id: `u${i}` }));
    await assert.rejects(() => codeBatch(many, deps(model)), /research_coder_batch_too_large/);
  });

  it("用量带出来，reasoning_tokens 缺省是 0", async () => {
    const { model } = fakeModel([{ codings: [codingFor("u1")] }]);
    const res = await codeBatch([units[0]], deps(model));
    assert.equal(res.usage.agent, "research-coder");
    assert.equal(res.usage.reasoningTokens, 0);
    assert.ok(res.usage.promptTokens > 0);
  });
});

describe("[M82-04] 码表进提示词", () => {
  const rendered = renderCodebookPrompt(book);

  it("六个轴与它们的码都在", () => {
    for (const axis of book.axes) {
      assert.ok(rendered.includes(`\`${axis.id}\``), `缺轴 ${axis.id}`);
      for (const c of axis.codes) assert.ok(rendered.includes(`\`${c.id}\``), `缺码 ${axis.id}/${c.id}`);
    }
  });

  it("exclude 不省略——没有 exclude 的码会吸走整个语料", () => {
    for (const axis of book.axes) {
      for (const c of axis.codes) assert.ok(rendered.includes(c.exclude), `${axis.id}/${c.id} 的 exclude 没进提示词`);
    }
  });

  it("多选轴写明上限", () => {
    assert.match(rendered, /多选，最多 3 个/);
  });
});
