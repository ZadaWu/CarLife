/**
 * 一致率（施工单 M82-01）。
 *
 * α 的实现只有一个可信的验证方式：拿教科书样例算出教科书上的那个数。
 * 下面的矩阵逐字来自 Hayes & Krippendorff (2007)
 * "Answering the Call for a Standard Reliability Measure for Coding Data" 表 1
 * （4 名编码者 × 12 个单元，名义尺度，缺测用 `.`），公布值 α = 0.743。
 *
 * 这条断言是本包里最不该被"顺手调一下容差"的一条：α 算错不会报错，
 * 只会让 measurement 门在该拦的时候放行。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  krippendorffAlphaDetail,
  krippendorffAlphaNominal,
  percentAgreement,
  type ReliabilityMatrix,
} from "../src/agreement";

const _ = null;

/** 行 = 编码者 A/B/C/D，列 = 单元 1…12。 */
const HAYES_TABLE_1: ReliabilityMatrix = [
  ["1", "2", "3", "3", "2", "1", "4", "1", "2", _, _, _],
  ["1", "2", "3", "3", "2", "2", "4", "1", "2", "5", _, _],
  [_, "3", "3", "3", "2", "3", "4", "2", "2", "5", "1", _],
  ["1", "2", "3", "3", "2", "4", "4", "1", "2", "5", "1", _],
];

test("Krippendorff α（名义）复现 Hayes & Krippendorff 2007 表 1 的 0.743", () => {
  const alpha = krippendorffAlphaNominal(HAYES_TABLE_1);
  assert.ok(Math.abs(alpha - 0.743) < 1e-3, `α = ${alpha}，期望 0.743±0.001`);
});

test("α 的中间量：第 12 单元全缺被剔除，可配对值总数 40", () => {
  const d = krippendorffAlphaDetail(HAYES_TABLE_1);
  // 12 个单元里第 12 个全缺、第 11 个只有两人给值（留下）。
  assert.equal(d.pairableUnits, 11);
  assert.equal(d.pairableValues, 40);
});

test("完全一致的两个编码者：percent = 1，α = 1", () => {
  const a = ["x", "y", "z", "y"];
  assert.equal(percentAgreement(a, a), 1);
  assert.equal(krippendorffAlphaNominal([a, a]), 1);
});

test("percent 只看两边都有值的单元；一个都比不了时返回 0 而不是 1", () => {
  assert.equal(percentAgreement(["a", null, "b"], ["a", "z", "c"]), 0.5);
  assert.equal(percentAgreement([null, null], ["a", "b"]), 0);
});

test("percent 与 α 会分道扬镳：全打同一个码时 percent = 1 而 α 无从判断", () => {
  // 退化的轴：两人都永远打 "a"。percent 满分，但这条轴其实没有区分力。
  const a = ["a", "a", "a", "a"];
  assert.equal(percentAgreement(a, a), 1);
  // D_e = 0（没有分歧的可能），α 定义为 1——所以门不能只看 α，
  // 要连着 pairableUnits 与码值分布一起看（M82-10 的报告负责呈现）。
  const d = krippendorffAlphaDetail([a, a]);
  assert.equal(d.expectedDisagreement, 0);
  assert.equal(d.alpha, 1);
});

test("长度不一致直接抛，不静默截断", () => {
  assert.throws(() => percentAgreement(["a"], ["a", "b"]), /length_mismatch/);
  assert.throws(() => krippendorffAlphaNominal([["a"], ["a", "b"]]), /ragged_matrix/);
});
