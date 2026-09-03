/**
 * 音景增益算术（施工单 M64-01，验收 §1 判定 2/3）。
 *
 * 这个文件是本单唯一能验"声音多响"的地方——其余断言全是调度参数。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { PEAK_BED, PEAK_CUE, clampPeak, effectiveGain } from "../src/soundscape/gain";

describe("clampPeak：超限钳到上限，且不报错", () => {
  test("超限的钳到 PEAK_CUE", () => {
    assert.equal(clampPeak(0.5), PEAK_CUE);
    assert.equal(clampPeak(1), PEAK_CUE);
    assert.equal(clampPeak(1e9), PEAK_CUE);
  });

  test("没超限的原样返回", () => {
    assert.equal(clampPeak(0.1), 0.1);
    assert.equal(clampPeak(PEAK_BED), PEAK_BED);
  });

  test("0 与负数一律 0", () => {
    assert.equal(clampPeak(0), 0);
    assert.equal(clampPeak(-1), 0);
  });

  test("NaN / Infinity 当 0——喂给 AudioParam 会让那一路彻底哑掉且没有提示", () => {
    assert.equal(clampPeak(Number.NaN), 0);
    assert.equal(clampPeak(Number.POSITIVE_INFINITY), 0);
  });

  test("超限不抛：界面音效不该因为参数写错就中断动画", () => {
    assert.doesNotThrow(() => clampPeak(999));
  });
});

describe("effectiveGain：muted 优先级最高", () => {
  test("muted 时恒为 0，且与 master 取值无关", () => {
    assert.equal(effectiveGain(PEAK_CUE, 1, true), 0);
    assert.equal(effectiveGain(PEAK_CUE, 0.3, true), 0);
    assert.equal(effectiveGain(PEAK_BED, 0.99, true), 0);
  });

  test("没静音时是峰值 × 主音量", () => {
    assert.ok(Math.abs(effectiveGain(0.2, 0.5, false) - 0.1) < 1e-9);
    assert.ok(Math.abs(effectiveGain(0.1, 1, false) - 0.1) < 1e-9);
  });

  test("峰值超限先被钳，再乘主音量", () => {
    assert.ok(Math.abs(effectiveGain(1, 1, false) - PEAK_CUE) < 1e-9);
    assert.ok(Math.abs(effectiveGain(1, 0.5, false) - PEAK_CUE / 2) < 1e-9);
  });

  test("主音量 >1 不放大：上限只能由 clampPeak 决定", () => {
    assert.ok(Math.abs(effectiveGain(0.2, 5, false) - 0.2) < 1e-9);
  });

  test("主音量为 0 / NaN 时静音", () => {
    assert.equal(effectiveGain(PEAK_CUE, 0, false), 0);
    assert.equal(effectiveGain(PEAK_CUE, Number.NaN, false), 0);
  });
});

test("两个上限的相对关系：铺底必须比单个 cue 轻得多", () => {
  assert.ok(PEAK_BED < PEAK_CUE / 3, `铺底 ${PEAK_BED} 相对 cue ${PEAK_CUE} 不够轻，它要一直在，就必须一直不显眼`);
});
