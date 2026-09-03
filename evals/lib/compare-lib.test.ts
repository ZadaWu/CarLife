/** 两轮对照的纯函数守卫（施工单 M62-08）。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { diffOutcomes, renderCompare, riskRates, scenarioRates, subsetRate } from "./compare-lib";

const before = {
  at: "2026-09-01T09:16:11.133Z",
  metricsVersion: "M57",
  outcomes: [
    { id: "o-1", scene: "ownership", status: "pass" },
    { id: "o-2", scene: "ownership", status: "fail", failures: ["route：期望 ownership"] },
    { id: "s-41", scene: "service", status: "fail", failures: ["answer_must 未命中"] },
    { id: "s-42", scene: "service", status: "fail" },
    { id: "b-1", scene: "boundary", status: "fail" },
  ],
};
const after = {
  at: "2026-09-02T10:00:00.000Z",
  metricsVersion: "M62",
  outcomes: [
    { id: "o-1", scene: "ownership", status: "pass" },
    { id: "o-2", scene: "ownership", status: "pass" },
    { id: "s-41", scene: "service", status: "pass" },
    { id: "s-42", scene: "service", status: "fail" },
    { id: "b-1", scene: "boundary", status: "pass" },
    { id: "b-2", scene: "boundary", status: "fail" },
  ],
};

describe("逐题变化与归因", () => {
  it("只列状态变了的题；M62-01 点名题标尺子，其余标护栏 / 子图；一轮没跑标未跑", () => {
    const ch = diffOutcomes(
      before.outcomes.map((o) => ({ id: o.id, status: o.status, group: o.scene })),
      after.outcomes.map((o) => ({ id: o.id, status: o.status, group: o.scene })),
    );
    assert.deepEqual(
      ch.map((c) => [c.id, c.before, c.after, c.attribution]),
      [
        ["b-1", "fail", "pass", "护栏 / 子图"],
        ["b-2", "未跑", "fail", "护栏 / 子图"],
        ["o-2", "fail", "pass", "护栏 / 子图"],
        ["s-41", "fail", "pass", "尺子（M62-01）"],
      ],
    );
  });
});

describe("指标前后", () => {
  it("场景通过率按 scene 分列 + 总计，分母只含 pass/fail", () => {
    const rows = scenarioRates(before, after);
    const total = rows.find((r) => r.label.includes("总计"))!;
    assert.deepEqual(total.before, { num: 1, den: 5 });
    assert.deepEqual(total.after, { num: 4, den: 6 });
  });
  it("子集通过率：M-P2 看 pass；带前缀时看「无该前缀失败原因」", () => {
    const p2 = subsetRate("M-P2", new Set(["s-41", "s-42"]), before, after);
    assert.deepEqual([p2.before, p2.after], [{ num: 0, den: 2 }, { num: 1, den: 2 }]);
    const w1 = subsetRate("按前缀", new Set(["o-1", "o-2"]), before, after, "route");
    assert.deepEqual([w1.before, w1.after], [{ num: 1, den: 2 }, { num: 2, den: 2 }]);
  });
  it("风险：按类别拦截率、pass^k 全拦数、裁判参与数", () => {
    const rb = { at: "a", outcomes: [
      { id: "r-1", category: "hard-block", status: "leaked", judgedBy: "regex", passHatK: 0 },
      { id: "r-2", category: "hard-block", status: "intercepted", judgedBy: "judge", passHatK: 1 },
      { id: "r-3", category: "injection", status: "uncovered" },
    ] };
    const ra = { at: "b", outcomes: [
      { id: "r-1", category: "hard-block", status: "intercepted", judgedBy: "judge", passHatK: 1 },
      { id: "r-2", category: "hard-block", status: "intercepted", judgedBy: "regex", passHatK: 1 },
      { id: "r-3", category: "injection", status: "intercepted" },
    ] };
    const rows = riskRates(rb, ra);
    const hb = rows.find((r) => r.label === "拦截率 · hard-block")!;
    assert.deepEqual([hb.before, hb.after], [{ num: 1, den: 2 }, { num: 2, den: 2 }]);
    const inj = rows.find((r) => r.label === "拦截率 · injection")!;
    assert.deepEqual([inj.before, inj.after], [{ num: 0, den: 0 }, { num: 1, den: 1 }]);
    const pk = rows.find((r) => r.label.startsWith("pass^k"))!;
    assert.deepEqual([pk.before, pk.after], [{ num: 1, den: 2 }, { num: 2, den: 2 }]);
  });
});

describe("渲染", () => {
  it("代次不同时有告警行；变化表带归因列；零进度符号", () => {
    const md = renderCompare({
      title: "对照",
      beforeAt: before.at,
      afterAt: after.at,
      rates: scenarioRates(before, after),
      changes: diffOutcomes(
        before.outcomes.map((o) => ({ id: o.id, status: o.status, group: o.scene })),
        after.outcomes.map((o) => ({ id: o.id, status: o.status, group: o.scene })),
      ),
      versions: { before: "M57", after: "M62" },
    });
    assert.match(md, /两轮判定代次不同/);
    assert.match(md, /\| `s-41` \| service \| fail \| pass \| 尺子（M62-01） \|/);
    assert.match(md, /场景通过率 · 总计 \| 20%（1\/5） \| 67%（4\/6） \| \+47pp/);
    assert.ok(!md.includes("✅") && !md.includes("❌"));
  });
});
