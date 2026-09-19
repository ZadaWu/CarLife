/**
 * [F-62-01][F-58-02][AC-58-2][AC-58-7] 分段的归属天与出发日期（M77 走查追修）。
 *
 * 起因是一次真跑：车主说「下周二出发」，确认弹窗上却挂着
 * 「体检·验不了　有分段对不上具体哪一天，全天累计只算了能对上的天」。
 *
 * 两件事各有根因，都不是体检的毛病：
 *  1. 归属天靠"段尾站名去 tour 的景点表里查"——而停靠点是服务区、收费站，几乎从不等于景点名，
 *     最后一段更是连段尾都没有（N 段只有 N-1 个停靠点）。于是全天累计体检 100% 落空。
 *  2. 出发日期压根没有落点：契约有 `startDate`、`trip_plan_commit` 也收，就是没有人填。
 *
 * 这组用例钉住新的数据通路，以及"宁可验不了也不接可疑数据"的那道闸。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auditPlan } from "@carlife/tools";

import { mergeItinerary, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import { buildLegs, solve } from "../src/graph/merge";
import { leg, legsFrom } from "./helpers/drive-legs";
import type { BranchResult } from "../src/graph/fanout";

const INPUT: ItineraryInput = {
  goal: "从上海出发去广州玩三天，下周二出发",
  constraints: [],
  userText: "从上海出发去广州玩三天，下周二出发",
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

/** 三天骨架；景点名刻意与下面的停靠点不重合——现实里就是不重合。 */
const tourSubmit = (startDate?: string) =>
  ok("tour-task", "", {
    destination: "广州",
    ...(startDate === undefined ? {} : { startDate }),
    days: [
      { day: 1, theme: "抵达", area: "天河", spots: [{ name: "广州塔" }] },
      { day: 2, theme: "老城", area: "荔湾", spots: [{ name: "陈家祠堂" }] },
      { day: 3, theme: "返程", area: "番禺", spots: [{ name: "长隆" }] },
    ],
    findings: [],
  });

/** drive 的提交：段自描述（ACR-047），天由每一段自己说。 */
const driveSubmit = (legDays: number[] = [1, 1, 3], stops: string[] = ["韶关服务区"]) =>
  ok("drive-task", "", {
    origin: "上海",
    legs: legsFrom([170, 160, 150], stops, legDays, { origin: "上海", destination: "广州" }),
    findings: [],
  });

describe("[F-62-01] 归属天：每一段自己说，不再靠段尾查景点回落", () => {
  it("每段都有天，连最后一段也有", () => {
    const legs = buildLegs({ legs: legsFrom([170, 160, 150], ["韶关服务区"], [1, 1, 3], { origin: "上海", destination: "广州" }) });
    assert.deepEqual(legs?.map((l) => l.day), [1, 1, 3]);
    assert.equal(legs?.[0]?.toStop, "韶关服务区");
    assert.equal(legs?.[1]?.toStop, "第1天落脚处", "当天最后一段的终点是当天落脚处");
    assert.equal(legs?.[2]?.toStop, "广州");
  });
});

describe("[F-58-02] 可疑的天一律不接——全天累计是 blocker 档", () => {
  it("顺序倒退、非整数、从 0 起——在工具侧就被退回（assertDriveLegs），汇聚层收不到这种形状", async () => {
    const { assertDriveLegs } = await import("@carlife/tools");
    assert.ok(assertDriveLegs([leg(2, "outbound", "a", "b", 10), leg(1, "outbound", "b", "c", 10)]).some((m) => /天只能往后走/.test(m)));
    assert.ok(assertDriveLegs([leg(0, "outbound", "a", "b", 10)]).some((m) => /不是从 1 起的整数/.test(m)));
    assert.ok(assertDriveLegs([leg(1.5, "outbound", "a", "b", 10)]).some((m) => /不是从 1 起的整数/.test(m)));
  });

  it("mergeItinerary：天号超出总天数的那几段去掉天号（退回「验不了」），其余段照常", () => {
    const out = mergeItinerary([tourSubmit(), driveSubmit([1, 1, 9])], INPUT, ["tour", "drive"]);
    assert.deepEqual(out.plan.legs?.map((l) => l.day), [1, 1, undefined]);
    const good = mergeItinerary([tourSubmit(), driveSubmit([1, 1, 3])], INPUT, ["tour", "drive"]);
    assert.deepEqual(good.plan.legs?.map((l) => l.day), [1, 1, 3]);
  });
});

