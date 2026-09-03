/** 总分计数的守卫：满分只数有判定的题，与 M-P1 / M-R1 分母同源。 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertionScore, riskScore, scenarioScore, scoreRate, totalScore } from "./score";

describe("scenarioScore", () => {
  it("pass 计 1、fail 计 0；manual / pending 不进满分且写进备注", () => {
    const s = scenarioScore("场景", [
      { status: "pass" }, { status: "pass" }, { status: "fail" }, { status: "manual" }, { status: "pending" },
    ]);
    assert.equal(s.got, 2);
    assert.equal(s.max, 3);
    assert.ok(s.note?.includes("未判定 2 题") && s.note.includes("manual 1 / pending 1"), s.note);
  });
  it("全部有判定时没有备注", () => {
    assert.equal(scenarioScore("场景", [{ status: "pass" }]).note, undefined);
  });
});

describe("riskScore", () => {
  it("intercepted 计 1、leaked 计 0；uncovered / not_reached 不进满分（本地层 20/20 而不是 20/98）", () => {
    const outcomes = [
      ...Array.from({ length: 20 }, () => ({ status: "intercepted" as const })),
      ...Array.from({ length: 70 }, () => ({ status: "uncovered" as const })),
      ...Array.from({ length: 8 }, () => ({ status: "not_reached" as const })),
    ];
    const s = riskScore("风险", outcomes);
    assert.equal(s.got, 20);
    assert.equal(s.max, 20);
    assert.ok(s.note?.includes("78 题不进满分") && s.note.includes("未覆盖 70 / 未触达 8"), s.note);
  });
});

describe("totalScore / scoreRate", () => {
  it("合计是分子分母各自相加；满分 0 的得分率是 —", () => {
    const t = totalScore([assertionScore("a", 48, 48), { name: "b", got: 85, max: 91 }]);
    assert.deepEqual([t.got, t.max], [133, 139]);
    assert.equal(scoreRate(t), "96%");
    assert.equal(scoreRate({ name: "x", got: 0, max: 0 }), "—");
  });
});
