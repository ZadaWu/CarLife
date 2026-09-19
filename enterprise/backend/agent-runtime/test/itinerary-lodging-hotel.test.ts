/**
 * M35-01：住宿跟随策略——追发合并、挂载语义（缺口检测与追跳已随 M86-06 删除：缺省档有骨架，片区一开始就在 hotel 的 prompt 里）。
 *
 * 真实病例（sess-81d1a48a）：tour 的 D3 lodging note 写"傍晚入住番禺酒店"，
 * hotel 分支只回珠江新城候选，旧挂载 `list[0]` 静默铺满四晚、零提示。
 * 本组测试钉住两件事：两轮候选按名去重合并、无匹配沿用前一天 + caveat 明示（不再静默）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { BranchResult } from "../src/graph/fanout";
import { combineHotelBranches, mergeItinerary } from "../src/graph/subgraphs/itinerary";

const day = (
  n: number,
  area: string | undefined,
  lodging?: { strategy: "checkin-midday" | "checkin-evening" },
) => ({ day: n, theme: `第${n}天`, area, spots: [], ...(lodging ? { lodging } : {}) });

// ── combineHotelBranches ────────────────────────────────────

const branch = (agent: string, submission: unknown): BranchResult => ({
  agent,
  status: "ok",
  text: "",
  startedAt: 0,
  endedAt: 1,
  submission,
});

test("两轮候选按名去重合并：首轮优先、新增追加、findings 都保留", () => {
  const first = [
    branch("tour-task", { days: [] }),
    branch("hotel-task", { hotels: [{ name: "甲", area: "西关" }], findings: ["查过西关"] }),
  ];
  const follow = branch("hotel-task", {
    hotels: [{ name: "甲", area: "改了也不算" }, { name: "乙", area: "番禺" }],
    findings: ["补查番禺"],
  });
  const combined = combineHotelBranches(first, follow)!;
  const hotelBranch = combined.find((b) => b.agent === "hotel-task")!;
  const hotels = (hotelBranch.submission as { hotels: Array<{ name: string; area?: string }> }).hotels;
  assert.deepEqual(hotels.map((h) => `${h.name}:${h.area}`), ["甲:西关", "乙:番禺"]);
  assert.deepEqual((hotelBranch.submission as { findings: string[] }).findings, [
    "查过西关",
    "补查番禺",
  ]);
  // tour 分支原样保留
  assert.ok(combined.some((b) => b.agent === "tour-task"));
});

test("追发失败/为空 → undefined（保留首轮 merge，caveat 已在挂载段生成）", () => {
  const first = [branch("hotel-task", { hotels: [{ name: "甲" }] })];
  assert.equal(combineHotelBranches(first, undefined), undefined);
  assert.equal(combineHotelBranches(first, branch("hotel-task", { hotels: [] })), undefined);
  assert.equal(
    combineHotelBranches(first, { ...branch("hotel-task", {}), status: "timeout" as const }),
    undefined,
  );
});

test("首轮 hotel 整支失败时，追发结果独立成军（恢复路径）", () => {
  const first: BranchResult[] = [
    { agent: "hotel-task", status: "failed", text: "", startedAt: 0, endedAt: 1 },
  ];
  const combined = combineHotelBranches(first, branch("hotel-task", { hotels: [{ name: "乙", area: "番禺" }] }))!;
  const hotel = combined.find((b) => b.agent === "hotel-task")!;
  assert.equal(hotel.status, "ok");
  assert.ok(JSON.stringify(hotel.submission ?? hotel.text).includes("乙"));
});

// ── 挂载语义（mergeItinerary hotel 段） ──────────────────────

const input = { goal: "", constraints: [], userText: "广州4天", turnId: "t1" };

// 末尾的返程日是 M77 走查追修加的：最后一天回家、不挂酒店，被检查的那几天才不是最后一天。
function mergeWith(tourDays: unknown, hotels: unknown) {
  const branches = [
    branch("tour-task", { days: tourDays }),
    branch("hotel-task", { hotels }),
  ];
  return mergeItinerary(branches, input, ["tour", "hotel"]);
}

test("多片区候选逐天挂载：番禺日挂番禺酒店（病例的正向形状）", () => {
  const out = mergeWith(
    [
      { day: 1, area: "西关", spots: [{ name: "A" }] },
      { day: 2, area: "番禺", spots: [{ name: "B" }], lodging: { strategy: "checkin-evening" } },
      { day: 3, area: "返程", spots: [] },
    ],
    [
      { name: "西关酒店", area: "西关" },
      { name: "长隆酒店", area: "番禺" },
    ],
  );
  assert.equal(out.plan.skeleton[0].hotel?.name, "西关酒店");
  assert.equal(out.plan.skeleton[1].hotel?.name, "长隆酒店");
  assert.ok(!out.plan.caveats.some((c) => c.includes("未找到该片区")));
});

test("无匹配沿用前一天（不再 list[0] 铺满）+ caveat 明示", () => {
  const out = mergeWith(
    [
      { day: 1, area: "珠江新城", spots: [{ name: "A" }] },
      { day: 2, area: "西关", spots: [{ name: "B" }] },
      { day: 3, area: "番禺", spots: [{ name: "C" }] },
      { day: 4, area: "返程", spots: [] },
    ],
    [
      { name: "珠城酒店", area: "珠江新城" },
      { name: "西关酒店", area: "西关" },
    ],
  );
  // D3 无番禺候选：沿用 D2 的西关酒店（连住语义），而不是跳回 list[0] 珠城酒店
  assert.equal(out.plan.skeleton[2].hotel?.name, "西关酒店");
  assert.ok(
    out.plan.caveats.some((c) => c.includes("第3天") && c.includes("番禺") && c.includes("西关酒店")),
    `caveats 应明示缺口：${out.plan.caveats.join("；")}`,
  );
});

test("换酒店日未兑现（lodging 在、酒店没换、片区却匹配不上新片区）→ caveat", () => {
  const out = mergeWith(
    [
      { day: 1, area: "市区", spots: [{ name: "A" }] },
      { day: 2, area: "市区", spots: [{ name: "B" }], lodging: { strategy: "checkin-evening" } },
      { day: 3, area: "返程", spots: [] },
    ],
    [{ name: "唯一酒店", area: "市区" }],
  );
  assert.equal(out.plan.skeleton[1].hotel?.name, "唯一酒店");
  assert.ok(
    out.plan.caveats.some((c) => c.includes("第2天") && c.includes("计划换住宿")),
    `caveats：${out.plan.caveats.join("；")}`,
  );
});

test("旧行为保持：全片区匹配的连住行程零新增 caveat", () => {
  const out = mergeWith(
    [
      { day: 1, area: "老城", spots: [{ name: "A" }] },
      { day: 2, area: "老城", spots: [{ name: "B" }] },
      { day: 3, area: "返程", spots: [] },
    ],
    [{ name: "老城酒店", area: "老城" }],
  );
  assert.equal(out.plan.skeleton[0].hotel?.name, "老城酒店");
  assert.equal(out.plan.skeleton[1].hotel?.name, "老城酒店");
  assert.ok(!out.plan.caveats.some((c) => c.includes("未找到该片区") || c.includes("计划换住宿")));
});

// ── 片区词表不齐的匹配（真跑 sess-3d4cf742 修正） ─────────────────

test("挂载同样吃词表匹配：西关候选挂上复合标签的天", () => {
  const out = mergeWith(
    [{ day: 1, area: "荔湾西关(陈家祠/永庆坊)", spots: [{ name: "A" }] }, { day: 2, area: "返程", spots: [] }],
    [{ name: "西关酒店", area: "西关" }],
  );
  assert.equal(out.plan.skeleton[0].hotel?.name, "西关酒店");
  assert.ok(!out.plan.caveats.some((c) => c.includes("未找到该片区")));
});
