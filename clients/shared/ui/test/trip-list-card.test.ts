/**
 * [F-01-04][AC-01-1][F-01-05][AC-01-5][F-18-15][AC-18-11] 行程列表卡（M72-04）。
 *
 * 用 `react-dom/server` 渲染成字符串断言（本包没有 DOM 环境）。盯的是三类"看起来正常"的错：
 * 没核查的天画成了太阳（灰点才是"没查到"）；作废的核查还在打点；起点没写时编了个地名。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { TripPlanListEntry, TripPlanSnapshot } from "@carlife/shared";

import { TripListCard, dayCells, entryNeedsAttention, tripMetaLabel, tripRouteLabel } from "../src/hud/TripListCard";
import { hudAlertFrom } from "../src/hud/hud-alert";

const ICONS = { sunny: "sun.png", cloudy: "cloud.png", rain: "rain.png", overcast: "o.png", snow: "s.png", haze: "h.png" };

function plan(over: Partial<TripPlanSnapshot> = {}): TripPlanSnapshot {
  return {
    status: "confirmed",
    destination: "青岛",
    startDate: "2026-09-12",
    days: 3,
    skeleton: [1, 2, 3].map((d) => ({ day: d, theme: `D${d}`, spots: [{ name: `点${d}` }] })),
    caveats: [],
    updatedTurnId: "t",
    ...over,
  };
}

function entry(planId: string, over: Partial<TripPlanListEntry> = {}, planOver: Partial<TripPlanSnapshot> = {}): TripPlanListEntry {
  return {
    planId,
    plan: plan(planOver),
    committedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const review = (over: Partial<NonNullable<TripPlanListEntry["review"]>> = {}): NonNullable<TripPlanListEntry["review"]> => ({
  reviewId: "r1",
  planId: "p1",
  reviewedAt: "2026-09-08T06:10:00.000Z",
  days: [
    { day: 1, kind: "cloudy", label: "多云" },
    { day: 2, kind: "rain", label: "雷阵雨" },
    { day: 3, unavailable: true },
  ],
  changes: [{ kind: "weather", day: 2, before: "多云", after: "雷阵雨", severity: "notice", text: "第 2 天：多云 → 雷阵雨" }],
  severity: "notice",
  ...over,
});

const render = (entries: TripPlanListEntry[], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(TripListCard, { entries, weatherIcons: ICONS, ...extra } as never));

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("行程列表卡：行与文案", () => {
  it("3 份行程渲染 3 行；起点：写了用写的，没写用常住地，再没有「出发」", () => {
    const html = render([
      entry("p1", {}, { origin: "上海" }),
      entry("p2"),
      entry("p3"),
    ], { homeCity: "浙江杭州" });
    assert.equal(count(html, 'class="hud-trips__row'), 3);
    assert.ok(html.includes("上海 → 青岛"));
    assert.ok(html.includes("浙江杭州 → 青岛"));
    assert.equal(tripRouteLabel({ destination: "青岛" }), "出发 → 青岛");
  });

  it("日期文案：9/12 起 · 3 天；没定日期 → 日期待定", () => {
    assert.equal(tripMetaLabel({ startDate: "2026-09-12", days: 3 }), "9/12 起 · 3 天");
    assert.equal(tripMetaLabel({ startDate: undefined, days: 2 }), "日期待定 · 2 天");
  });

  it("不是对话气泡：卡是 section + 列表，没有 message/bubble 类（AC-01-1）", () => {
    const html = render([entry("p1")]);
    assert.ok(html.startsWith('<section class="hud-card hud-trips"'));
    assert.ok(!/bubble|message/.test(html));
  });
});

describe("逐日天气位：灰点不是晴天（F-01-05）", () => {
  it("有核查：第 1、2 天画贴纸，第 3 天 unavailable 画灰点", () => {
    const e = entry("p1", { review: review() });
    const { cells } = dayCells(e);
    assert.deepEqual(cells.map((c) => c.kind), ["cloudy", "rain", undefined]);
    const html = render([e]);
    assert.equal(count(html, 'class="hud-trips__weather"'), 2);
    assert.equal(count(html, "hud-trips__dot--unknown"), 1);
  });

  it("没核查：只把确认那刻的整程天气画在第 1 天，其余灰点；连整程天气也没有 → 全灰点", () => {
    const withKind = dayCells(entry("p1", {}, { weather: { kind: "sunny", label: "晴" } }));
    assert.deepEqual(withKind.cells.map((c) => c.kind), ["sunny", undefined, undefined]);
    const none = dayCells(entry("p1"));
    assert.deepEqual(none.cells.map((c) => c.kind), [undefined, undefined, undefined]);
  });

  it("没定日期 + 没核查：确认那刻的整程天气不兜底（默认出发日随今天移动，那份已过期）→ 全灰点", () => {
    const undated = dayCells(entry("p1", {}, { startDate: undefined, weather: { kind: "sunny", label: "晴" } }));
    assert.deepEqual(undated.cells.map((c) => c.kind), [undefined, undefined, undefined]);
    // 有有效核查时照核查画——没定日期的核查按明天起取预报，是有效值。
    const reviewed = dayCells(entry("p1", { review: review() }, { startDate: undefined }));
    assert.deepEqual(reviewed.cells.map((c) => c.kind), ["cloudy", "rain", undefined]);
  });

  it("6 天行程：5 格 + 「+1」", () => {
    const e = entry("p1", {}, { days: 6, skeleton: [] });
    const { cells, overflow } = dayCells(e);
    assert.equal(cells.length, 5);
    assert.equal(overflow, 1);
    assert.ok(render([e]).includes(">+1<"));
  });

  it("核查作废（行程在核查之后被改过）→ 按没核查处理", () => {
    const e = entry("p1", { review: review(), updatedAt: "2026-09-08T09:00:00.000Z" });
    assert.deepEqual(dayCells(e).cells.map((c) => c.kind), [undefined, undefined, undefined]);
  });
});

describe("变化点与选中", () => {
  it("有未确认变化 → has-attention + 可点的旗子；ack 后没有；作废也没有", () => {
    const flagged = render([entry("p1", { review: review() })]);
    assert.ok(flagged.includes("has-attention"));
    assert.ok(flagged.includes('aria-label="行程有变化，点击查看"'));
    const acked = render([entry("p1", { review: review({ ackedAt: "2026-09-08T07:00:00.000Z" }) })]);
    assert.ok(!acked.includes("has-attention"));
    assert.equal(entryNeedsAttention(entry("p1", { review: review(), updatedAt: "2026-09-08T09:00:00.000Z" })), false);
  });

  it("critical → is-critical（脉冲类）且文案说「重要变化」", () => {
    const html = render([entry("p1", { review: review({ severity: "critical" }) })]);
    assert.ok(html.includes("is-critical"));
    assert.ok(html.includes("行程有重要变化"));
  });

  it("选中的行带 is-selected 且 aria-pressed", () => {
    const html = render([entry("p1"), entry("p2")], { selectedPlanId: "p2" });
    assert.equal(count(html, "is-selected"), 1);
    assert.ok(html.includes('aria-pressed="true"'));
  });

  it("超过 3 程列表加滚动类", () => {
    const html = render([entry("p1"), entry("p2"), entry("p3"), entry("p4")]);
    assert.ok(html.includes("hud-trips__list is-scroll"));
  });
});

describe("暖暖 alert 判据（AC-01-4：只有 critical 未确认才抢占）", () => {
  it("critical 未 ack → true；ack 后 → false；notice → false；作废 → false；无核查 → false", () => {
    assert.equal(hudAlertFrom([entry("p1", { review: review({ severity: "critical" }) })]), true);
    assert.equal(hudAlertFrom([entry("p1", { review: review({ severity: "critical", ackedAt: "2026-09-08T07:00:00.000Z" }) })]), false);
    assert.equal(hudAlertFrom([entry("p1", { review: review() })]), false);
    assert.equal(hudAlertFrom([entry("p1", { review: review({ severity: "critical" }), updatedAt: "2026-09-09T00:00:00.000Z" })]), false);
    assert.equal(hudAlertFrom([entry("p1")]), false);
    assert.equal(hudAlertFrom([]), false);
  });
});
