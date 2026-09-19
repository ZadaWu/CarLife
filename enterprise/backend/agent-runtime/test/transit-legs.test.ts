/**
 * [F-62-01][AC-62-2] [F-58-03][AC-58-2] 确认落库时按高德重算大交通分段的行车分钟数（M102-01）。
 *
 * `legs[].driveMinutes` 此前是 drive 分支转述的数（同一条上海→苏州三份行程 95 / 78 / 138，高德实测 94）。
 * 这里注入假的 geocode / driveMinutes 就能全测到，不碰网络：分摊守恒、只改分钟数、方向来自字段、
 * 任一失败只跳过那一方向、限流单独计数，以及确认路径里它的位置（读源码断言，照 day-legs.test.ts）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { auditPlan, ToolError } from "@carlife/tools";
import type { TripPlanLeg } from "@carlife/shared";

import { apportionMinutes, resolveTransitLegMinutes, type TransitLegDeps } from "../src/graph/subgraphs/itinerary";
import type { TripPlanState } from "../src/graph/state";

const NOW = "2026-09-17T08:00:00.000Z";
const SH = { lat: 31.230525, lon: 121.473667 };
const SZ = { lat: 31.299758, lon: 120.585294 };

function plan(legs: TripPlanLeg[] | undefined, over: Partial<TripPlanState> = {}): TripPlanState {
  return {
    status: "draft",
    origin: "上海",
    destination: "苏州",
    days: 2,
    skeleton: [{ day: 1, theme: "一", spots: [{ name: "拙政园" }] }],
    caveats: [],
    updatedTurnId: "t",
    ...(legs ? { legs } : {}),
    ...over,
  } as TripPlanState;
}

/** 真跑那份形状：去程 2 段（95+95，中间一个待定停靠）、返程 1 段。 */
function realLegs(): TripPlanLeg[] {
  return [
    { driveMinutes: 95, direction: "outbound", fromStop: "上海", toStop: "待定停靠点", reason: "rest", pending: true, day: 1 },
    { driveMinutes: 95, direction: "outbound", fromStop: "待定停靠点", day: 1 },
    { driveMinutes: 100, direction: "return", fromStop: "苏州", toStop: "上海", day: 2 },
  ];
}

interface Stub {
  deps: TransitLegDeps;
  geocoded: string[];
  driven: Array<[{ lat: number; lon: number }, { lat: number; lon: number }]>;
}

function stub(opts: { out?: number | Error; back?: number | Error; geocode?: Error } = {}): Stub {
  const geocoded: string[] = [];
  const driven: Stub["driven"] = [];
  const deps: TransitLegDeps = {
    async geocode(name) {
      geocoded.push(name);
      if (opts.geocode) throw opts.geocode;
      return name === "上海" ? SH : SZ;
    },
    async driveMinutes(o, d) {
      driven.push([o, d]);
      const v = o === SH ? (opts.out ?? 94) : (opts.back ?? 105);
      if (v instanceof Error) throw v;
      return v;
    },
    now: () => NOW,
  };
  return { deps, geocoded, driven };
}

/** 除 driveMinutes / computedAt 之外的字段。 */
const shape = (l: TripPlanLeg) => {
  const { driveMinutes: _m, computedAt: _c, ...rest } = l;
  return rest;
};

describe("[F-58-03][AC-58-2] apportionMinutes：整数、守恒、除零", () => {
  it("[95, 95] 对 94 → [47, 47]", () => {
    assert.deepEqual(apportionMinutes([95, 95], 94), [47, 47]);
  });
  it("[100, 50, 50] 对 199 → 三段和恰为 199，漂移补到最长段", () => {
    const out = apportionMinutes([100, 50, 50], 199)!;
    assert.equal(out.reduce((a, x) => a + x, 0), 199);
    assert.equal(out[0], Math.max(...out), "漂移只落在最长的那段上");
  });
  it("原比例之和为 0、total 非正 → undefined", () => {
    assert.equal(apportionMinutes([0, 0], 94), undefined);
    assert.equal(apportionMinutes([10], 0), undefined);
    assert.equal(apportionMinutes([10], Number.NaN), undefined);
  });
});

