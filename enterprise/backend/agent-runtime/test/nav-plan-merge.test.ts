/**
 * 出发导航方案的代码汇聚（施工单 M66-02）——本 Sprint 的核心断言全打在这里。
 *
 *  1. 途经点零信任：名对坐标错、(0,0)、不在候选里的一律丢，并把"丢了几个"说出来；
 *  2. 无提交不是失败：起终点直连 + 一条 caveat；
 *  3. 单段上限只核不改：超上限写 caveat、方案保留；
 *  4. 省钱方案仍有过路费要说；空途经点不是失败。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RestStop } from "@carlife/tools";

import { NO_SUBMISSION_CAVEAT, mergeNavPlan, navPrompt, type NavPlanInput } from "../src/graph/subgraphs/nav-plan";

const A: RestStop = { name: "南湖服务区", lat: 30.741319, lon: 120.934428, type: "高速服务区", atKm: 80, atMinute: 70, detourM: 900 };
const B: RestStop = { name: "嘉善服务区(申嘉湖高速湖州方向)", lat: 30.889023, lon: 120.852123, type: "高速服务区", atKm: 150, atMinute: 140, detourM: 1500 };
const SUMMARY = { distanceKm: 243.4, durationMin: 257, tollYuan: 76, trafficLights: 3 };

const input = (over: Partial<NavPlanInput> = {}): NavPlanInput => ({
  origin: { lat: 31.2304, lon: 121.4737, source: "fix", ageMinutes: 2 },
  destination: { name: "灵隐寺", lat: 30.2419, lon: 120.0987 },
  strategy: "highway",
  strategyReason: "默认走高速",
  constraints: [{ text: "同行者晕车：单段连续行驶不超过 90 分钟", from: ["妈"] }],
  maxLegMinutes: 90,
  needs: ["motion_sickness"],
  caveats: [],
  ...over,
});

const NOW = () => new Date("2026-09-02T08:00:00.000Z");

describe("mergeNavPlan：途经点零信任", () => {
  it("[F-18-08][AC-18-4] 名对坐标错、(0,0)、不在候选里的全部丢弃；通过的按 atMinute 排序并带候选的坐标（停靠点只认服务区候选）", () => {
    const plan = mergeNavPlan(
      input(),
      {
        strategy: "highway",
        waypoints: [
          { name: "嘉善服务区(申嘉湖高速湖州方向)", lat: B.lat, lon: B.lon, reason: "有正规卫生间" },
          { name: "南湖服务区", lat: 30.741319, lon: 120.934428 },
          { name: "南湖服务区", lat: 30.740121, lon: 120.933014 }, // 名对、坐标是另一方向那个
          { name: "紫竹茶寮", lat: 0, lon: 0 },
          { name: "编出来的服务区", lat: 30.5, lon: 120.5 },
        ],
        legMinutes: [70, 70, 117],
      },
      { stops: [A, B], summary: SUMMARY },
      NOW,
    );
    assert.deepEqual(
      plan.waypoints.map((w) => w.name),
      ["南湖服务区", "嘉善服务区(申嘉湖高速湖州方向)"],
    );
    assert.equal(plan.waypoints[1].reason, "有正规卫生间");
    assert.equal(plan.waypoints[0].atMinute, 70);
    assert.ok(plan.caveats.some((c) => c.includes("5 个休息点，2 个通过校验")), plan.caveats.join(" | "));
    assert.deepEqual(plan.legMinutes, [70, 70, 117], "分段由候选 atMinute 与总时长推出，不抄提交值");
    assert.equal(plan.computedAt, "2026-09-02T08:00:00.000Z");
    assert.deepEqual(plan.summary, { distanceKm: 243.4, durationMin: 257, tollYuan: 76 });
  });

  it("(0,0) 单独提交也丢，且计数说得出来", () => {
    const plan = mergeNavPlan(input(), { waypoints: [{ name: "x", lat: 0, lon: 0 }], legMinutes: [] }, { stops: [A], summary: SUMMARY }, NOW);
    assert.deepEqual(plan.waypoints, []);
    assert.ok(plan.caveats.some((c) => c.includes("1 个休息点，0 个通过校验")));
  });
});

describe("mergeNavPlan：降级与上限", () => {
  it("无提交 → 起终点直连 + NO_SUBMISSION_CAVEAT；summary 仍取记录器的", () => {
    const plan = mergeNavPlan(input(), undefined, { stops: [A], summary: SUMMARY }, NOW);
    assert.deepEqual(plan.waypoints, []);
    assert.ok(plan.caveats.includes(NO_SUBMISSION_CAVEAT));
    assert.equal(plan.summary.distanceKm, 243.4);
    assert.equal(plan.strategy, "highway");
  });

  it("[F-18-07][AC-18-4] 超上限只核不改：第 3 段 117 > 90 → caveat，途经点保留", () => {
    const plan = mergeNavPlan(
      input(),
      { waypoints: [{ name: A.name, lat: A.lat, lon: A.lon }, { name: B.name, lat: B.lat, lon: B.lon }], legMinutes: [] },
      { stops: [A, B], summary: SUMMARY },
      NOW,
    );
    assert.equal(plan.waypoints.length, 2);
    assert.ok(plan.caveats.some((c) => c === "第 3 段 117 分钟超过上限 90 分钟"), plan.caveats.join(" | "));
    assert.equal(plan.maxLegMinutes, 90);
  });

  it("候选为空且全程超上限（省道方案常见）→ 说「没有找到高速服务区」；空途经点本身不算失败", () => {
    const plan = mergeNavPlan(input({ strategy: "less_toll", strategyReason: "按你平时省钱的偏好" }), { waypoints: [], legMinutes: [357] }, { stops: [], summary: { ...SUMMARY, durationMin: 357, tollYuan: 0 } }, NOW);
    assert.ok(plan.caveats.some((c) => c.includes("没有找到高速服务区")));
    assert.ok(!plan.caveats.some((c) => c.includes("通过校验")), "空提交不写校验 caveat");
    assert.deepEqual(plan.legMinutes, [357]);
  });

  it("总时长在上限内、提交空途经点 → 没有任何 caveat", () => {
    const plan = mergeNavPlan(input(), { waypoints: [], legMinutes: [60] }, { stops: [], summary: { ...SUMMARY, durationMin: 60 } }, NOW);
    assert.deepEqual(plan.caveats, []);
    assert.deepEqual(plan.legMinutes, [60]);
  });

  it("省钱策略仍有过路费 → caveat；高速策略有过路费 → 不写", () => {
    const cost = mergeNavPlan(input({ strategy: "less_toll", strategyReason: "按你平时省钱的偏好", maxLegMinutes: undefined }), { waypoints: [], legMinutes: [] }, { stops: [], summary: { ...SUMMARY, tollYuan: 12 } }, NOW);
    assert.ok(cost.caveats.some((c) => c.includes("仍有 12 元过路费")));
    const fast = mergeNavPlan(input({ maxLegMinutes: undefined }), { waypoints: [], legMinutes: [] }, { stops: [], summary: SUMMARY }, NOW);
    assert.ok(!fast.caveats.some((c) => c.includes("过路费")));
  });

  it("记录器没记到 summary（map_route 没成功）→ 零值 + caveat，起点/约束原样带过去", () => {
    const plan = mergeNavPlan(input({ caveats: ["起点按常住地估算"] }), undefined, { stops: [] }, NOW);
    assert.deepEqual(plan.summary, { distanceKm: 0, durationMin: 0, tollYuan: 0 });
    assert.ok(plan.caveats.some((c) => c.includes("里程与时长没有算出来")));
    assert.ok(plan.caveats.includes("起点按常住地估算"));
    assert.equal(plan.constraints[0].from[0], "妈");
  });
});

describe("navPrompt", () => {
  it("策略与上限写成已定输入；需要的判据来自 MEMBER_NEEDS.hint；收尾要求提交", () => {
    const p = navPrompt(input({ strategy: "less_toll", strategyReason: "按你平时省钱的偏好", needs: ["motion_sickness", "restroom"] }));
    assert.match(p, /`less_toll`/);
    assert.match(p, /maxLegMinutes 必须传 90/);
    assert.match(p, /正规卫生间/);
    assert.match(p, /submit_nav_plan/);
    assert.match(p, /lat 31\.230400, lon 121\.473700/);
    const free = navPrompt(input({ maxLegMinutes: undefined, constraints: [], needs: [] }));
    assert.match(free, /不传 maxLegMinutes/);
  });
});
