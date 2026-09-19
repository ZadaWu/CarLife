/**
 * M93-01：声明是派生量，不是流水账。
 *
 * 真实病例（`sess-0a5f5ba9-3b9`，落库行程 `cmu3q9iip0006xulkc8gu71sa`）：
 * 车主把第 2 晚改成迪士尼酒店、方案里也确实改成功了，确认时暖暖却说
 * 「第1晚和第2晚都还是奥特曼酒店」。落库那份的 caveats 里挂着「第1天位于「奉贤区」」
 * 「第2天位于「黄浦区」」——**那份行程的片区是浦东临港与迪士尼度假区，两个区一个都不在**，
 * 还有「酒店价格与车票…」与「酒店价格…」两个不同轮次的版本并排躺着。
 *
 * 本组钉住四件事：重算幂等、上一轮的声明不跨轮、坐标不全不判也不说、
 * 轮次事件不落进快照；外加表述层的权威事实行与两处措辞。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { TripPlanDay } from "@carlife/shared";
import type { BranchResult } from "../src/graph/fanout";
import type { TripPlanState } from "../src/graph/state";
import {
  deriveCaveats,
  describeCommitted,
  describeItineraryPlan,
  mergeItinerary,
  type ItineraryMergeOutput,
} from "../src/graph/subgraphs/itinerary";

// ── 夹具 ────────────────────────────────────────────────────

/** 真跑那份行程的坐标（落库快照原值），距离判据的用例都拿它当底座。 */
const AT = {
  海昌园: { lat: 30.912653, lon: 121.905695 },
  海昌酒店: { lat: 30.914167, lon: 121.907011 },
  迪士尼: { lat: 31.14, lon: 121.66 },
} as const;

const day = (n: number, over: Partial<TripPlanDay> = {}): TripPlanDay => ({
  day: n,
  theme: `第${n}天`,
  spots: [],
  ...over,
});

const planOf = (skeleton: TripPlanDay[]): Pick<TripPlanState, "skeleton"> => ({ skeleton });

// ── 幂等与不跨轮 ─────────────────────────────────────────────

test("[F-13-05][AC-13-5] 同一份方案连算两次，声明逐字相同", () => {
  const plan = planOf([
    day(1, {
      area: "浦东新区（临港）",
      spots: [{ name: "上海海昌海洋公园", ...AT.海昌园 }],
      hotel: { name: "上海海昌奥特曼主题酒店", ...AT.海昌酒店, estPrice: "约700-1500/晚（估算）" },
    }),
    day(2, { area: "黄浦区", spots: [] }),
  ]);
  assert.deepEqual(deriveCaveats(plan), deriveCaveats(plan));
});

test("[F-13-05][AC-13-5] 上一轮的声明不跨轮：本轮不成立就不再出现", () => {
  // 上一轮留下的那条（片区是「奉贤区」）在本轮方案里没有任何依据。
  const stale = "第1天位于「奉贤区」，本轮未找到该片区住宿候选——住宿沿用「上海海昌奥特曼主题酒店」";
  const plan: Pick<TripPlanState, "skeleton"> = planOf([
    day(1, {
      area: "浦东新区（临港）",
      spots: [{ name: "上海海昌海洋公园", ...AT.海昌园 }],
      hotel: { name: "上海海昌奥特曼主题酒店", ...AT.海昌酒店 },
    }),
    day(2, { area: "返程", spots: [] }),
  ]);
  const fresh = deriveCaveats(plan);
  assert.ok(!fresh.includes(stale), `陈旧声明仍在：${fresh.join("；")}`);
  assert.deepEqual(fresh, []);
});

// ── 片区缺口：先按距离，退回比标签，两样都没有就不说 ─────────────

test("[F-13-05][AC-13-5] 有坐标 → 按距离判；超阈值才发，够近不发", () => {
  const far = deriveCaveats(
    planOf([
      day(1, {
        area: "浦东新区（迪士尼度假区）",
        spots: [{ name: "上海迪士尼度假区", ...AT.迪士尼 }],
        hotel: { name: "上海海昌奥特曼主题酒店", ...AT.海昌酒店 },
      }),
      day(2, { area: "返程", spots: [] }),
    ]),
  );
  assert.equal(far.length, 1);
  assert.match(far[0]!, /^第1天位于「浦东新区（迪士尼度假区）」，当晚住的「上海海昌奥特曼主题酒店」离当天行程点约 3\d 公里，不在同一片区$/);

  const near = deriveCaveats(
    planOf([
      day(1, {
        area: "浦东新区（临港）",
        spots: [{ name: "上海海昌海洋公园", ...AT.海昌园 }],
        hotel: { name: "上海海昌奥特曼主题酒店", ...AT.海昌酒店 },
      }),
      day(2, { area: "返程", spots: [] }),
    ]),
  );
  assert.deepEqual(near, []);
});

