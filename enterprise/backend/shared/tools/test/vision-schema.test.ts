/**
 * [F-20-03][AC-20-1] 观察层 schema：词表与评测集同源、结构上没有结论字段。
 *
 * 三处词表（本包 VISION_VOCAB / evals 的 VOCAB / truth.schema.json）必须逐字相等——
 * 评测与生产同一把尺子。truth.schema.json ⇔ evals VOCAB 那一组在 evals/vision-observe/cases.test.ts 守，
 * 这里守本包 ⇔ evals。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FORBIDDEN_LITERAL as EVAL_FORBIDDEN, VOCAB as EVAL_VOCAB } from "../../../../../evals/vision-observe/lib";
import { FORBIDDEN_LITERAL } from "../src/vision/forbidden";
import { BBoxSchema, DescriptorSchema, DetectResultSchema, ObservedItemSchema, PhotoObservationSchema, VISION_VOCAB } from "../src/vision/schema";

describe("[F-20-03][AC-20-1] 词表同源：@carlife/tools ⇔ evals/vision-observe", () => {
  for (const key of Object.keys(VISION_VOCAB) as Array<keyof typeof VISION_VOCAB>) {
    it(`${key} 逐字相等`, () => {
      assert.deepEqual([...VISION_VOCAB[key]], [...EVAL_VOCAB[key]]);
    });
  }
  it("禁词正则是同一份", () => {
    assert.equal(FORBIDDEN_LITERAL.source, EVAL_FORBIDDEN.source);
  });
});

const okDescriptor = {
  category: "warning_light",
  shape: "person",
  color: "red",
  state: "lit",
  text: [],
  elements: ["diagonal_band"],
  literal: "红色 人形 斜带",
  confidence: 1,
  quality: { blur: false, glare: false, partial: false },
  undeterminable: [],
};

describe("[F-20-03][AC-20-1] 结构上没有结论的位置", () => {
  it("描述子多一个 name / meaning / severity / advice 键就拒收", () => {
    assert.ok(DescriptorSchema.safeParse(okDescriptor).success);
    for (const k of ["name", "meaning", "severity", "advice", "cause"]) {
      assert.ok(!DescriptorSchema.safeParse({ ...okDescriptor, [k]: "x" }).success, k);
    }
  });
  it("观察项与整图观察同样 strict", () => {
    const item = { ...okDescriptor, bbox: [552, 435, 596, 485], colorByModel: "red", colorByPixels: "red", colorAgreement: "agree" };
    assert.ok(ObservedItemSchema.safeParse(item).success);
    assert.ok(!ObservedItemSchema.safeParse({ ...item, severity: "stop" }).success);
    const obs = {
      frame: { quality: {}, cut_off_sides: ["right"], cutOffSource: "model", item_count: 1, unreadable: false },
      items: [item],
      model: { detect: "a", describe: "b" },
      timings: { detectMs: 1, describeMs: 1, totalMs: 2 },
      notes: [],
    };
    assert.ok(PhotoObservationSchema.safeParse(obs).success);
    assert.ok(!PhotoObservationSchema.safeParse({ ...obs, verdict: "ok" }).success);
  });
  it("词表越界、literal 超长、bbox 顺序错都拒收", () => {
    assert.ok(!DescriptorSchema.safeParse({ ...okDescriptor, color: "purple" }).success);
    assert.ok(!DescriptorSchema.safeParse({ ...okDescriptor, literal: "红".repeat(41) }).success);
    assert.ok(!BBoxSchema.safeParse([10, 10, 5, 20]).success);
    assert.ok(!BBoxSchema.safeParse([0, 0, 1001, 10]).success);
  });
  it("检测结果的 frame 缺省质量标记全 false、cut_off_sides 缺省空", () => {
    const r = DetectResultSchema.parse({ frame: { quality: {}, item_count: 0 }, items: [] });
    assert.deepEqual(r.frame.cut_off_sides, []);
    assert.equal(r.frame.quality.blur, false);
  });
});
