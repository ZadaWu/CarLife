/**
 * 售后风险分级单测（施工单 M8-05）。零依赖。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessRisk, violatesVerdictBoundary, type SymptomSignal } from "../src/graph/subgraphs/service";

const sig = (over: Partial<SymptomSignal> = {}): SymptomSignal => ({
  safetyCritical: false,
  worsensWithSpeedOrBraking: false,
  warningLight: false,
  persistent: false,
  ...over,
});

describe("风险分级（规则，不是模型感觉）", () => {
  it("安全件牵涉 → 高风险", () => {
    assert.equal(assessRisk(sig({ safetyCritical: true })).level, "high");
  });

  it("警告灯 → 高风险", () => {
    assert.equal(assessRisk(sig({ warningLight: true })).level, "high");
  });

  it("随制动加剧 → 至少中风险", () => {
    assert.equal(assessRisk(sig({ worsensWithSpeedOrBraking: true })).level, "medium");
  });

  it("**宁可偏高**：中风险报成高的代价是多跑一趟，反过来可能是一次事故", () => {
    // 安全件 + 仅偶发 → 仍然高
    assert.equal(assessRisk(sig({ safetyCritical: true, persistent: false })).level, "high");
  });

  it("无任何风险信号 → 低风险，且依据写明", () => {
    const r = assessRisk(sig());
    assert.equal(r.level, "low");
    assert.ok(r.basis[0].includes("无安全件"));
  });

  it("**每条判定都有依据**——罗启明会追问", () => {
    const r = assessRisk(sig({ safetyCritical: true, warningLight: true }));
    assert.ok(r.basis.length >= 2);
  });
});

describe("拒绝的是结论，不是帮助（FL-20 核心矛盾）", () => {
  it("每次都给可执行的下一步，不是只说「去店里」", () => {
    const r = assessRisk(sig({ worsensWithSpeedOrBraking: true }));
    assert.ok(r.selfChecks.length >= 3);
    assert.ok(r.questionsForShop.length >= 3);
  });

  it("**给的是谈判依据**——用户带着问题去修理厂，而不是空手", () => {
    const r = assessRisk(sig({ safetyCritical: true }));
    assert.ok(r.questionsForShop.some((q) => q.includes("依据是什么")));
    assert.ok(r.questionsForShop.some((q) => q.includes("还能不能开")));
  });

  it("立即停车迹象清单始终给出（F-20-07）", () => {
    assert.ok(assessRisk(sig()).stopNowSigns.length >= 4);
  });
});

describe("措辞边界（与动作层硬禁是两道）", () => {
  it("拦确定性结论", () => {
    assert.ok(violatesVerdictBoundary("确诊是刹车片损坏"));
  });

  it("**拦否定性保证**——模型可以一边不调工具一边说「没问题」", () => {
    const v = violatesVerdictBoundary("你的刹车没问题，放心开");
    assert.ok(v);
    assert.match(v!, /比确诊更危险/);
  });

  it("正常的分级表述不被误伤", () => {
    for (const ok of [
      "风险偏中：建议近期到店检查",
      "这个症状可能来自悬挂衬套，需要专业检测确认",
      "如果出现刹车踏板变软，请立即停车",
    ]) {
      assert.equal(violatesVerdictBoundary(ok), null, `不该拦：${ok}`);
    }
  });
});
