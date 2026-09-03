/**
 * 保养与维修详情页逻辑测试（施工单 M29-02）。
 * [F-23-06][AC-23-4] "没有记录"明确说出而非推测填充；[F-23-11][AC-23-9] 查看段。
 *
 * 组件树的渲染由 typecheck + 版式走查（?profile=demo 截图）覆盖，
 * 这里钉纯逻辑：空态三支判定与"未记录处置"文案。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recordsEmptiness, repairResolutionText } from "../src/features/ownership/records-logic";

const M = { at: 1, odometerKm: 100, items: "常规保养", source: "门店" };
const R = { at: 2, odometerKm: 200, symptom: "异响", source: "门店" };

describe("空态三支（措辞各不相同的前提）[F-23-06][AC-23-4]", () => {
  it("皆空 → both-empty", () => {
    assert.equal(recordsEmptiness({ maintenance: [], repairs: [] }), "both-empty");
  });
  it("仅维修空 → repairs-empty（保养段照常渲染）", () => {
    assert.equal(recordsEmptiness({ maintenance: [M], repairs: [] }), "repairs-empty");
  });
  it("只有维修没有保养 → has-content（不是空态：维修段有真数据）", () => {
    assert.equal(recordsEmptiness({ maintenance: [], repairs: [R] }), "has-content");
  });
  it("都有 → has-content", () => {
    assert.equal(recordsEmptiness({ maintenance: [M], repairs: [R] }), "has-content");
  });
});

describe("维修处置文案 [F-23-11][AC-23-9]", () => {
  it("缺席如实说「未记录处置」，不省略", () => {
    assert.equal(repairResolutionText({}), "未记录处置");
    assert.equal(repairResolutionText({ resolution: "  " }), "未记录处置");
  });
  it("有处置原样展示", () => {
    assert.equal(repairResolutionText({ resolution: "更换衬套" }), "更换衬套");
  });
});
