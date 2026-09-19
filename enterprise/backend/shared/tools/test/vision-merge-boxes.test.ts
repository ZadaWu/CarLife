/**
 * [F-20-03][AC-20-1] 检测框进描述之前先合并相邻同类框（2026-09-18 真机走查 turn-2db10f67）。
 *
 * 守的是那个真实案例：驻车灯 `≡D D≡` 被端上 YOLO 框成左右两半，各自描述成「文字 含字 D / DE」，
 * 目录对不上。合并后整个符号进第二遍，描述才会是「符号 直线」。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { mergeAdjacentSameClass, MERGE_MARGIN_RATIO } from "../src/vision/merge-boxes";
import type { DetectedItem } from "../src/vision/schema";

const item = (bbox: [number, number, number, number], conf: number, hint?: string, extra: Partial<DetectedItem> = {}): DetectedItem =>
  ({ category: "warning_light", bbox, confidence: conf, ...(hint ? { symbolHint: hint } : {}), ...extra }) as DetectedItem;

/** 走查那一轮端上给的两个框，坐标逐字来自 trace 的 notes。 */
const LEFT_HALF = item([64, 430, 84, 448], 0.43, "parking_lights");
const RIGHT_HALF = item([89, 430, 112, 448], 0.38, "parking_lights");
const SEATBELT = item([60, 470, 90, 500], 0.72, "seatbelt_unfastened");

describe("[F-20-03][AC-20-1] 同一符号被劈成两半 → 合回一个框", () => {
  it("走查那一轮：≡D 与 D≡ 合成 [64,430,112,448]，置信取高的，安全带不动", () => {
    const notes: string[] = [];
    const out = mergeAdjacentSameClass([SEATBELT, LEFT_HALF, RIGHT_HALF], notes);
    assert.equal(out.length, 2);
    const parking = out.find((i) => i.symbolHint === "parking_lights")!;
    assert.deepEqual(parking.bbox, [64, 430, 112, 448]);
    assert.equal(parking.confidence, 0.43);
    assert.deepEqual(out.find((i) => i.symbolHint === "seatbelt_unfastened")!.bbox, SEATBELT.bbox);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /parking_lights 且相邻，合并为 \[64,430,112,448\]/);
  });

  it("不改入参：调用方拿到的是新数组、新框", () => {
    const src = [LEFT_HALF, RIGHT_HALF];
    const before = JSON.stringify(src);
    mergeAdjacentSameClass(src);
    assert.equal(JSON.stringify(src), before);
  });

  it("三段劈开的也收成一个（迭代到稳定）", () => {
    const out = mergeAdjacentSameClass([item([10, 10, 20, 30], 0.4, "x"), item([22, 10, 32, 30], 0.5, "x"), item([34, 10, 44, 30], 0.3, "x")]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].bbox, [10, 10, 44, 30]);
    assert.equal(out[0].confidence, 0.5);
  });

  it("描述子字段取置信更高那一项的", () => {
    const out = mergeAdjacentSameClass([item([10, 10, 20, 30], 0.4, "x", { shape: "letter_only" }), item([22, 10, 32, 30], 0.6, "x", { shape: "lamp" })]);
    assert.equal(out[0].shape, "lamp");
  });
});

describe("不该合并的三种情形", () => {
  it("同类但隔得远（间距超过半个短边）：两盏独立的灯", () => {
    // 短边 18，外扩 9；两框间距 30 > 18，不相交
    const out = mergeAdjacentSameClass([item([64, 430, 84, 448], 0.5, "x"), item([114, 430, 134, 448], 0.5, "x")]);
    assert.equal(out.length, 2);
  });

  it("相邻但类别不同：并排的两盏不同的灯", () => {
    const out = mergeAdjacentSameClass([item([64, 430, 84, 448], 0.5, "low_beam"), item([89, 430, 112, 448], 0.5, "parking_lights")]);
    assert.equal(out.length, 2);
  });

  it("没有 symbolHint（VLM 整图检测出来的项）：一律不动", () => {
    const out = mergeAdjacentSameClass([item([64, 430, 84, 448], 0.5), item([89, 430, 112, 448], 0.5)]);
    assert.equal(out.length, 2);
  });

  it("外扩系数是半个短边——改它要回头看文件头的判据", () => {
    assert.equal(MERGE_MARGIN_RATIO, 0.5);
  });
});

describe("接线：observePhoto 在检测之后、描述之前调它", () => {
  it("合并之后不误报「item_count 不一致」：那条自检核的是模型自己的账，要在合并之前做", () => {
    const src = readFileSync(new URL("../src/vision/observe.ts", import.meta.url), "utf8");
    const checkAt = src.indexOf("item_count=${detect.frame.item_count}");
    const mergeAt = src.indexOf("mergeAdjacentSameClass(detect.items, notes)");
    assert.ok(checkAt > 0 && checkAt < mergeAt, "重放 turn-2db10f67 时合并成 1 项后冒出「item_count=2 与 1 不一致（模型自检没过）」——那不是模型的错");
  });

  it("源码顺序：provider.detect → mergeAdjacentSameClass → slice(maxItems)", () => {
    const src = readFileSync(new URL("../src/vision/observe.ts", import.meta.url), "utf8");
    const detectAt = src.indexOf("detect = await provider.detect(image);");
    const mergeAt = src.indexOf("mergeAdjacentSameClass(detect.items, notes)");
    const sliceAt = src.indexOf("detect.items.slice(0, maxItems)");
    assert.ok(detectAt > 0 && mergeAt > detectAt && sliceAt > mergeAt, "合并必须在裁 maxItems 之前，否则劈开的两半会先占掉名额");
  });
});
