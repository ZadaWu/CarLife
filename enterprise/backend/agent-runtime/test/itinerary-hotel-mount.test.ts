/**
 * M93-02：车主点名的那一家优先挂上，最后一天无条件不住宿。
 *
 * 夹具是真跑（`sess-0a5f5ba9-3b9` / `turn-e9702bdc`）的原件：hotel 分支交回的 9 条候选
 * 逐字取自那一轮 `submit_hotels` 的入参，坐标取自同一会话 `hotel_search` 的返回，
 * 三天骨架与景点坐标取自落库快照 `trip_plans.cmu3q9iip0006xulkc8gu71sa`。
 *
 * 那一轮的病灶：第 1 条候选的 `note` 写着「车主点名必住」，而挂载只按距离排序——
 * 同一门牌号（杞青路 777 号）上的「上海海昌海洋公园度假酒店」比奥特曼近约 60 米，
 * 于是第 1 晚落成了车主没点过名的那一家。赢家由浮点差决定。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { PoiCoord } from "../src/poi-coords";
import type { BranchResult } from "../src/graph/fanout";
import type { TripPlanState } from "../src/graph/state";
import { dropLastDayHotel, mergeItinerary } from "../src/graph/subgraphs/itinerary";

// ── 真跑夹具 ────────────────────────────────────────────────

/** 9 条候选 + 5 个景点的真实坐标（高德返回原值）。 */
const COORD: Record<string, PoiCoord> = {
  上海海昌奥特曼主题酒店: { lat: 30.913149, lon: 121.908555 },
  上海海昌海洋公园度假酒店: { lat: 30.914167, lon: 121.907011 },
  上海滴水湖英迪格酒店: { lat: 30.889133, lon: 121.929413 },
  "上海临港新辰国际会议中心凯悦嘉轩酒店(新辰临港中心店)": { lat: 30.909396, lon: 121.932908 },
  玩具总动员酒店: { lat: 31.139409, lon: 121.653311 },
  上海迪士尼乐园酒店: { lat: 31.13509, lon: 121.666344 },
  "觅应·米乐亲子度假露营花园酒店(上海国际旅游度假区店)": { lat: 31.153605, lon: 121.679587 },
  "岚枫酒店(上海迪士尼度假区店)": { lat: 31.145118, lon: 121.695556 },
  "上海初心启程酒店(上海国际旅游度假区店)": { lat: 31.17604, lon: 121.68358 },
  上海海昌海洋公园: { lat: 30.912653, lon: 121.905695 },
  中国航海博物馆: { lat: 30.89619, lon: 121.919745 },
  滴水湖庆典广场: { lat: 30.897485, lon: 121.927335 },
  上海迪士尼度假区: { lat: 31.141447, lon: 121.667003 },
  外滩: { lat: 31.233516, lon: 121.492127 },
};

const coordOf = (name: string | undefined): PoiCoord | undefined =>
  name ? COORD[name] : undefined;

type Candidate = { name: string; area: string; estPrice: string; ownerNamed?: boolean };

/** 那一轮交回的 9 条，顺序原样（第 1 条就是奥特曼——它从来不缺，缺的是"点名"这个字段）。 */
const CANDIDATES: readonly Candidate[] = [
  { name: "上海海昌奥特曼主题酒店", area: "浦东新区", estPrice: "约700-1500/晚（估算）" },
  { name: "上海海昌海洋公园度假酒店", area: "浦东新区", estPrice: "约700-1500/晚（估算）" },
  { name: "上海滴水湖英迪格酒店", area: "浦东新区", estPrice: "约800-1500/晚（估算）" },
  {
    name: "上海临港新辰国际会议中心凯悦嘉轩酒店(新辰临港中心店)",
    area: "浦东新区",
    estPrice: "约400-800/晚（估算）",
  },
  { name: "玩具总动员酒店", area: "浦东新区", estPrice: "约1500-3000/晚（估算）" },
  { name: "上海迪士尼乐园酒店", area: "浦东新区", estPrice: "约2000-3500/晚（估算）" },
  {
    name: "觅应·米乐亲子度假露营花园酒店(上海国际旅游度假区店)",
    area: "浦东新区",
    estPrice: "约300-600/晚（估算）",
  },
  { name: "岚枫酒店(上海迪士尼度假区店)", area: "浦东新区", estPrice: "约300-600/晚（估算）" },
  {
    name: "上海初心启程酒店(上海国际旅游度假区店)",
    area: "浦东新区",
    estPrice: "约300-600/晚（估算）",
  },
];

