/**
 * 机会分 ODS（施工单 M82-01）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PROFILE, isValidProfile, odsOf } from "../src/ods";
import type { OdsComponents } from "../src/types";

const full: OdsComponents = { i: 1, u: 1, f: 1, g: 1, e: 1, s: 1, r: 0, c: 1 };

test("满分 100", () => {
  const r = odsOf(full);
  assert.ok(Math.abs(r.score - 100) < 1e-9, `score = ${r.score}`);
  assert.equal(r.profileVersion, "ods-v1");
});

test("风险拉满 → 0（否决，不是扣分）", () => {
  assert.equal(odsOf({ ...full, r: 1 }).score, 0);
});

test("置信减半 → 分数减半（C 在括号外，不可被别的项补偿）", () => {
  assert.ok(Math.abs(odsOf({ ...full, c: 0.5 }).score - 50) < 1e-9);
});

test("默认权重和为 1，否则满分不是 100", () => {
  assert.equal(isValidProfile(DEFAULT_PROFILE), true);
  const w = DEFAULT_PROFILE.weights;
  assert.ok(Math.abs(w.i + w.u + w.f + w.g + w.e + w.s - 1) < 1e-12);
});

test("单项权重钉住——改权重必须同时改 version", () => {
  assert.deepEqual(DEFAULT_PROFILE.weights, { i: 0.25, u: 0.2, f: 0.15, g: 0.1, e: 0.15, s: 0.15 });
});

test("只有影响面满分、其余为零时得 25 分", () => {
  const r = odsOf({ i: 1, u: 0, f: 0, g: 0, e: 0, s: 0, r: 0, c: 1 });
  assert.ok(Math.abs(r.score - 25) < 1e-9);
});

test("越界输入被夹到 [0,1]", () => {
  assert.ok(odsOf({ ...full, i: 99 }).score <= 100);
  assert.equal(odsOf({ ...full, c: -1 }).score, 0);
});
