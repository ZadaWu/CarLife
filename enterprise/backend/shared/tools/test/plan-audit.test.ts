/**
 * [F-58-02][AC-58-1][AC-58-2][AC-58-7] [F-58-03][F-58-04][F-58-05][F-58-12] plan_audit（M77-02）。
 *
 * 守：纯函数幂等；每类体检项的通过 / blocker / unverifiable 各一例；输入缺失不产生默认值；
 * 没有正餐与能源项；限值全部来自入参。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TripPlanDaySnapshot, TripPlanLeg } from "@carlife/shared";

import { auditPlan, hasBlocker, normalizePlace, type PlanAuditArgs } from "../src/plan-audit";
import { getTool, invokeTool, listForAgent } from "../src/registry";

const SKELETON: TripPlanDaySnapshot[] = [
  { day: 1, theme: "汉文化日", spots: [{ name: "徐州汉文化景区" }, { name: "水下兵马俑博物馆" }], hotel: { name: "开元名都" } },
  { day: 2, theme: "云龙湖日", spots: [{ name: "云龙湖旅游景区" }], hotel: { name: "开元名都" } },
  { day: 3, theme: "老城日", spots: [{ name: "户部山古民居" }, { name: "戏马台" }] },
];
const LEGS: TripPlanLeg[] = [
  { day: 1, fromStop: "杭州", toStop: "徐州汉文化景区", driveMinutes: 100, reason: "rest" },
  { day: 1, fromStop: "徐州汉文化景区", toStop: "水下兵马俑博物馆", driveMinutes: 20, reason: "rest" },
  { day: 2, fromStop: "水下兵马俑博物馆", toStop: "云龙湖旅游景区", driveMinutes: 40, reason: "charge" },
  { day: 3, fromStop: "云龙湖旅游景区", toStop: "户部山古民居", driveMinutes: 30, reason: "rest" },
  { fromStop: "户部山古民居", driveMinutes: 25 },
];
const LIMITS = { legMaxMin: 120, legSafeMaxMin: 180, dailyMaxMin: 540 };
const BASE: PlanAuditArgs = { skeleton: SKELETON, legs: LEGS, origin: "杭州", destination: "徐州", limits: LIMITS, constraints: [], orderWarnings: [] };

const byItem = (r: ReturnType<typeof auditPlan>, item: string) => r.findings.filter((f) => f.item === item);

describe("[F-58-02][F-58-03][F-58-04][F-58-05][F-58-12][F-58-13][AC-58-1][AC-58-2][AC-58-3][AC-58-7][AC-58-8] plan_audit · 幂等与形状", () => {
  it("同输入两次调用逐项相等", () => {
    assert.deepEqual(auditPlan(BASE), auditPlan(structuredClone(BASE)));
  });
  it("没有正餐与能源项；constraint 类只计 passed 不进 findings", () => {
    const r = auditPlan({ ...BASE, overridden: ["中途必须安排充电"] });
    assert.ok(r.findings.every((f) => !["meal", "energy", "constraint"].includes(f.item)));
    assert.ok(r.passed >= 5);
  });
  it("registry：ACL 只有 trip-review（M86-05 起）、不对外暴露；invokeTool 走 mock 与 real 同一份逻辑", async () => {
    const reg = getTool("plan_audit")!;
    // 四条腿与 supervisor 仍拿不到：它是校验不是求解；裁决会话（trip-review）是唯一例外——事实是它判断的输入。
    assert.deepEqual(reg.agents, ["trip-review"]);
    assert.equal(reg.mcpExposable, false);
    for (const a of ["trip", "drive", "tour", "ownership", "supervisor"] as const) {
      assert.ok(!listForAgent(a).some((t) => t.name === "plan_audit"), `${a} 的清单里不该有 plan_audit`);
    }
    const ctx = { sessionId: "s", agent: "trip" } as const;
    const real = (await invokeTool("plan_audit", BASE, { ...ctx, mode: "real" })) as { data: unknown };
    const mock = (await invokeTool("plan_audit", BASE, { ...ctx, mode: "mock" })) as { data: unknown };
    assert.deepEqual(real.data, mock.data);
  });
});

describe("[F-58-02][F-58-03][F-58-04][F-58-05][F-58-12][F-58-13][AC-58-1][AC-58-2][AC-58-3][AC-58-7][AC-58-8] hotel", () => {
  it("中间天缺酒店 → blocker 带 day；最后一天缺不报", () => {
    const sk = structuredClone(SKELETON);
    delete sk[1]!.hotel;
    const r = auditPlan({ ...BASE, skeleton: sk });
    assert.deepEqual(byItem(r, "hotel").map((f) => [f.level, f.day]), [["blocker", 2]]);
    assert.ok(hasBlocker(r));
    assert.equal(byItem(auditPlan(BASE), "hotel").length, 0, "最后一天没酒店不算问题");
  });
  it("最后一天挂了酒店 → 报一条 hotel，等级与「缺住宿」同一档（M93-02）", () => {
    // 3 天行程排 3 晚（真跑 turn-86ce2093）。此前只查"少了"不查"多了"，这一项照样满分。
    const sk = structuredClone(SKELETON);
    sk[2]!.hotel = { name: "开元名都" };
    const r = auditPlan({ ...BASE, skeleton: sk });
    assert.deepEqual(byItem(r, "hotel").map((f) => [f.level, f.day, f.basis]), [
      ["blocker", 3, "第 3 天是返程日，不该有住宿"],
    ]);
    // 同一个方向的两侧共用一个 passed 计数：多了也不许算过。
    assert.ok(r.passed < auditPlan(BASE).passed);
  });
  it("「当天回」约束 → 不验住宿", () => {
    const sk = structuredClone(SKELETON);
    delete sk[0]!.hotel;
    const r = auditPlan({ ...BASE, skeleton: sk, constraints: ["当天回，不住"] });
    assert.equal(byItem(r, "hotel").length, 0);
  });
});

describe("[F-58-02][F-58-03][F-58-04][F-58-05][F-58-12][F-58-13][AC-58-1][AC-58-2][AC-58-3][AC-58-7][AC-58-8] leg / daily / stop", () => {
  it("单段 200 · 限 120 → blocker 带 actual / limit / leg", () => {
    const legs = structuredClone(LEGS);
    legs[0]!.driveMinutes = 200;
    const r = auditPlan({ ...BASE, legs });
    const f = byItem(r, "leg");
    assert.equal(f.length, 1);
    assert.equal(f[0]!.level, "blocker");
    assert.equal(f[0]!.actual, 200);
    assert.equal(f[0]!.limit, 120);
    assert.equal(f[0]!.leg, 0);
    assert.match(f[0]!.basis, /3 小时 20 分.*2 小时/);
  });
  it("没有同行者上限时按安全上限 180", () => {
    const legs = structuredClone(LEGS);
    legs[0]!.driveMinutes = 170;
    const r = auditPlan({ ...BASE, legs, limits: { legSafeMaxMin: 180, dailyMaxMin: 540 } });
    assert.equal(byItem(r, "leg").length, 0);
  });
  it("legs 缺省 → leg / daily / stop 三项 unverifiable 且说缺什么，不给默认值", () => {
    const r = auditPlan({ ...BASE, legs: undefined });
    for (const item of ["leg", "daily", "stop"]) {
      const f = byItem(r, item);
      assert.equal(f.length, 1, item);
      assert.equal(f[0]!.level, "unverifiable");
      assert.equal(f[0]!.missing, "分段数据");
    }
    assert.ok(!hasBlocker(r));
  });
  it("三段同一天合计 600 > 540 → daily blocker", () => {
    const legs: TripPlanLeg[] = [
      { day: 1, driveMinutes: 200, toStop: "A" },
      { day: 1, driveMinutes: 200, toStop: "B" },
      { day: 1, driveMinutes: 200, toStop: "C" },
    ];
    const r = auditPlan({ ...BASE, legs, limits: { legSafeMaxMin: 240, dailyMaxMin: 540 } });
    const f = byItem(r, "daily");
    assert.equal(f.length, 1);
    assert.equal(f[0]!.level, "blocker");
    assert.equal(f[0]!.actual, 600);
    assert.equal(f[0]!.day, 1);
  });
  it("某段 day 缺省 → daily 记 unverifiable，能对上的天仍判", () => {
    const legs: TripPlanLeg[] = [
      { day: 1, driveMinutes: 300, toStop: "A" },
      { day: 1, driveMinutes: 300, toStop: "B" },
      { driveMinutes: 30 },
    ];
    const r = auditPlan({ ...BASE, legs, limits: { legSafeMaxMin: 400, dailyMaxMin: 540 } });
    const f = byItem(r, "daily");
    assert.ok(f.some((x) => x.level === "blocker" && x.day === 1));
    assert.ok(f.some((x) => x.level === "unverifiable" && x.missing === "段的归属天"));
  });
  it("pending 占位 → stop blocker", () => {
    const legs = structuredClone(LEGS);
    legs[1] = { ...legs[1]!, toStop: "待定停靠点", pending: true };
    const r = auditPlan({ ...BASE, legs });
    const f = byItem(r, "stop");
    assert.equal(f.length, 1);
    assert.equal(f[0]!.level, "blocker");
    assert.equal(f[0]!.leg, 1);
  });
});

describe("[F-58-02][F-58-03][F-58-04][F-58-05][F-58-12][F-58-13][AC-58-1][AC-58-2][AC-58-3][AC-58-7][AC-58-8] return", () => {
  it("[M77 走查追修] 连分段都没有时说「缺分段数据」，不说「最后一段没有终点站」", () => {
    const r = auditPlan({
      skeleton: [{ day: 1, spots: [{ name: "云龙湖" }] }],
      destination: "徐州",
      origin: "上海",
      limits: { legSafeMaxMin: 180, dailyMaxMin: 540 },
      constraints: [],
    });
    const ret = r.findings.find((f) => f.item === "return");
    assert.equal(ret?.missing, "分段数据", "与 leg / daily / stop 三条同一个根因，就该是同一句话");
    // 四条"验不了"口径必须一致，否则读的人以为撞上了四个毛病
    const missings = r.findings.filter((f) => f.level === "unverifiable").map((f) => f.missing);
    assert.deepEqual(new Set(missings), new Set(["分段数据"]));
  });

  it("normalizePlace：徐州市 / 徐州 / 徐 州 同一处", () => {
    assert.equal(normalizePlace("徐州市"), normalizePlace("徐 州"));
  });
  it("最后一站名等于出发地 → passed 无 finding；不等且无返程段 → unverifiable", () => {
    const sk = structuredClone(SKELETON);
    sk[2]!.spots.push({ name: "杭州市" });
    const ok = auditPlan({ ...BASE, skeleton: sk, legs: undefined });
    assert.equal(byItem(ok, "return").length, 0);
    const nope = auditPlan(BASE);
    const f = byItem(nope, "return");
    assert.equal(f.length, 1);
    assert.equal(f[0]!.level, "unverifiable");
    assert.match(f[0]!.missing!, /返程段/);
  });
  it("缺 origin → unverifiable 缺出发地；单程声明 / 大交通往返 → 不报", () => {
    const noOrigin = auditPlan({ ...BASE, origin: undefined });
    assert.equal(byItem(noOrigin, "return")[0]!.missing, "出发地");
    assert.equal(byItem(auditPlan({ ...BASE, constraints: ["单程，不回"] }), "return").length, 0);
    assert.equal(byItem(auditPlan({ ...BASE, hasReturnTransit: true }), "return").length, 0);
  });
});

describe("[F-58-02][F-58-03][F-58-04][F-58-05][F-58-12][F-58-13][AC-58-1][AC-58-2][AC-58-3][AC-58-7][AC-58-8] order（编排层给的结论）", () => {
  it("warning 原样并进；unverifiable 带原因；orderWarnings 缺省则不计 passed 也不报", () => {
    const w = auditPlan({ ...BASE, orderWarnings: [{ day: 1, basis: "第 1 天顺序有 1 处交叉（直线估算）" }] });
    assert.deepEqual(byItem(w, "order").map((f) => [f.level, f.day]), [["warning", 1]]);
    const u = auditPlan({ ...BASE, orderWarnings: undefined, orderUnverifiable: "无坐标" });
    assert.equal(byItem(u, "order")[0]!.missing, "无坐标");
    const none = auditPlan({ ...BASE, orderWarnings: undefined });
    assert.equal(byItem(none, "order").length, 0);
    const empty = auditPlan({ ...BASE, orderWarnings: [] });
    assert.equal(none.passed, empty.passed - 1, "空数组 = 验过且无问题，计一项 passed；缺省 = 没验，不计");
    assert.equal(w.passed, none.passed, "有 warning 也不算 passed");
  });
});
