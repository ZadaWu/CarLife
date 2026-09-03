/**
 * M35-01：住宿跟随策略——缺口检测、追跳合并、挂载语义。
 *
 * 真实病例（sess-81d1a48a）：tour 的 D3 lodging note 写"傍晚入住番禺酒店"，
 * hotel 分支只回珠江新城候选，旧挂载 `list[0]` 静默铺满四晚、零提示。
 * 本组测试钉住三件事：缺口要被检出、两轮候选按名去重合并、
 * 无匹配沿用前一天 + caveat 明示（不再静默）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { BranchResult } from "../src/graph/fanout";
import {
  combineHotelBranches,
  hotelAreaGaps,
  hotelCandidatesOf,
  mergeItinerary,
} from "../src/graph/subgraphs/itinerary";

const day = (
  n: number,
  area: string | undefined,
  lodging?: { strategy: "checkin-midday" | "checkin-evening" },
) => ({ day: n, theme: `第${n}天`, area, spots: [], ...(lodging ? { lodging } : {}) });

// ── hotelAreaGaps ───────────────────────────────────────────

test("远郊日无该片区候选 → 缺口命中（真实病例形状）", () => {
  const plan = {
    skeleton: [
      day(1, "西关"),
      day(2, "珠江新城"),
      day(3, "番禺", { strategy: "checkin-evening" }),
      day(4, "番禺"),
    ],
  };
  const gaps = hotelAreaGaps(plan, [{ area: "珠江新城" }, { area: "西关" }]);
  assert.deepEqual(gaps, ["番禺"]);
});

test("市区单片区全覆盖 → 零缺口（不追跳的判据）", () => {
  const plan = { skeleton: [day(1, "老城"), day(2, "老城")] };
  assert.deepEqual(hotelAreaGaps(plan, [{ area: "老城" }]), []);
});

test("片区没变且不带 lodging 的天不算缺口（沿用前一天即可）；area 缺省不误报", () => {
  const plan = { skeleton: [day(1, "西关"), day(2, "西关"), day(3, undefined)] };
  // 候选只有珠江新城：D1 是缺口（首日必须有落脚点），D2 同片区沿用、D3 无 area 不报
  assert.deepEqual(hotelAreaGaps(plan, [{ area: "珠江新城" }]), ["西关"]);
});

test("带 lodging 的换酒店日即使片区与前一天相同也要求覆盖", () => {
  const plan = {
    skeleton: [day(1, "番禺"), day(2, "番禺", { strategy: "checkin-evening" })],
  };
  assert.deepEqual(hotelAreaGaps(plan, []), ["番禺"]);
});

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
  const hotels = hotelCandidatesOf(combined);
  assert.deepEqual(hotels.map((h) => `${h.name}:${h.area}`), ["甲:西关", "乙:番禺"]);
  const hotelBranch = combined.find((b) => b.agent === "hotel-task")!;
  assert.deepEqual((hotelBranch.submission as { findings: string[] }).findings, [
    "查过西关",
    "补查番禺",
  ]);
  // tour 分支原样保留
  assert.ok(combined.some((b) => b.agent === "tour-task"));
});

test("追跳失败/为空 → undefined（保留首轮 merge，caveat 已在挂载段生成）", () => {
  const first = [branch("hotel-task", { hotels: [{ name: "甲" }] })];
  assert.equal(combineHotelBranches(first, undefined), undefined);
  assert.equal(combineHotelBranches(first, branch("hotel-task", { hotels: [] })), undefined);
  assert.equal(
    combineHotelBranches(first, { ...branch("hotel-task", {}), status: "timeout" as const }),
    undefined,
  );
});

test("首轮 hotel 整支失败时，追跳结果独立成军（恢复路径）", () => {
  const first: BranchResult[] = [
    { agent: "hotel-task", status: "failed", text: "", startedAt: 0, endedAt: 1 },
  ];
  const combined = combineHotelBranches(first, branch("hotel-task", { hotels: [{ name: "乙", area: "番禺" }] }))!;
  assert.deepEqual(hotelCandidatesOf(combined).map((h) => h.name), ["乙"]);
});

// ── 挂载语义（mergeItinerary hotel 段） ──────────────────────

const input = { goal: "", constraints: [], userText: "广州4天", turnId: "t1" };

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
    ],
    [{ name: "老城酒店", area: "老城" }],
  );
  assert.equal(out.plan.skeleton[0].hotel?.name, "老城酒店");
  assert.equal(out.plan.skeleton[1].hotel?.name, "老城酒店");
  assert.ok(!out.plan.caveats.some((c) => c.includes("未找到该片区") || c.includes("计划换住宿")));
});

// ── 片区词表不齐的匹配（真跑 sess-3d4cf742 修正） ─────────────────

test("复合片区标签与单词候选能匹配：荔湾西关(…) ↔ 西关（词表不齐不算缺口）", () => {
  const plan = {
    skeleton: [
      day(1, "荔湾西关(陈家祠/永庆坊/沙面)"),
      day(2, "越秀北京路"),
    ],
  };
  const gaps = hotelAreaGaps(plan, [{ area: "西关" }, { area: "北京路" }]);
  assert.deepEqual(gaps, []);
});

test("词表切开后仍无交集的才是真缺口：番禺/长隆 vs 珠江新城", () => {
  const plan = { skeleton: [day(1, "番禺/长隆", { strategy: "checkin-evening" })] };
  assert.deepEqual(hotelAreaGaps(plan, [{ area: "珠江新城" }]), ["番禺/长隆"]);
});

test("挂载同样吃词表匹配：西关候选挂上复合标签的天", () => {
  const out = mergeWith(
    [{ day: 1, area: "荔湾西关(陈家祠/永庆坊)", spots: [{ name: "A" }] }],
    [{ name: "西关酒店", area: "西关" }],
  );
  assert.equal(out.plan.skeleton[0].hotel?.name, "西关酒店");
  assert.ok(!out.plan.caveats.some((c) => c.includes("未找到该片区")));
});