/** 点名只改那几条的一个字段，其余逐字不动——用例之间的差异因此只有这一处。 */
const named = (...names: string[]): Candidate[] =>
  CANDIDATES.map((h) => (names.includes(h.name) ? { ...h, ownerNamed: true } : { ...h }));

type DaySpec = { day: number; area: string; spots: string[]; lodging?: boolean };

/** 落库快照那三天（第 3 天是返杭日）。 */
const REAL_DAYS: readonly DaySpec[] = [
  { day: 1, area: "浦东新区（临港）", spots: ["上海海昌海洋公园", "中国航海博物馆"] },
  { day: 2, area: "浦东新区（迪士尼度假区）", spots: ["上海迪士尼度假区"] },
  { day: 3, area: "黄浦区·陆家嘴→返杭", spots: ["外滩"] },
];

const branch = (agent: string, submission: unknown): BranchResult => ({
  agent,
  status: "ok",
  text: "",
  submission,
  startedAt: 0,
  endedAt: 1,
});

const tourOf = (days: readonly DaySpec[]): BranchResult =>
  branch("tour-task", {
    destination: "上海",
    days: days.map((d) => ({
      day: d.day,
      theme: d.area,
      area: d.area,
      spots: d.spots.map((name) => ({ name })),
      ...(d.lodging ? { lodging: { strategy: "checkin-evening" } } : {}),
    })),
  });

/** 跑一次汇聚，返回逐天住宿（没有就是 undefined）。 */
const mount = (
  hotels: readonly Candidate[],
  days: readonly DaySpec[] = REAL_DAYS,
  ranBranches: readonly ("tour" | "hotel")[] = ["tour", "hotel"],
): Array<string | undefined> => {
  const out = mergeItinerary(
    [tourOf(days), branch("hotel-task", { hotels })],
    { goal: "浙江到上海三天", constraints: [], userText: "浙江到上海三天", turnId: "t1" },
    ranBranches,
    { coordOf },
  );
  return out.plan.skeleton.map((d) => d.hotel?.name);
};

// ── 点名优先 ────────────────────────────────────────────────

test("[F-13-02][AC-13-2] 不填 ownerNamed → 逐天挂载与改动前逐字相同（真跑那一版的结论）", () => {
  // 第 1 晚落在度假酒店而不是奥特曼，正是本单要修的那一幕；不标字段时必须原样复现，
  // 否则"加一个可选字段对既有分支零影响"这句话就不成立。
  assert.deepEqual(mount(CANDIDATES), [
    "上海海昌海洋公园度假酒店",
    "上海迪士尼乐园酒店",
    undefined,
  ]);
});

test("[F-13-02][AC-13-2] 奥特曼 + 迪士尼两家点名 → 各挂各的那一天", () => {
  assert.deepEqual(mount(named("上海海昌奥特曼主题酒店", "上海迪士尼乐园酒店")), [
    "上海海昌奥特曼主题酒店",
    "上海迪士尼乐园酒店",
    undefined,
  ]);
});

test("[F-13-02][AC-13-2] 点名压不过距离阈值：只有 30 公里外那家被点名 → 第 1 天照旧走距离档", () => {
  // day1 在临港、被点名的迪士尼乐园酒店在 30 km 外。没有阈值这一道，day1 会挂上迪士尼那家。
  assert.deepEqual(mount(named("上海迪士尼乐园酒店")), [
    "上海海昌海洋公园度假酒店",
    "上海迪士尼乐园酒店",
    undefined,
  ]);
});

test("[F-13-02][AC-13-2] 阈值内两家都点名 → 取近的那家（同一门牌号上差 60 米）", () => {
  assert.equal(
    mount(named("上海海昌奥特曼主题酒店", "上海海昌海洋公园度假酒店"))[0],
    "上海海昌海洋公园度假酒店",
  );
});

test("[F-13-02][AC-13-2] 点名压过连住：前一晚那家也在阈值内，今天仍换成被点名的", () => {
  // 两天都在临港：不点名时第 2 天会沿用第 1 天那家（连住），点名后必须换过去。
  const twoNightsInLingang: DaySpec[] = [
    { day: 1, area: "浦东新区（临港）", spots: ["上海海昌海洋公园"] },
    { day: 2, area: "浦东新区（临港）", spots: ["滴水湖庆典广场"] },
    { day: 3, area: "黄浦区·返杭", spots: ["外滩"] },
  ];
  assert.deepEqual(mount(CANDIDATES, twoNightsInLingang), [
    "上海海昌海洋公园度假酒店",
    "上海海昌海洋公园度假酒店",
    undefined,
  ]);
  assert.deepEqual(mount(named("上海滴水湖英迪格酒店"), twoNightsInLingang), [
    "上海滴水湖英迪格酒店",
    "上海滴水湖英迪格酒店",
    undefined,
  ]);
});

