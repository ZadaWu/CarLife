/**
 * [F-20-03][AC-20-1] `eval:kb-qdrant` 的判定函数（M81-02）。全部离线、零依赖。
 * 这些数字算错会让「换存储没退化」这个结论本身不可信，所以它们必须有断言。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { differs, isHit1, isHit3, quantile, type Hit } from "./lib";

const hit = (page: number, sim: number, figureId = `f${page}`): Hit => ({ page, sim, figureId });

describe("[F-20-03][AC-20-1] hit@1 / hit@3", () => {
  it("hit@1 只看首条；hit@3 看前三条任一", () => {
    const top = [hit(9, 0.8), hit(15, 0.7), hit(20, 0.6)];
    assert.equal(isHit1(top, [9]), true);
    assert.equal(isHit1(top, [15]), false, "第二条命中不算 hit@1");
    assert.equal(isHit3(top, [20]), true);
    assert.equal(isHit3(top, [99]), false);
  });
  it("真值可以是多页（同一件事横跨两页），命中任一即算对", () => {
    assert.equal(isHit3([hit(41, 0.8)], [37, 39, 40, 41]), true);
  });
  it("空结果不算命中，也不抛", () => {
    assert.equal(isHit1([], [9]), false);
    assert.equal(isHit3([], [9]), false);
  });
});

describe("[F-20-03][AC-20-1] 延迟分位", () => {
  it("最近秩：P50 取中位、P95 取尾部，不插值", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(quantile(xs, 0.5), 5);
    assert.equal(quantile(xs, 0.95), 10);
    assert.equal(quantile(xs, 0), 1);
  });
  it("空样本返回 0 不抛", () => {
    assert.equal(quantile([], 0.5), 0);
  });
  it("单样本时两个分位都是它", () => {
    assert.equal(quantile([42], 0.5), 42);
    assert.equal(quantile([42], 0.95), 42);
  });
});

describe("[F-20-03][AC-20-1] 两档差异判定", () => {
  it("完全相同 → 不算差异", () => {
    const a = [hit(9, 0.842), hit(15, 0.78)];
    assert.equal(differs(a, [...a]), false);
  });
  it("**相似度不同即为缺陷**——同一批向量余弦必须一样，容差只给浮点序列化", () => {
    assert.equal(differs([hit(9, 0.842)], [hit(9, 0.842001)]), false, "1e-6 量级是序列化误差");
    assert.equal(differs([hit(9, 0.842)], [hit(9, 0.85)]), true, "0.008 的差是实现有问题，不是引擎差异");
  });
  it("页序不同 → 算差异", () => {
    assert.equal(differs([hit(9, 0.8), hit(15, 0.7)], [hit(15, 0.7), hit(9, 0.8)]), true);
  });
  it("条数不同 → 算差异", () => {
    assert.equal(differs([hit(9, 0.8)], [hit(9, 0.8), hit(15, 0.7)]), true);
  });
});
