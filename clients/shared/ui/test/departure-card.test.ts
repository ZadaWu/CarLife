/**
 * 出发卡组件（2026-09-02 从 cockpit 上提，两端共用）。
 *
 * 盯的不变量：没行程时如实说、不编一份；CTA 是 `<a>`（WebView 里 window.open 会被静默吞掉）
 * 且 href 是 web 万能入口；规划中是禁用的 `<button>` 并带已等秒数；今天的站名与途径补能上卡；
 * 方案区把途经点全量渲染；无内联 style 之外的 token 纪律（只有量出来的 max-height 一条）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { NavPlan } from "@carlife/shared";

import { DepartureCard } from "../src/departure/DepartureCard";
import { applyResponse, markPlanningVisible, startPlanning, tickPlanning, IDLE_NAV_STATE } from "../src/departure/nav-state";
// 直接引文件而不是根入口：根入口带 png，node 里 import 不了。
import { DEMO_TRIP_PLAN } from "../src/hud/demo-trip-plan";

const TODAY = "2026-09-02";
/** 演示行程没有 startDate → 今天按第 1 天算：目标是广州塔，卡上列第 1 天两站。 */
const PLAN = DEMO_TRIP_PLAN;

const NAV_PLAN: NavPlan = {
  origin: { lat: 31.23, lon: 121.47, source: "fix" },
  destination: { name: "灵隐寺", lat: 30.2419, lon: 120.0987 },
  strategy: "less_toll",
  strategyReason: "按你平时省钱的偏好",
  summary: { distanceKm: 186.5, durationMin: 209, tollYuan: 0 },
  waypoints: [
    { name: "南湖服务区", lat: 30.741319, lon: 120.934428, atMinute: 80 },
    { name: "下沙服务区", lat: 30.307762, lon: 120.365516, atMinute: 143 },
    { name: "长安服务区", lat: 30.4, lon: 120.5, atMinute: 170 },
    { name: "萧山服务区", lat: 30.2, lon: 120.3, atMinute: 190 },
  ],
  legMinutes: [80, 63, 27, 20, 19],
  constraints: [],
  caveats: [],
  computedAt: "2026-09-02T08:00:00.000Z",
};

const render = (props: Parameters<typeof DepartureCard>[0]) => renderToStaticMarkup(createElement(DepartureCard, props));
const noop = () => {};

describe("DepartureCard", () => {
  it("没有行程：如实说「还没有已确认的行程」，只有「知道了」，没有导航按钮", () => {
    const html = render({ plan: null, navState: IDLE_NAV_STATE, onClose: noop, todayIso: TODAY });
    assert.match(html, /还没有已确认的行程/);
    assert.match(html, /知道了/);
    assert.ok(!html.includes("开始导航"));
  });

  it("规划中：CTA 是禁用的 <button>，文案带已等秒数（从卡片露面算）", () => {
    const s = tickPlanning(markPlanningVisible(startPlanning(1_000), 1_000), 4_200);
    const html = render({ plan: PLAN, navState: s, onClose: noop, todayIso: TODAY });
    assert.match(html, /<button[^>]*class="cabin-depart-card__primary"[^>]*disabled[^>]*>正在规划导航 3 s…<\/button>/);
    assert.ok(!html.includes("<a "), "规划中没有可跳的链接");
    assert.match(html, /广州（演示）/);
    assert.match(html, /广州塔/);
    assert.match(html, /海心沙亚运公园/);
    assert.ok(!html.includes("陈家祠堂"), "只列今天（第 1 天）的站");
    assert.match(html, /途径补能：泌冲充电站/);
  });

  it("方案到了：CTA 是 <a target=_blank>，href 是 uri.amap.com 万能入口、带第一个 via；途经点全量渲染", () => {
    const s = applyResponse(startPlanning(1_000), { status: "ready", plan: NAV_PLAN }, 9_000);
    const html = render({ plan: PLAN, navState: s, onClose: noop, todayIso: TODAY });
    const a = /<a class="cabin-depart-card__primary" href="([^"]+)" target="_blank" rel="noopener noreferrer" data-nav-mode="plan">开始导航<\/a>/.exec(html);
    assert.ok(a, html);
    const href = a![1]!.replace(/&amp;/g, "&");
    assert.ok(href.startsWith("https://uri.amap.com/navigation?to=120.0987,30.2419,"), href);
    assert.ok(href.includes("policy=2"), "省钱 → 避免收费");
    assert.equal((href.match(/via=/g) ?? []).length, 1);
    for (const w of NAV_PLAN.waypoints) assert.ok(html.includes(w.name), `途经点 ${w.name} 要上卡`);
    assert.match(html, /少收费路线 · 按你平时省钱的偏好/);
    assert.match(html, /约 186.5 km · 209 分钟 · 过路费 0 元/);
    // 网页版只带第一个途经点，卡上要说出来丢了几个
    assert.match(html, /网页版高德只能带第一个途经点（丢弃 3 个）/);
  });

  it("降级：按钮回到可点的「开始导航」直连（href 无 via），hint 说超时", () => {
    const shown = markPlanningVisible(startPlanning(1_000), 1_000);
    const s = tickPlanning(shown, 1_000 + 60_000);
    const html = render({ plan: PLAN, navState: s, onClose: noop, todayIso: TODAY });
    assert.match(html, /data-nav-mode="direct">开始导航<\/a>/);
    assert.ok(!html.includes("via="));
    // 演示行程第 1 天是「中午入住」：今天第一站是酒店（tripPlanStops 把它排在景点前），不是广州塔。
    assert.match(html, /href="https:\/\/uri\.amap\.com\/navigation\?to=113\.3273,23\.1327,/, "直连的终点是今天第一站（到达日先入住 → 酒店），to 是 lon,lat");
    assert.match(html, /规划超时，按默认路线导航/);
  });
});
