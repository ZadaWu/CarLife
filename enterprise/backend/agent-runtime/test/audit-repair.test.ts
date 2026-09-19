/**
 * [F-58-08][F-58-09][AC-58-4] 修复分派表（M77-03）：blocker 类型 → 动作，同分支合并，warning 不产生动作。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { AuditReport, TripPlanSnapshot } from "@carlife/shared";

import { driveRepairAction, markRepaired, planRepairs } from "../src/graph/audit-repair";
import type { TripSkeleton } from "../src/graph/trip-plan-layer/types";

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
      assert.match(acts[0]!.prompt, /submit_drive_plan/);
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

describe("[F-58-08][F-58-09] 追发 prompt 读骨架（M87-03）：无骨架逐字不变，有骨架带对应段", () => {
  const SNAP = JSON.parse(readFileSync(new URL("./fixtures/repair-prompts-pre-m87-03.json", import.meta.url), "utf8")) as { prompts: Record<"hotel" | "drive" | "tourDaily" | "tourDays", string> };
  const reports = {
    hotel: report([{ item: "hotel", level: "blocker", day: 1, basis: "第 1 天没有住宿" }, { item: "hotel", level: "blocker", day: 2, basis: "第 2 天没有住宿" }]),
    drive: report([{ item: "stop", level: "blocker", leg: 1, basis: "第 2 段的停靠点还没定" }, { item: "return", level: "blocker", basis: "不闭环" }]),
    tourDaily: report([{ item: "daily", level: "blocker", day: 1, actual: 600, limit: 540, basis: "x" }]),
    tourDays: report([{ item: "days", level: "blocker", actual: 2, limit: 3, basis: "要 3 天只排了 2 天" }]),
  };
  const rerunPrompt = (r: AuditReport, ctx: Parameters<typeof planRepairs>[2]): string => {
    const a = planRepairs(r, PLAN, ctx).find((x) => x.kind === "rerun");
    assert.ok(a && a.kind === "rerun");
    return a.prompt;
  };
  const SKELETON: TripSkeleton = {
    destination: "徐州",
    days: [
      { day: 1, area: "云龙区", theme: "汉文化日", centroid: { lat: 34.2, lon: 117.2 }, roles: ["arrival"], spots: [{ name: "汉文化景区", lat: 34.21, lon: 117.21, indoor: false }], alternates: [{ name: "龟山汉墓", lat: 34.28, lon: 117.15, indoor: false }] },
      { day: 2, area: "泉山区", theme: "老城日", centroid: { lat: 34.25, lon: 117.18 }, roles: ["departure"], spots: [{ name: "户部山", lat: 34.25, lon: 117.18, indoor: false }], alternates: [] },
    ],
    rainPool: [{ name: "徐州博物馆", lat: 34.26, lon: 117.19, indoor: true }],
    source: "decide",
    searchCalls: 5,
  };

  it("无骨架：四种追发与改动前快照逐字相同", () => {
    for (const k of ["hotel", "drive", "tourDaily", "tourDays"] as const) assert.equal(rerunPrompt(reports[k], CTX), SNAP.prompts[k], k);
  });

  it("有骨架：hotel 带片区段、drive 带起终点段、tour 两种带骨架段与「名字逐字来自骨架」；骨架段在约束段之前、体检发现之后", () => {
    const withSk = { ...CTX, skeleton: SKELETON };
    const hotel = rerunPrompt(reports.hotel, withSk);
    assert.match(hotel, /【逐天片区（编排层已定）】/);
    assert.ok(hotel.indexOf("体检发现这些天还没有住宿") < hotel.indexOf("【逐天片区") && hotel.indexOf("【逐天片区") < hotel.indexOf("（约束）"), "顺序：发现 → 骨架 → 约束");
    const drive = rerunPrompt(reports.drive, withSk);
    assert.match(drive, /【每天的起终点（编排层已定）】/);
    assert.match(drive, /第 1 天：出发地 → 云龙区/);
    const daily = rerunPrompt(reports.tourDaily, withSk);
    assert.match(daily, /【逐天骨架（编排层已定，带坐标）】/);
    assert.match(daily, /同片区的备选.*名字逐字来自骨架/);
    assert.match(daily, /龟山汉墓/);
    const days = rerunPrompt(reports.tourDays, withSk);
    assert.match(days, /缺的天照骨架里那一天的景点补/);
    assert.match(days, /【逐天骨架（编排层已定，带坐标）】/);
    // 分派表的触发判据不动：动作数与分支与无骨架时相同
    for (const k of ["hotel", "drive", "tourDaily", "tourDays"] as const) {
      const a = planRepairs(reports[k], PLAN, withSk).map((x) => (x.kind === "rerun" ? `${x.kind}:${x.branch}` : x.kind));
      const b = planRepairs(reports[k], PLAN, CTX).map((x) => (x.kind === "rerun" ? `${x.kind}:${x.branch}` : x.kind));
      assert.deepEqual(a, b, k);
    }
  });
});

describe("[F-58-08][F-58-09] driveRepairAction：四种来由各说各的，合并成一条（M98-01）", () => {
  const NEED = { stopLegs: [] as number[], needsReturn: false, pendingLegs: [] as number[], skeletonChanged: false };
  const act = (need: Partial<typeof NEED>) => driveRepairAction(PLAN, { ...NEED, ...need }, CTX);

  it("四项全空 → 不产出动作（不制造空追发）", () => {
    assert.equal(act({}), undefined);
  });

  it("只有 stop：说哪几段没定，不提重排也不提占位", () => {
    const p = act({ stopLegs: [1] })!.prompt;
    assert.match(p, /体检发现这些段的停靠点还没定：第 2 段/);
    assert.doesNotMatch(p, /重排过/);
    assert.doesNotMatch(p, /还是占位/);
    assert.doesNotMatch(p, /回到出发地/);
  });

  it("只有 return：说返程，且点名出发地", () => {
    const p = act({ needsReturn: true })!.prompt;
    assert.match(p, /最后一段没有回到出发地「杭州」/);
    assert.doesNotMatch(p, /停靠点还没定/);
  });

  it("只有 pending：点名是新拆出来的哪几段，用的是 1 起的段号", () => {
    const p = act({ pendingLegs: [1, 2] })!.prompt;
    assert.match(p, /第 2、3 段的终点还是占位「待定停靠点」/);
    assert.match(p, /新拆出来的/);
    assert.doesNotMatch(p, /体检发现这些段的停靠点还没定/);
  });

  it("只有 skeletonChanged：把重排后的逐天安排写进 prompt，并明说不要沿用上一次", () => {
    const p = act({ skeletonChanged: true })!.prompt;
    assert.match(p, /行程刚按体检结论\*\*重排过\*\*/);
    assert.match(p, /第1天「云龙区」：汉文化景区/);
    assert.match(p, /第2天「泉山区」：户部山/);
    assert.match(p, /不要沿用你上一次交的那份/);
  });

  it("四项同时成立 → 只有一条动作，四段按「骨架 → 占位 → 体检 → 返程」固定顺序", () => {
    const a = act({ stopLegs: [1], needsReturn: true, pendingLegs: [2], skeletonChanged: true })!;
    assert.equal(a.kind, "rerun");
    assert.equal(a.branch, "drive");
    const p = a.prompt;
    const at = (re: RegExp) => p.search(re);
    assert.ok(at(/重排过/) < at(/还是占位/), "骨架段在占位段之前");
    assert.ok(at(/还是占位/) < at(/停靠点还没定/), "占位段在体检段之前");
    assert.ok(at(/停靠点还没定/) < at(/回到出发地/), "体检段在返程段之前");
    // 收尾与约束仍在最后，且逐字不变
    assert.match(p, /算完\*\*必须以一次 `submit_drive_plan` 工具调用收尾\*\*/);
    assert.ok(p.endsWith("（约束）"));
  });

  it("days 取自体检段与占位段涉及的天，去重", () => {
    assert.deepEqual(act({ stopLegs: [0], pendingLegs: [1] })!.days, [1, 2]);
  });
});