test("[F-13-05][AC-13-5] 没坐标但两边都标了片区 → 退回比标签（M35-01 的老判据）", () => {
  const out = deriveCaveats(
    planOf([
      day(1, { area: "番禺", spots: [{ name: "长隆" }], hotel: { name: "西关酒店", area: "西关" } }),
      day(2, { area: "返程", spots: [] }),
    ]),
  );
  assert.deepEqual(out, ['第1天位于「番禺」，当晚住的「西关酒店」标的是「西关」，不在同一片区']);
});

test("[F-13-05][AC-13-5] 坐标不全、酒店也没标片区 → 这一天一条都不发（不判即不说）", () => {
  const out = deriveCaveats(
    planOf([
      day(1, { area: "番禺", spots: [{ name: "长隆" }], hotel: { name: "某酒店" } }),
      day(2, { area: "返程", spots: [] }),
    ]),
  );
  assert.deepEqual(out, []);
});

test("[F-13-05][AC-13-5] 酒店有坐标但当天景点没有 → 距离判不了，退回比标签", () => {
  const out = deriveCaveats(
    planOf([
      day(1, { area: "番禺", spots: [{ name: "长隆" }], hotel: { name: "西关酒店", area: "西关", ...AT.海昌酒店 } }),
      day(2, { area: "返程", spots: [] }),
    ]),
  );
  assert.equal(out.length, 1);
  assert.match(out[0]!, /标的是「西关」/);
});

// ── 换住宿没换成 ─────────────────────────────────────────────

test("[F-13-05][AC-13-5] 标了 lodging 却与前一晚同名 → 说出来；换了名字就不说", () => {
  const same = deriveCaveats(
    planOf([
      day(1, { area: "市区", spots: [{ name: "A", ...AT.海昌园 }], hotel: { name: "唯一酒店", ...AT.海昌酒店 } }),
      day(2, {
        area: "市区",
        spots: [{ name: "B", ...AT.海昌园 }],
        lodging: { strategy: "checkin-evening" },
        hotel: { name: "唯一酒店", ...AT.海昌酒店 },
      }),
      day(3, { area: "返程", spots: [] }),
    ]),
  );
  assert.deepEqual(same, ["第2天计划换住宿，但仍是「唯一酒店」"]);

  const changed = deriveCaveats(
    planOf([
      day(1, { area: "市区", spots: [{ name: "A", ...AT.海昌园 }], hotel: { name: "甲酒店", ...AT.海昌酒店 } }),
      day(2, {
        area: "市区",
        spots: [{ name: "B", ...AT.海昌园 }],
        lodging: { strategy: "checkin-evening" },
        hotel: { name: "乙酒店", ...AT.海昌酒店 },
      }),
      day(3, { area: "返程", spots: [] }),
    ]),
  );
  assert.deepEqual(changed, []);
});

// ── 估算声明三态 ─────────────────────────────────────────────

test("[F-13-05][AC-13-5] 估算声明照方案里真有的东西说，且不会攒出两个版本", () => {
  const withHotelPrice = planOf([
    day(1, { spots: [], hotel: { name: "某酒店", estPrice: "约400-700/晚（估算）" } }),
  ]);
  assert.deepEqual(deriveCaveats(withHotelPrice), ["酒店价格为经验估算，须以实际预订平台为准"]);
  assert.deepEqual(deriveCaveats(withHotelPrice, { ticketed: ["train"] }), [
    "酒店价格与车票为经验估算，须以实际预订平台为准",
  ]);
  // 纯自驾、没有估价 → 一句都不加（"我没有定机票，我是自驾"那条走查）
  assert.deepEqual(deriveCaveats(planOf([day(1, { spots: [] })])), []);
});

// ── 轮次事件不落库 ───────────────────────────────────────────

