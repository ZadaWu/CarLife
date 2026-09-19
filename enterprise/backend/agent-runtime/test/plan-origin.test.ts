/**
 * [F-58-05][F-58-10][F-62-01][AC-58-2][AC-58-7] 出发地从 drive 分支回到快照、体检与确认弹窗（M77 走查追修，2026-09-12）。
 *
 * 起因是一次真跑：车主在会话里明说「从上海出发」，确认弹窗上却挂着「体检·验不了　返程闭环：缺出发地」。
 * 根因不在体检——当时的提交工具没有装出发地的字段，drive 分支读到了、查路线用了，然后丢掉。
 * 这组用例把那条链的每一跳都钉住：提交 → 快照 → 分段首站 → 体检结论 → 弹窗首行。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auditPlan } from "@carlife/tools";

import { commitDisclosures, mergeItinerary, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import { buildLegs, parseDriveText } from "../src/graph/merge";
import { driveText, legsFrom } from "./helpers/drive-legs";
import type { BranchResult } from "../src/graph/fanout";
import type { TripPlanState } from "../src/graph/state";

const INPUT: ItineraryInput = {
  goal: "从上海出发去广州玩三天",
  constraints: [],
  userText: "从上海出发去广州玩三天",
  energyType: undefined,
  plan: undefined,
  turnId: "t1",
};

const ok = (agent: string, text: string, submission?: unknown): BranchResult => ({
  agent,
  status: "ok",
  text,
  submission,
  startedAt: 0,
  endedAt: 1,
});

const TOUR = ok(
  "tour-task",
  '{"destination":"广州","days":[{"day":1,"theme":"老城","area":"荔湾","spots":[{"name":"陈家祠堂","indoor":false}]}],"findings":[]}',
);

const driveSubmit = (origin?: string) =>
  ok("drive-task", "", {
    ...(origin === undefined ? {} : { origin }),
    legs: legsFrom([180, 160], ["韶关服务区"], [1, 1], { origin: origin?.trim() || "出发地", destination: "广州" }),
    findings: [],
  });

describe("[F-62-01] 出发地从 drive 分支回到快照", () => {
  it("提交通道带 origin → 写进 plan.origin", () => {
    const out = mergeItinerary([TOUR, driveSubmit("上海")], INPUT, ["tour", "drive"]);
    assert.equal(out.plan.origin, "上海");
  });

  it("正文回落通道（只认新形状）同样认 origin——两条路解出同一个形状", () => {
    const text = driveText(legsFrom([180, 160], ["韶关服务区"], [1, 1], { origin: "上海", destination: "广州" }), { origin: "上海" });
    assert.equal(parseDriveText(text)?.origin, "上海");
    const out = mergeItinerary([TOUR, ok("drive-task", text)], INPUT, ["tour", "drive"]);
    assert.equal(out.plan.origin, "上海");
    assert.equal(out.driveSource, "text");
  });

  it("这一轮没交 origin 不覆盖上一轮的——细化轮改酒店不该把出发地改丢", () => {
    const first = mergeItinerary([TOUR, driveSubmit("上海")], INPUT, ["tour", "drive"]);
    const refined = mergeItinerary([TOUR, driveSubmit(undefined)], { ...INPUT, plan: first.plan }, ["tour", "drive"]);
    assert.equal(refined.plan.origin, "上海");
    // 空白串同样不算交了
    const blank = mergeItinerary([TOUR, driveSubmit("   ")], { ...INPUT, plan: first.plan }, ["tour", "drive"]);
    assert.equal(blank.plan.origin, "上海");
  });

  it("从来没交过就是没有——不猜一个", () => {
    const out = mergeItinerary([TOUR, driveSubmit(undefined)], INPUT, ["tour", "drive"]);
    assert.equal(out.plan.origin, undefined);
  });

  it("分段首站因此有了起点：第一段 fromStop = 出发地", () => {
    const out = mergeItinerary([TOUR, driveSubmit("上海")], INPUT, ["tour", "drive"]);
    assert.equal(out.plan.legs?.[0]?.fromStop, "上海");
    // 直接对 buildLegs 再钉一次：段自己写的 from 就是首站
    const legs = buildLegs({ legs: legsFrom([180, 160], ["韶关服务区"], [1, 1], { origin: "上海" }) });
    assert.equal(legs?.[0]?.fromStop, "上海");
  });
});

describe("[F-58-05][AC-58-7] 返程闭环体检不再报「缺出发地」", () => {
  const base = {
    skeleton: [{ day: 1, spots: [{ name: "陈家祠堂" }] }],
    destination: "广州",
    limits: { legSafeMaxMin: 180, dailyMaxMin: 540 },
    constraints: [] as string[],
  };

  it("没有出发地 → 验不了，且说清缺的就是出发地", () => {
    const report = auditPlan({ ...base, legs: [{ driveMinutes: 180, toStop: "韶关服务区" }] });
    const ret = report.findings.find((f) => f.item === "return");
    assert.equal(ret?.level, "unverifiable");
    // 「缺的是什么」在 missing 字段里，basis 是那句人话的抬头（AuditFinding 的分工）
    assert.equal(ret?.missing, "出发地");
  });

  it("有出发地且末段回到出发地 → 通过，不出 finding", () => {
    const report = auditPlan({
      ...base,
      origin: "上海",
      legs: [{ driveMinutes: 180, fromStop: "上海", toStop: "广州" }, { driveMinutes: 180, fromStop: "广州", toStop: "上海市" }],
    });
    assert.equal(report.findings.find((f) => f.item === "return"), undefined, "「上海」与「上海市」归一后相等");
  });

  it("有出发地但末段没有终点 → 仍验不了，缺的换成返程段", () => {
    const report = auditPlan({ ...base, origin: "上海", legs: [{ driveMinutes: 180, fromStop: "上海", toStop: "广州" }] });
    const ret = report.findings.find((f) => f.item === "return");
    assert.equal(ret?.level, "unverifiable");
    assert.notEqual(ret?.missing, "出发地", "出发地已经有了，缺的不该还是它");
    assert.match(ret?.missing ?? "", /返程段/);
  });
});

describe("[F-58-10] 确认弹窗首行说清从哪去哪", () => {
  const plan = (origin?: string): TripPlanState => ({
    status: "ready",
    ...(origin ? { origin } : {}),
    destination: "广州",
    days: 3,
    startDate: "2026-10-01",
    skeleton: [{ day: 1, theme: "老城", area: "荔湾", spots: [{ name: "陈家祠堂" }] }],
    caveats: [],
    updatedTurnId: "t1",
  });

  it("有出发地：首行「上海 → 广州，共 3 天，2026-10-01 出发」，逐日行仍在它后面", () => {
    const lines = commitDisclosures(plan("上海"));
    assert.equal(lines[0], "行程：上海 → 广州，共 3 天，2026-10-01 出发");
    assert.match(lines[1] ?? "", /^第1天 老城：陈家祠堂/);
  });

  it("没有出发地：只写目的地，不编「（未知）」——那是体检项的活", () => {
    const lines = commitDisclosures(plan(undefined));
    assert.equal(lines[0], "行程：广州，共 3 天，2026-10-01 出发");
    assert.doesNotMatch(lines[0] ?? "", /未知|待定/);
  });
});
