/**
 * 置信 C（施工单 M82-01）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { confidenceOf } from "../src/confidence";
import type { ConfidenceInput } from "../src/types";

const all = (v: number): ConfidenceInput => ({
  coverage: v,
  quality: v,
  agreement: v,
  triangulation: v,
  freshness: v,
});

test("五项全 1 → c = 1", () => {
  assert.equal(confidenceOf(all(1)).c, 1);
});

test("五项全 0.8 → c = 0.8（几何平均，不是连乘的 0.33）", () => {
  // 连乘会把"五项都还行"读成"基本不可信"，界面上没人能解释那个数。
  assert.ok(Math.abs(confidenceOf(all(0.8)).c - 0.8) < 1e-12);
});

test("某项 0.2 → lowest 指向它，suggestion 非空且是可执行的动作", () => {
  const r = confidenceOf({ ...all(0.9), triangulation: 0.2 });
  assert.equal(r.lowest, "triangulation");
  assert.ok(r.suggestion.length > 0);
  assert.match(r.suggestion, /trips|行为/);
  assert.ok(r.c < 0.9);
});

test("任一项为 0 → c 归零（这是要的语义）", () => {
  assert.equal(confidenceOf({ ...all(1), coverage: 0 }).c, 0);
});

test("越界值被夹到 [0,1]，不让脏输入把 c 抬过 1", () => {
  assert.equal(confidenceOf(all(3)).c, 1);
  assert.equal(confidenceOf({ ...all(1), quality: Number.NaN }).c, 0);
});

test("平手时 lowest 稳定取固定顺序的第一个——两次生成的快照要逐字节相同", () => {
  const a = confidenceOf(all(0.5));
  const b = confidenceOf(all(0.5));
  assert.equal(a.lowest, b.lowest);
  assert.equal(a.lowest, "coverage");
});