describe("[F-62-01][AC-62-2] resolveTransitLegMinutes：只覆盖分钟数", () => {
  it("去程与返程各算一次，各段按原比例分摊，五个字段逐字不变，每段带 computedAt", async () => {
    const s = stub();
    const before = plan(realLegs());
    const { plan: after, report } = await resolveTransitLegMinutes(before, s.deps);
    assert.deepEqual(s.geocoded, ["上海", "苏州"], "起终点各 geocode 一次");
    assert.deepEqual(s.driven, [
      [SH, SZ],
      [SZ, SH],
    ]);
    assert.deepEqual(
      after.legs!.map((l) => l.driveMinutes),
      [47, 47, 105],
    );
    assert.deepEqual(after.legs!.map(shape), realLegs().map(shape), "段数、停靠点、归属天、方向、pending 一律不动");
    assert.ok(after.legs!.every((l) => l.computedAt === NOW));
    assert.deepEqual(report, {
      outbound: { legs: 2, before: 190, after: 94 },
      return: { legs: 1, before: 100, after: 105 },
      rateLimited: 0,
    });
    assert.equal(before.legs![0]!.driveMinutes, 95, "不改入参");
  });

  it("没有返程段就不算返程：driving 只发一次，report 里没有 return", async () => {
    const s = stub();
    const { report } = await resolveTransitLegMinutes(plan(realLegs().slice(0, 2)), s.deps);
    assert.equal(s.driven.length, 1);
    assert.equal(report.return, undefined);
  });

  it("缺 origin：legs 逐字不变，两方向 skipped: no-origin，不打任何请求", async () => {
    const s = stub();
    const p = plan(realLegs(), { origin: undefined });
    const { plan: after, report } = await resolveTransitLegMinutes(p, s.deps);
    assert.deepEqual(after.legs, realLegs());
    assert.deepEqual(report, { outbound: { skipped: "no-origin" }, return: { skipped: "no-origin" }, rateLimited: 0 });
    assert.equal(s.geocoded.length + s.driven.length, 0);
  });

  it("任一段缺 direction（M102 之前的旧快照）：整条不变，skipped: no-direction", async () => {
    const s = stub();
    const legs = realLegs();
    delete legs[1]!.direction;
    const { plan: after, report } = await resolveTransitLegMinutes(plan(legs), s.deps);
    assert.deepEqual(after.legs, legs);
    assert.equal((report.outbound as { skipped: string }).skipped, "no-direction");
    assert.equal(s.driven.length, 0);
  });

  it("大交通是火车 / 飞机：不算", async () => {
    const s = stub();
    const { plan: after, report } = await resolveTransitLegMinutes(
      plan(realLegs(), { transit: { recommended: "train", summary: "高铁" } }),
      s.deps,
    );
    assert.deepEqual(after.legs, realLegs());
    assert.equal((report.outbound as { skipped: string }).skipped, "transit:train");
  });

  it("geocode 抛错：不变，skipped 以 geocode: 开头", async () => {
    const s = stub({ geocode: new Error("no such place") });
    const { plan: after, report } = await resolveTransitLegMinutes(plan(realLegs()), s.deps);
    assert.deepEqual(after.legs, realLegs());
    assert.equal((report.outbound as { skipped: string }).skipped, "geocode:no such place");
    assert.equal(s.driven.length, 0);
  });

  it("去程 driving 被限流、返程正常：只有返程被覆盖，rateLimited = 1", async () => {
    // 10004 = ACCESS_TOO_FREQUENT，`isRateLimited` 认的高德 infocode 之一。
    const limited = new ToolError("amap", "upstream", "本地闸门排不过来", true, "10004");
    const s = stub({ out: limited });
    const { plan: after, report } = await resolveTransitLegMinutes(plan(realLegs()), s.deps);
    assert.deepEqual(after.legs!.slice(0, 2), realLegs().slice(0, 2), "去程两段逐字不变，没有 computedAt");
    assert.equal(after.legs![2]!.driveMinutes, 105);
    assert.equal(after.legs![2]!.computedAt, NOW);
    assert.match((report.outbound as { skipped: string }).skipped, /^driving:.*本地闸门排不过来$/);
    assert.deepEqual(report.return, { legs: 1, before: 100, after: 105 });
    assert.equal(report.rateLimited, 1);
  });

  it("driving 回 0：skipped driving:no-duration，不写 computedAt", async () => {
    const s = stub({ out: 0 });
    const { plan: after, report } = await resolveTransitLegMinutes(plan(realLegs()), s.deps);
    assert.equal(after.legs![0]!.computedAt, undefined);
    assert.equal((report.outbound as { skipped: string }).skipped, "driving:no-duration");
  });

  it("模型交的全是 0：不分摊（除零），skipped zero-minutes", async () => {
    const s = stub();
    const legs = realLegs().map((l) => ({ ...l, driveMinutes: 0 }));
    const { report } = await resolveTransitLegMinutes(plan(legs), s.deps);
    assert.equal((report.outbound as { skipped: string }).skipped, "zero-minutes");
  });
});

