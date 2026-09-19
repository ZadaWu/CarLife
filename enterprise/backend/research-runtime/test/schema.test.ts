/**
 * codebook → zod（施工单 M82-04）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";

import { loadLatestCodebook } from "../src/codebook/load";
import { batchCodingSchema, flatten, unitCodingSchema } from "../src/coding/schema";

const book = loadLatestCodebook(join(new URL("..", import.meta.url).pathname.replace(/\/$/, ""), "codebooks"));
const unitSchema = unitCodingSchema(book);

const entry = (code: string) => ({ code, confidence: 0.8, rationale: "依据「掉得太快」" });

const validUnit = () => ({
  unitId: "u1",
  uncertain: false,
  scene: entry("charging"),
  need_pain: [entry("cold-range-loss")],
  job: entry("keep-charged"),
  emotion: { ...entry("frustration"), intensity: 2, competing: null },
  deliverability: entry("deliverable"),
  polarity: entry("complaint"),
});

describe("[M82-04] 编码 schema", () => {
  it("合法结果通过", () => {
    assert.doesNotThrow(() => unitSchema.parse(validUnit()));
  });

  it("非法码被拒——码表是唯一真相源，schema 从它生成", () => {
    assert.throws(() => unitSchema.parse({ ...validUnit(), scene: entry("no-such-scene") }));
  });

  it("need_pain 超过 3 个被拒", () => {
    assert.throws(() =>
      unitSchema.parse({
        ...validUnit(),
        need_pain: [entry("range-anxiety"), entry("cold-range-loss"), entry("charger-availability"), entry("other")],
      }),
    );
  });

  it("need_pain 空数组被拒——「什么都不是」要显式选 none", () => {
    assert.throws(() => unitSchema.parse({ ...validUnit(), need_pain: [] }));
    assert.doesNotThrow(() => unitSchema.parse({ ...validUnit(), need_pain: [entry("none")] }));
  });

  it("emotion.intensity 超范围被拒", () => {
    const u = validUnit();
    assert.throws(() => unitSchema.parse({ ...u, emotion: { ...u.emotion, intensity: 4 } }));
    assert.throws(() => unitSchema.parse({ ...u, emotion: { ...u.emotion, intensity: -1 } }));
  });

  it("confidence 超范围被拒", () => {
    assert.throws(() => unitSchema.parse({ ...validUnit(), scene: { ...entry("commute"), confidence: 1.5 } }));
  });

  it("rationale 过长被拒——长了模型会开始讲道理而不是判断", () => {
    assert.throws(() => unitSchema.parse({ ...validUnit(), scene: { ...entry("commute"), rationale: "很".repeat(61) } }));
  });

  it("缺一轴被拒——不许用「没填」表示「判不出」", () => {
    const u = validUnit() as Record<string, unknown>;
    delete u.emotion;
    assert.throws(() => unitSchema.parse(u));
  });

  it("批 schema 上限 20", () => {
    const batch = batchCodingSchema(book);
    assert.doesNotThrow(() => batch.parse({ codings: Array.from({ length: 20 }, () => validUnit()) }));
    assert.throws(() => batch.parse({ codings: Array.from({ length: 21 }, () => validUnit()) }));
    assert.throws(() => batch.parse({ codings: [] }));
  });
});

describe("[M82-04] 展开成落库行", () => {
  it("六个轴 → 至少六行，多选轴一码一行", () => {
    const rows = flatten({ ...validUnit(), need_pain: [entry("range-anxiety"), entry("cold-range-loss")] });
    assert.equal(rows.length, 7, "5 个单选 + 2 个 need_pain");
    const axes = new Set(rows.map((r) => r.axis));
    assert.deepEqual([...axes].sort(), ["deliverability", "emotion", "job", "need_pain", "polarity", "scene"]);
  });

  it("情绪强度进 rationale 前缀（M82-01 的表不为一轴加列）", () => {
    const rows = flatten(validUnit());
    const emotion = rows.find((r) => r.axis === "emotion")!;
    assert.match(emotion.rationale, /^\[强度2\]/);
  });

  it("competing 只在情绪轴上有值", () => {
    const u = validUnit();
    const rows = flatten({ ...u, emotion: { ...u.emotion, competing: "anxiety" } });
    assert.equal(rows.find((r) => r.axis === "emotion")!.competingCode, "anxiety");
    assert.equal(rows.find((r) => r.axis === "scene")!.competingCode, null);
  });

  it("uncertain 落到每一行——复核时按行筛", () => {
    const rows = flatten({ ...validUnit(), uncertain: true });
    assert.ok(rows.every((r) => r.uncertain));
  });
});