describe("[F-58-02] solve 拆段时归属天跟着拆", () => {
  it("一段被拆成两段，子段仍在原来那一天；总时长不变", () => {
    const out = solve({ legs: legsFrom([100, 300], [], [1, 2]) }, { maxLegMinutes: 180 });
    assert.deepEqual(out.draft.legs.map((l) => l.minutes), [100, 150, 150]);
    assert.deepEqual(out.draft.legs.map((l) => l.day), [1, 2, 2], "拆分只改分段粒度，不改日程");
  });

  it("不拆的时候原样带过去（solve 逐字段重建，加字段容易在这里漏掉）", () => {
    const out = solve({ legs: legsFrom([100, 120], ["服务区"], [1, 2]), energyStops: ["x"], findings: ["y"], origin: "上海" }, {});
    assert.deepEqual(out.draft.legs.map((l) => l.day), [1, 2]);
    assert.deepEqual(out.draft.energyStops, ["x"]);
    assert.deepEqual(out.draft.findings, ["y"]);
    assert.equal(out.draft.origin, "上海");
  });
});

describe("[AC-58-2] 全天累计体检因此真的能算了", () => {
  const base = {
    skeleton: [
      { day: 1, spots: [{ name: "广州塔" }] },
      { day: 2, spots: [{ name: "陈家祠堂" }] },
    ],
    destination: "广州",
    origin: "上海",
    limits: { legSafeMaxMin: 180, dailyMaxMin: 540 },
    constraints: [] as string[],
  };
  const daily = (legs: Array<{ driveMinutes: number; day?: number }>) =>
    auditPlan({ ...base, legs }).findings.filter((f) => f.item === "daily");

  it("每段都有天且不超上限 → 一条 finding 都不出", () => {
    assert.deepEqual(daily([{ driveMinutes: 170, day: 1 }, { driveMinutes: 160, day: 1 }]), []);
  });

  it("同一天累计超上限 → blocker，依据带实际值与上限", () => {
    const found = daily([{ driveMinutes: 300, day: 1 }, { driveMinutes: 300, day: 1 }]);
    assert.equal(found[0]?.level, "blocker");
    assert.equal(found[0]?.actual, 600);
    assert.equal(found[0]?.limit, 540);
  });

  it("还有段缺天 → 仍如实报「验不了」，不拿能对上的那部分冒充已验", () => {
    const found = daily([{ driveMinutes: 300, day: 1 }, { driveMinutes: 300 }]);
    assert.equal(found[0]?.level, "unverifiable");
    assert.match(found[0]?.missing ?? "", /归属天/);
  });
});

describe("[F-58-02] 出发日期：车主说「下周二」，分支换算成日历日期交回来", () => {
  it("tour 交了 startDate → 进快照", () => {
    const out = mergeItinerary([tourSubmit("2026-09-15"), driveSubmit()], INPUT, ["tour", "drive"]);
    assert.equal(out.plan.startDate, "2026-09-15");
  });

  it("没交就是没有——不拿今天顶替", () => {
    const out = mergeItinerary([tourSubmit(undefined), driveSubmit()], INPUT, ["tour", "drive"]);
    assert.equal(out.plan.startDate, undefined);
  });

  it("细化轮没交不覆盖上一轮的——改个景点不该把出发日期改丢", () => {
    const first = mergeItinerary([tourSubmit("2026-09-15"), driveSubmit()], INPUT, ["tour", "drive"]);
    const refined = mergeItinerary([tourSubmit(undefined), driveSubmit()], { ...INPUT, plan: first.plan }, ["tour", "drive"]);
    assert.equal(refined.plan.startDate, "2026-09-15");
  });
});