describe("[F-58-03][AC-58-2] 确认轮体检读的是覆盖后的数", () => {
  it("一段 60 分钟被放大到 180、上限 120 → leg blocker 带实际值与上限", async () => {
    const s = stub({ out: 180 });
    const legs: TripPlanLeg[] = [{ driveMinutes: 60, direction: "outbound", fromStop: "上海", day: 1 }];
    const { plan: after } = await resolveTransitLegMinutes(plan(legs), s.deps);
    assert.equal(after.legs![0]!.driveMinutes, 180);
    const report = auditPlan({
      skeleton: after.skeleton,
      legs: after.legs,
      origin: after.origin,
      destination: after.destination,
      limits: { legSafeMaxMin: 120, dailyMaxMin: 600 },
      constraints: [],
      overridden: [],
      hasReturnTransit: false,
    });
    const leg = report.findings.find((f) => f.item === "leg");
    assert.ok(leg, "覆盖后超上限，体检必须报出来");
    assert.equal(leg!.actual, 180, "报的是覆盖后的数，不是模型交的 60");
    assert.equal(leg!.limit, 120);
  });
});

/**
 * 接线：确认路径在坐标回填之后、逐日车程之前、确认轮体检之前调它（读源码断言，照 day-legs.test.ts）。
 */
describe("[F-62-01][AC-62-2] 接线的位置与红线", () => {
  const SRC = readFileSync(new URL("../src/graph/supervisor.ts", import.meta.url), "utf8");
  const between = (from: string, to: string) => {
    const a = SRC.indexOf(from);
    const b = SRC.indexOf(to, a);
    assert.ok(a > 0 && b > a, `取不到 ${from} … ${to} 这一段`);
    return SRC.slice(a, b);
  };

  it("坐标回填 → 大交通分钟数 → 逐日车程 → 确认轮体检 → 权限门", () => {
    const coords = SRC.indexOf("resolveTripPlanCoords(");
    const transit = SRC.indexOf("resolveTransitLegMinutes(planToCommit");
    const dayLegs = SRC.indexOf("resolveDayDriveLegs(planToCommit");
    const audit = SRC.indexOf("const report = auditPlan({");
    const gate = SRC.indexOf("const updating = wantCommit &&");
    assert.ok(coords > 0 && transit > 0 && dayLegs > 0 && audit > 0 && gate > 0);
    assert.ok(coords < transit && transit < dayLegs, "在坐标回填之后、逐日车程之前");
    assert.ok(transit < audit, "弹窗上的体检行读的必须是覆盖后的数");
    assert.ok(transit < gate, "弹窗批的与落库的必须是同一份数据");
  });

  it("吞异常：算不出不该让车主的行程确认不了；留痕 scope: transit-legs", () => {
    const block = between("resolveTransitLegMinutes(planToCommit", "resolveDayDriveLegs(planToCommit");
    assert.match(block, /catch \(err\)/);
    assert.match(block, /transit_legs 失败，行程照常确认/);
    assert.match(block, /scope: "transit-legs"/);
  });

  it("起终点用 geocode、整程一次 driving，不带途经点（ADR-008：停靠点没有经过验证的坐标）", () => {
    const block = between("resolveTransitLegMinutes(planToCommit", "resolveDayDriveLegs(planToCommit");
    assert.match(block, /amap\.geocode\(name\)/);
    assert.match(block, /amap\.driving\(\{ origin, destination \}\)/);
    assert.doesNotMatch(block, /waypoints/);
  });
});
