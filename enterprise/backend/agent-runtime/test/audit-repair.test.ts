/**
 * [F-58-08][F-58-09][AC-58-4] 修复分派表（M77-03）：blocker 类型 → 动作，同分支合并，warning 不产生动作。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AuditReport, TripPlanSnapshot } from "@carlife/shared";

import { markRepaired, planRepairs } from "../src/graph/audit-repair";

const PLAN: TripPlanSnapshot = {
  status: "skeleton",
  destination: "徐州",
  origin: "杭州",
  days: 2,
  skeleton: [
    { day: 1, theme: "汉文化日", area: "云龙区", spots: [{ name: "汉文化景区" }] },
    { day: 2, theme: "老城日", area: "泉山区", spots: [{ name: "户部山" }] },
  ],
  legs: [
    { day: 1, fromStop: "杭州", toStop: "汉文化景区", driveMinutes: 300 },
    { day: 2, fromStop: "汉文化景区", toStop: "待定停靠点", driveMinutes: 100, pending: true },
    { fromStop: "待定停靠点", driveMinutes: 40 },
  ],
  caveats: [],
  updatedTurnId: "t",
};
const CTX = { legLimitMin: 180, dailyMaxMin: 540, constraintText: "（约束）" };
const report = (findings: AuditReport["findings"]): AuditReport => ({ findings, passed: 0, rounds: 0, budgetExhausted: false });

describe("[F-58-08][AC-58-4] planRepairs", () => {
  it("hotel 缺两天 → 一条 hotel 追发，prompt 点名两天与片区", () => {
    const acts = planRepairs(
      report([
        { item: "hotel", level: "blocker", day: 1, basis: "第 1 天没有住宿" },
        { item: "hotel", level: "blocker", day: 2, basis: "第 2 天没有住宿" },
      ]),
      PLAN,
      CTX,
    );
    assert.equal(acts.length, 1);
    assert.equal(acts[0]!.kind, "rerun");
    if (acts[0]!.kind === "rerun") {
      assert.equal(acts[0]!.branch, "hotel");
      assert.deepEqual(acts[0]!.days, [1, 2]);
      assert.match(acts[0]!.prompt, /第1天「云龙区」、第2天「泉山区」/);
      assert.match(acts[0]!.prompt, /submit_hotels/);
      assert.match(acts[0]!.prompt, /（约束）/);
    }
  });

  it("leg 超限 → resplit（代码），带更严上限与段号", () => {
    const acts = planRepairs(report([{ item: "leg", level: "blocker", leg: 0, actual: 300, limit: 180, basis: "x" }]), PLAN, CTX);
    assert.deepEqual(acts, [{ kind: "resplit", legLimitMin: 180, legs: [0] }]);
  });

  it("stop + return 落到同一条 drive 追发；prompt 带段的起止", () => {
    const acts = planRepairs(
      report([
        { item: "stop", level: "blocker", leg: 1, basis: "第 2 段的停靠点还没定" },
        { item: "return", level: "blocker", basis: "不闭环" },
      ]),
      PLAN,
      CTX,
    );
    assert.equal(acts.length, 1);
    if (acts[0]!.kind === "rerun") {
      assert.equal(acts[0]!.branch, "drive");
      assert.match(acts[0]!.prompt, /第 2 段（汉文化景区 → 待定停靠点，约 100 分）/);
      assert.match(acts[0]!.prompt, /回到出发地「杭州」/);
      assert.match(acts[0]!.prompt, /submit_drive_draft/);
    }
  });

  it("daily 超限 → tour 追发（拆段减不了当天总里程）", () => {
    const acts = planRepairs(report([{ item: "daily", level: "blocker", day: 1, actual: 600, limit: 540, basis: "x" }]), PLAN, CTX);
    assert.equal(acts.length, 1);
    if (acts[0]!.kind === "rerun") {
      assert.equal(acts[0]!.branch, "tour");
      assert.match(acts[0]!.prompt, /第1天累计行车约 600 分，超过全天上限 540 分/);
      assert.match(acts[0]!.prompt, /submit_tour_days/);
    }
  });

  it("warning 与 unverifiable 不产生动作；repaired 的不再分派", () => {
    const acts = planRepairs(
      report([
        { item: "order", level: "warning", day: 1, basis: "交叉" },
        { item: "return", level: "unverifiable", basis: "闭环", missing: "出发地" },
        { item: "hotel", level: "blocker", day: 1, basis: "已补", repaired: true },
      ]),
      PLAN,
      CTX,
    );
    assert.deepEqual(acts, []);
  });
});

describe("[F-58-08][AC-58-4] markRepaired", () => {
  it("首轮有、末轮没了的 blocker 标 repaired 并保留在报告里", () => {
    const first = report([
      { item: "hotel", level: "blocker", day: 2, basis: "第 2 天没有住宿" },
      { item: "leg", level: "blocker", leg: 0, basis: "第 1 段超限" },
    ]);
    const last = report([{ item: "leg", level: "blocker", leg: 0, basis: "第 1 段超限" }]);
    const out = markRepaired(first, last);
    assert.equal(out.findings.length, 2);
    const fixed = out.findings.find((f) => f.repaired);
    assert.ok(fixed);
    assert.equal(fixed.item, "hotel");
    assert.equal(fixed.day, 2);
    assert.match(fixed.basis, /^已自动补：/);
  });
});