const tourBranch = (days: unknown[]): BranchResult => ({
  agent: "tour-task",
  status: "ok",
  text: "",
  submission: { destination: "上海", days },
  startedAt: 0,
  endedAt: 1,
});
const emptyHotelBranch: BranchResult = {
  agent: "hotel-task",
  status: "ok",
  text: "",
  submission: { hotels: [] },
  startedAt: 0,
  endedAt: 1,
};

test("[F-13-05][AC-13-5] 「本轮没查到新候选」是轮次事件：说给车主听，但不进快照", () => {
  const prev: TripPlanState = {
    status: "refining",
    destination: "上海",
    days: 2,
    caveats: [],
    updatedTurnId: "t1",
    // 两天都挂着酒店：hotel 分支空手而归时，"草案里真的还有酒店"才走轮次事件那一支
    // （真的一天都没有时它必须说「这次没查到」，那是 missing 的活）。
    skeleton: [
      day(1, { area: "临港", spots: [{ name: "A" }], hotel: { name: "旧酒店", area: "临港" } }),
      day(2, { area: "临港", spots: [{ name: "B" }], hotel: { name: "旧酒店", area: "临港" } }),
    ],
  };
  const out = mergeItinerary(
    [tourBranch([{ day: 1, area: "临港", spots: [{ name: "A" }] }, { day: 2, area: "返程", spots: [] }]), emptyHotelBranch],
    { goal: "改一下", constraints: [], userText: "改一下", plan: prev, turnId: "t2" },
    ["tour", "hotel"],
  );
  assert.ok(
    out.turnNotes.some((n) => n.includes("本轮未查到新的酒店候选")),
    `turnNotes：${out.turnNotes.join("；")}`,
  );
  assert.ok(
    !out.plan.caveats.some((c) => c.includes("本轮未查到新的酒店候选")),
    `它不该进快照：${out.plan.caveats.join("；")}`,
  );
});

// ── 表述层 ──────────────────────────────────────────────────

const outOf = (skeleton: TripPlanDay[], over: Partial<ItineraryMergeOutput> = {}): ItineraryMergeOutput => ({
  plan: { status: "refining", destination: "上海", days: skeleton.length, caveats: [], updatedTurnId: "t1", skeleton },
  violations: [],
  missing: [],
  findings: [],
  turnNotes: [],
  solverDegraded: false,
  hotelSource: "submission",
  tourSource: "submission",
  transitSource: "missing",
  driveSource: "missing",
  ...over,
});

test("[F-13-05][AC-13-5] 权威事实行：3 天 2 晚，逐晚点名", () => {
  const text = describeItineraryPlan(
    outOf([
      day(1, { spots: [], hotel: { name: "奥特曼酒店" } }),
      day(2, { spots: [], hotel: { name: "迪士尼乐园酒店" } }),
      day(3, { spots: [] }),
    ]),
  );
  assert.match(text, /【住宿（以此为准）】共 3 天 2 晚；第 1 晚住奥特曼酒店，第 2 晚住迪士尼乐园酒店/);
});

test("[F-13-05][AC-13-5] 全程不住宿也要明说，不留空让模型自己猜", () => {
  const text = describeItineraryPlan(outOf([day(1, { spots: [] })]));
  assert.match(text, /【住宿（以此为准）】共 1 天 0 晚；全程不住宿/);
});

test("[F-13-05][AC-13-5] findings 降级成「求解过程中的说法」，条目一条不少", () => {
  const text = describeItineraryPlan(
    outOf([day(1, { spots: [] })], { findings: ["G260 132 分钟 84 元", "住宿沿用某酒店连住三晚"] }),
  );
  assert.ok(!text.includes("可以直接讲给车主"), "旧标注仍在");
  assert.match(text, /上面那份方案才是最终结果/);
  assert.ok(text.includes("G260 132 分钟 84 元"));
  assert.ok(text.includes("住宿沿用某酒店连住三晚"));
});

test("[F-13-05][AC-13-5] 确认措辞不再说「既有声明仍然有效」——它们是本轮算出来的", () => {
  const text = describeCommitted({
    status: "confirmed",
    destination: "上海",
    days: 3,
    caveats: ["酒店价格为经验估算，须以实际预订平台为准"],
    updatedTurnId: "t1",
    skeleton: [],
  });
  assert.ok(!text.includes("既有声明仍然有效"));
  assert.match(text, /这份行程要一并说明：酒店价格为经验估算/);
});
