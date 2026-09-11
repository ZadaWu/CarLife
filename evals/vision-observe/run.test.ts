/**
 * [M71-01] 评测逻辑的单测：配对、逐字段比、禁词、解析；以及 fake 档在 tesla-01 上的可断言数字。
 * 零网络：fixture 是 2026-09-08 三个模型的真实输出，真值是人工核对的。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  FORBIDDEN_LITERAL,
  aggregate,
  comparePhoto,
  extractJson,
  iou,
  jaccard,
  matchItems,
  parseJsonl,
  parsePrediction,
  sameSet,
  textHit,
  type BBox,
  type TruthCase,
} from "./lib";

const CASES = parseJsonl<TruthCase>(readFileSync(new URL("./cases.jsonl", import.meta.url), "utf8"));
const tesla = CASES.find((c) => c.id === "tesla-01")!;
const fixture = (model: string): string => readFileSync(new URL(`./fixtures/tesla-01.${model}.json`, import.meta.url), "utf8");

describe("[M71-01] IoU 与配对", () => {
  it("同框 IoU=1，不相交=0，半重叠按面积算", () => {
    const a: BBox = [0, 0, 100, 100];
    assert.equal(iou(a, a), 1);
    assert.equal(iou(a, [200, 200, 300, 300]), 0);
    assert.ok(Math.abs(iou(a, [50, 0, 150, 100]) - 1 / 3) < 1e-9);
  });
  it("阈值边界：IoU 0.49 不配，0.5 配", () => {
    const t = [{ bbox: [0, 0, 100, 100] as BBox }];
    // 宽 100 高 100 vs 平移 x=34：交 66*100=6600，并 20000-6600=13400 → 0.4925
    assert.equal(matchItems(t, [{ bbox: [34, 0, 134, 100] }]).pairs.length, 0);
    // 平移 x=33：交 6700，并 13300 → 0.5038
    assert.equal(matchItems(t, [{ bbox: [33, 0, 133, 100] }]).pairs.length, 1);
  });
  it("一对一：一个预测不能同时配两个真值；多余的预测算误检、没配的真值算漏检", () => {
    const t = [{ bbox: [0, 0, 100, 100] as BBox }, { bbox: [0, 0, 90, 90] as BBox }];
    const p = [{ bbox: [0, 0, 100, 100] as BBox }, { bbox: [500, 500, 600, 600] as BBox }];
    const m = matchItems(t, p);
    assert.equal(m.pairs.length, 1);
    assert.deepEqual(m.missed, [1]);
    assert.deepEqual(m.extra, [1]);
  });
});

describe("[M71-01] 逐字段比", () => {
  it("jaccard：none 视为空集；空对空 = 1", () => {
    assert.equal(jaccard(["none"], []), 1);
    assert.equal(jaccard(["a", "b"], ["b", "c"]), 1 / 3);
    assert.ok(sameSet(["right", "bottom"], ["bottom", "right"]));
    assert.ok(!sameSet(["right"], ["right", "bottom"]));
  });
  it("textHit：真值每个 token 都要在预测拼接串里，忽略大小写与空白", () => {
    assert.ok(textHit(["A"], ["a"]));
    assert.ok(textHit(["60", "%"], ["60 %"]));
    assert.ok(!textHit(["A"], []));
  });
  it("禁词：结论词命中，字面描述不命中", () => {
    for (const bad of ["红色安全带人形图标", "灰色 灯形 可能是雾灯", "故障灯", "正常"]) assert.ok(FORBIDDEN_LITERAL.test(bad), bad);
    for (const ok of ["红色 人形 斜带", "绿色 灯形 直线", "灰色 灯形 A 直线"]) assert.ok(!FORBIDDEN_LITERAL.test(ok), ok);
  });
});

describe("[M71-01] 解析", () => {
  it("剥 markdown 围栏；缺 frame/items 记致命；词表越界记非致命", () => {
    assert.equal(extractJson("```json\n{\"a\":1}\n```"), '{"a":1}');
    assert.ok(parsePrediction("not json").fatal);
    assert.ok(parsePrediction('{"items":[]}').fatal);
    const p = parsePrediction('{"frame":{"quality":{},"cut_off_sides":[],"item_count":1},"items":[{"category":"warning_light","bbox":[1,2,3,4],"shape":"lamp","color":"purple","state":"lit","text":[],"elements":["none"],"literal":"x","confidence":1}]}');
    assert.equal(p.fatal, null);
    assert.equal(p.vocabErrors.length, 1);
    assert.equal(p.pred?.items.length, 1);
  });
});

describe("[M71-01] fake 档在 tesla-01 上的数字（2026-09-08 fixture）", () => {
  it("qwen3-vl-plus：召回 8/8、颜色 4/4 警示灯全对、cut_off 命中、零禁词", () => {
    const r = comparePhoto(tesla, parsePrediction(fixture("qwen3-vl-plus")));
    assert.equal(r.unparseable, null);
    assert.equal(r.matched, 8);
    assert.equal(r.wlMatched, 4);
    assert.equal(r.extra, 0);
    assert.equal(r.colorRed.agree, 1);
    assert.equal(r.stateWarn.agree, 4);
    assert.equal(r.text.hit, r.text.n);
    assert.equal(r.cutOffMatch, true);
    assert.equal(r.forbiddenViolations, 0);
    // 已知的唯一不一致：电池图标被记成 rectangle（真值 battery）
    assert.equal(r.shape.agree, 7);
  });
  it("qwen3-vl-flash：定位同准但安全带描述错、cut_off 空", () => {
    const r = comparePhoto(tesla, parsePrediction(fixture("qwen3-vl-flash")));
    assert.equal(r.wlMatched, 4);
    assert.equal(r.cutOffMatch, false);
    assert.ok(r.reasons.some((x) => x.includes("形状不一致") && x.includes("car_outline")));
    assert.equal(r.forbiddenViolations, 0);
  });
  it("doubao-seed-2-0-mini：literal 泄露名称被禁词抓到", () => {
    const r = comparePhoto(tesla, parsePrediction(fixture("doubao-seed-2-0-mini")));
    assert.ok(r.forbiddenViolations >= 1);
    assert.ok(r.reasons.some((x) => x.includes("安全带")));
  });
  it("aggregate 出全部指标行且红色样本行可读", () => {
    const rows = aggregate([comparePhoto(tesla, parsePrediction(fixture("qwen3-vl-plus")))]);
    const red = rows.find((m) => m.id === "V-C2")!;
    assert.equal(red.value, "100.0%");
    assert.equal(rows.find((m) => m.id === "V-N1")!.value, "本档位不适用");
  });
});