// ── 最后一天不住宿：无条件不变量 ─────────────────────────────

test("[F-13-02][AC-13-2] hotel 分支这一轮没跑 → 最后一天照样没有住宿", () => {
  const prev: TripPlanState = {
    status: "refining",
    destination: "上海",
    days: 3,
    caveats: [],
    updatedTurnId: "t0",
    skeleton: [
      { day: 1, theme: "临港", area: "浦东新区（临港）", spots: [{ name: "上海海昌海洋公园" }], hotel: { name: "上海海昌奥特曼主题酒店" } },
      { day: 2, theme: "迪士尼", area: "浦东新区（迪士尼度假区）", spots: [{ name: "上海迪士尼度假区" }], hotel: { name: "上海迪士尼乐园酒店" } },
      { day: 3, theme: "返杭", area: "黄浦区", spots: [{ name: "外滩" }], hotel: { name: "上海迪士尼乐园酒店" } },
    ],
  };
  const out = mergeItinerary(
    [tourOf(REAL_DAYS)],
    { goal: "改一下", constraints: [], userText: "改一下", plan: prev, turnId: "t1" },
    ["tour"], // hotel 分支没跑：旧代码整段 `if (list.length > 0)` 不执行，第 3 晚就留在快照里
    { coordOf },
  );
  assert.equal(out.plan.skeleton[2]?.hotel, undefined);
});

test("[F-13-02][AC-13-2] hotel 分支跑了但候选为空 → 最后一天没有住宿", () => {
  assert.deepEqual(mount([]), [undefined, undefined, undefined]);
});

test("[F-13-02][AC-13-2] 天数从 4 缩到 3：旧的第 3 晚现在成了最后一天，要清干净", () => {
  const prev: TripPlanState = {
    status: "refining",
    destination: "上海",
    days: 4,
    caveats: [],
    updatedTurnId: "t0",
    skeleton: [1, 2, 3, 4].map((day) => ({
      day,
      theme: `第${day}天`,
      area: "浦东新区（临港）",
      spots: [{ name: "上海海昌海洋公园" }],
      hotel: { name: "上海海昌奥特曼主题酒店" },
    })),
  };
  // tour 只交回 3 天；天数守卫按天号接回旧的第 4 天……
  const out = mergeItinerary(
    [tourOf(REAL_DAYS.slice(0, 3))],
    { goal: "改成三天", constraints: [], userText: "改成三天", plan: prev, turnId: "t1" },
    ["tour"],
    { coordOf },
  );
  const last = out.plan.skeleton[out.plan.skeleton.length - 1]!;
  assert.equal(last.hotel, undefined, `最后一天（第 ${last.day} 天）仍挂着住宿`);
});

test("[F-13-02][AC-13-2] 单天行程：当天去当天回，不挂住宿", () => {
  assert.deepEqual(mount(CANDIDATES, [REAL_DAYS[0]!]), [undefined]);
});

test("[F-13-02][AC-13-2] 天号跳号（1、2、5）→ 清的是第 5 天，不是数组第 3 个", () => {
  const plan = {
    skeleton: [1, 2, 5].map((day) => ({
      day,
      theme: `第${day}天`,
      spots: [],
      hotel: { name: `第${day}天的酒店` },
      lodging: { strategy: "checkin-evening" as const },
    })),
  };
  dropLastDayHotel(plan);
  assert.deepEqual(
    plan.skeleton.map((d) => d.hotel?.name),
    ["第1天的酒店", "第2天的酒店", undefined],
  );
  // 最后一天连住宿都没有，"换不换住宿"无从谈起——lodging 一并清掉。
  assert.equal(plan.skeleton[2]!.lodging, undefined);
});

test("[F-13-02][AC-13-2] 空骨架不抛（细化轮 tour 一天都没交回时会走到这里）", () => {
  const plan = { skeleton: [] };
  dropLastDayHotel(plan);
  assert.deepEqual(plan.skeleton, []);
});
