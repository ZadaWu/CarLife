/**
 * [F-01-04][AC-01-1] 周日历行程卡（M73-01）。
 *
 * 用 `react-dom/server` 渲染成字符串断言。盯的是：本周条今天高亮、本周内行程成色块（进行中蓝 / 未来琥珀）、
 * 跨出周末带裁剪类、重叠超过 3 行折进清单、没定日期按明天起画成虚线色块、变化点在色块上、两处都能选中。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { weekOf, type TripPlanListEntry, type TripPlanSnapshot } from "@carlife/shared";

import { TripCalendarCard, clampPage, listDateLabel, pageOf, weekBars, weekRangeLabel } from "../src/hud/TripCalendarCard";

// 2026-09-08 是周二；本周 09-07（一）… 09-13（日）
const TODAY = "2026-09-08";
const WEEK = weekOf(TODAY);
const ICONS = { sunny: "sun.png", cloudy: "cloud.png", rain: "rain.png", overcast: "o.png", snow: "s.png", haze: "h.png" };

function plan(destination: string, startDate: string | undefined, days = 3): TripPlanSnapshot {
  return {
    status: "confirmed",
    destination,
    startDate,
    days,
    skeleton: Array.from({ length: days }, (_, i) => ({ day: i + 1, theme: `D${i + 1}`, spots: [{ name: `点${i + 1}` }] })),
    caveats: [],
    updatedTurnId: "t",
  };
}
function entry(planId: string, destination: string, startDate: string | undefined, days = 3, review?: TripPlanListEntry["review"]): TripPlanListEntry {
  return { planId, plan: plan(destination, startDate, days), committedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", review };
}
const critical = (planId: string): NonNullable<TripPlanListEntry["review"]> => ({
  reviewId: `r-${planId}`,
  planId,
  reviewedAt: "2026-09-08T06:10:00.000Z",
  days: [],
  changes: [{ kind: "alarm", day: 1, before: "无预警", after: "暴雨橙色预警", severity: "critical", text: "第 1 天：新增暴雨橙色预警" }],
  severity: "critical",
});

const render = (entries: TripPlanListEntry[], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(TripCalendarCard, { entries, today: TODAY, weatherIcons: ICONS, ...extra } as never));
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** 色块本体的数量：`hud-week__bars` / `hud-week__bar-text` 都以它为前缀，得按整词数。 */
const bars = (html: string) => (html.match(/class="hud-week__bar[ "]/g) ?? []).length;

describe("weekBars：本周内的行程 → 色块", () => {
  it("四种相对位置：全在周内 / 头在上周 / 尾在下周 / 两头都在外；不相交的不进来", () => {
    const bars = weekBars(
      [
        entry("in", "青岛", "2026-09-10", 2), // 四、五
        entry("head", "广州", "2026-09-05", 4), // 上周六 → 本周二
        entry("tail", "徐州", "2026-09-12", 4), // 六 → 下周二
        entry("both", "上海", "2026-09-01", 20),
        entry("far", "西安", "2026-09-30", 2),
      ],
      WEEK,
      TODAY,
      10,
    );
    const byId = Object.fromEntries(bars.map((b) => [b.entry.planId, b]));
    assert.deepEqual([byId.in!.startCol, byId.in!.endCol, byId.in!.clippedStart, byId.in!.clippedEnd], [3, 4, false, false]);
    assert.deepEqual([byId.head!.startCol, byId.head!.endCol, byId.head!.clippedStart, byId.head!.clippedEnd], [0, 1, true, false]);
    assert.deepEqual([byId.tail!.startCol, byId.tail!.endCol, byId.tail!.clippedStart, byId.tail!.clippedEnd], [5, 6, false, true]);
    assert.deepEqual([byId.both!.startCol, byId.both!.endCol, byId.both!.clippedStart, byId.both!.clippedEnd], [0, 6, true, true]);
    assert.equal(byId.far, undefined);
    assert.equal(byId.head!.ongoing, true, "上周六出发、本周二结束：今天在里面");
    assert.equal(byId.in!.ongoing, false);
  });

  it("没定日期按默认明天出发进色块（周三起、tentative）；超过 3 程折进清单", () => {
    const u = weekBars([entry("u", "未定", undefined, 2)], WEEK, TODAY);
    assert.equal(u.length, 1);
    assert.deepEqual([u[0]!.startCol, u[0]!.endCol, u[0]!.tentative, u[0]!.ongoing], [2, 3, true, false], "9/9 周三 → 9/10 周四");
    const entries = [entry("a", "A", "2026-09-08", 1), entry("b", "B", "2026-09-08", 1), entry("c", "C", "2026-09-08", 1), entry("u", "未定", undefined)];
    const bars = weekBars(entries, WEEK, TODAY);
    assert.deepEqual(bars.map((b) => b.entry.planId), ["a", "b", "c"]);
    assert.equal(bars.every((b) => b.tentative === false), true);
  });

  it("没定日期：周日当今天 → 默认出发日在下周，本周不画", () => {
    const sunday = "2026-09-13";
    assert.deepEqual(weekBars([entry("u", "未定", undefined)], weekOf(sunday), sunday), []);
  });

  it("listDateLabel：「9/27 周日」；没定日期仍是「待定」（默认出发日不冒充日期）", () => {
    assert.equal(listDateLabel(entry("x", "X", "2026-09-27")), "9/27 周日");
    assert.equal(listDateLabel(entry("x", "X", undefined)), "待定");
  });
});

describe("翻页纯函数", () => {
  it("clampPage 钳到 1..pageCount；pageOf 按页切", () => {
    assert.equal(clampPage(3, 1), 1);
    assert.equal(clampPage(0, 3), 1);
    assert.equal(clampPage(2, 3), 2);
    assert.equal(clampPage(9, 0), 1);
    assert.equal(clampPage(Number.NaN, 3), 1);
    assert.deepEqual(pageOf([1, 2, 3, 4, 5, 6, 7], 3, 3), [7]);
    assert.deepEqual(pageOf([1, 2, 3, 4, 5, 6, 7], 9, 3), [7], "越界页钳到最后一页");
    assert.deepEqual(pageOf([], 1, 3), []);
  });

  it("weekRangeLabel：「9/7 – 9/13」", () => {
    assert.equal(weekRangeLabel(WEEK), "9/7 – 9/13");
    assert.equal(weekRangeLabel([]), "");
  });
});

describe("渲染", () => {
  it("本周条 7 列、今天高亮；卡带 --calendar 修饰类", () => {
    const html = render([]);
    assert.ok(html.includes("hud-trips hud-trips--calendar"));
    assert.equal(count(html, 'role="columnheader"'), 7);
    assert.equal(count(html, "is-today"), 1);
    assert.ok(html.includes("本周没有行程"));
  });

  it("两程在本周 → 一蓝（进行中）一琥珀，色块文案带目的地与天数；跨出周末带 is-clipped-end", () => {
    const html = render([entry("g", "广州", "2026-09-07", 2), entry("q", "青岛", "2026-09-12", 4)]);
    assert.equal(bars(html), 2);
    assert.equal(count(html, "is-ongoing"), 1);
    assert.ok(html.includes("广州 · 2天（进行中）"));
    assert.ok(html.includes("青岛 · 4天"));
    assert.equal(count(html, "is-clipped-end"), 1);
    // 2026-09-11 走查：清单列全部行程（含画在周条上的），行的颜色要与胶囊对上。
    assert.ok(html.includes("hud-trips__list--calendar"), "两程都在本周，清单照样列它们");
    assert.equal(count(html, 'class="hud-trips__row'), 2);
    assert.ok(html.includes("--trip-color:var(--hud-trip-c0)") && html.includes("--trip-color:var(--hud-trip-c1)"), "一程一支色，胶囊与行同源");
  });

  it("不在本周的进清单且日期标签带周几；没定日期画成明天起的虚线色块、文案带（待定）", () => {
    const html = render([entry("q", "青岛", "2026-09-27"), entry("u", "徐州", undefined)]);
    assert.equal(bars(html), 1);
    assert.equal(count(html, "is-tentative"), 1);
    assert.ok(html.includes("徐州 · 3天（待定）"));
    assert.ok(html.includes("hud-trips__list--calendar"));
    assert.ok(html.includes('<span class="hud-trips__date">9/27 周日</span>'));
    assert.ok(html.includes('<span class="hud-trips__date">待定</span>'), "画成色块的那程也在清单里，标签仍是「待定」不冒充日期");
    assert.ok(html.includes("19 天后出发"));
  });

  it("没定日期且默认出发日不在所看的一周 → 进清单：标「待定」+「明天出发」", () => {
    // 周日当今天：默认出发日（下周一）不在本周，只能进清单。
    const sunday = "2026-09-13";
    const html = renderToStaticMarkup(
      createElement(TripCalendarCard, { entries: [entry("u", "徐州", undefined)], today: sunday, weatherIcons: ICONS } as never),
    );
    assert.equal(bars(html), 0);
    assert.ok(html.includes('<span class="hud-trips__date">待定</span>'));
    assert.ok(html.includes("3 天 · 明天出发"));
    assert.ok(!html.includes("日期待定"));
  });

  it("变化点在色块上：critical → 脉冲类与「重要变化」文案；选中的色块 is-selected", () => {
    const html = render([entry("q", "青岛", "2026-09-10", 2, critical("q"))], { selectedPlanId: "q" });
    assert.ok(html.includes("hud-week__flag"));
    assert.ok(html.includes("is-critical"));
    assert.ok(html.includes("行程有重要变化，点击查看"));
    assert.ok(html.includes("is-selected"));
  });

  it("周条有 ‹ ›、标题显示周范围、「本周」在本周时只占位不显形", () => {
    const html = render([]);
    assert.ok(html.includes('aria-label="上一周"') && html.includes('aria-label="下一周"'));
    assert.ok(html.includes('<span class="hud-week__range">9/7 – 9/13</span>'));
    /*
     * 「本周」**常驻渲染**（2026-09-11）：以前是换到别的周才出现，工具条随之变宽、
     * 把标题挤成「我的行/程」两行，整个头部跟着跳。现在它一直占着位置，
     * 在本周时靠 is-hidden 隐形（visibility:hidden）、对读屏与 Tab 键也不可达。
     */
    const today = html.match(/<button[^>]*class="hud-week__today[^"]*"[^>]*>/);
    assert.ok(today, "「本周」按钮必须常驻渲染，占住位置");
    assert.ok(today[0].includes("is-hidden"), "本周时它应带 is-hidden");
    assert.ok(today[0].includes('aria-hidden="true"'), "隐形时对读屏也要藏起来");
    assert.ok(today[0].includes('tabindex="-1"'), "隐形时不能被 Tab 到");
  });

  // 每页 3 行、页脚只有「1 / 3」不带圆点，是 2026-09-11 用户走查定的。
  it("清单分页：7 程都不在本周 → 3 行 + 页脚「1 / 3」、没有圆点；2 程 → 无页脚", () => {
    const seven = Array.from({ length: 7 }, (_, i) => entry(`p${i}`, `目的地${i}`, "2026-10-0" + (1 + i)));
    const html = render(seven);
    assert.equal(count(html, 'class="hud-trips__row'), 3);
    assert.ok(html.includes("hud-trips__pager"));
    assert.ok(html.includes("<b>1</b> / 3"));
    assert.equal(count(html, 'class="hud-tips__dot'), 0, "页脚的圆点已去掉");
    assert.ok(html.includes('aria-label="上一页" disabled'), "第 1 页上一页禁用");
    const two = render([entry("a", "A", "2026-10-01"), entry("b", "B", "2026-10-02")]);
    assert.ok(!two.includes("hud-trips__pager"));
  });

  it("4 程重叠 → 周条只画 3 道；清单列全部 4 程，第 1 页 3 行", () => {
    const html = render([entry("a", "A", "2026-09-08", 1), entry("b", "B", "2026-09-08", 1), entry("c", "C", "2026-09-08", 1), entry("d", "D", "2026-09-08", 1)]);
    assert.equal(bars(html), 3);
    assert.equal(count(html, 'class="hud-trips__row'), 3);
    assert.ok(html.includes("<b>1</b> / 2"));
  });
});

describe("紧凑形态（M75-01，手机竖屏）", () => {
  const seven = Array.from({ length: 7 }, (_, i) => entry(`p${i}`, `目的地${i}`, "2026-10-0" + (1 + i)));
  it("compact → 带 hud-trips--compact、有周条、无清单无页脚；onOpenList → 「全部 7 程 ›」", () => {
    const html = render(seven, { compact: true, onOpenList: () => {} });
    assert.ok(html.includes("hud-trips--compact"));
    assert.equal(count(html, 'role="columnheader"'), 7);
    assert.ok(!html.includes("hud-trips__list--calendar"));
    assert.ok(!html.includes("hud-trips__pager"));
    assert.ok(html.includes("全部 7 程"));
    assert.ok(html.includes('aria-label="查看全部 7 程"'));
  });

  it("不给 onOpenList 不渲染那颗按钮；非 compact 一字不变（清单 + 页脚都在）", () => {
    const html = render(seven, { compact: true });
    assert.ok(!html.includes("hud-week__all"));
    const full = render(seven);
    assert.ok(!full.includes("hud-trips--compact"));
    assert.ok(full.includes("hud-trips__list--calendar") && full.includes("hud-trips__pager"));
  });
});

/*
 * 头部换周不抖，靠的是周范围槽按**最宽的标签**定宽。2026-09-11 用户翻到 12 月：
 * 「12/21 – 12/27」比「9/7 – 9/13」宽出 20u，槽只留了 106u，工具条被撑宽、标题连同日历图标
 * 一起挤出头部左缘。最宽标签实测 125.7u（2048×1152，等宽数字），槽必须 ≥ 126u。
 * 读 CSS 不渲染：这里量不到盒子，只守那个数别被人"看着太宽"改小。
 */
describe("周范围槽按最宽标签定宽", () => {
  it(".hud-week__range 的 min-width ≥ 126u（「12/21 – 12/27」实测 125.7u）", () => {
    const css = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      (m) => m[1].trim().split("\n").pop()!.trim() === ".hud-week__range",
    );
    const widths = rules
      .map((m) => m[2].match(/min-width:\s*calc\(\s*(\d+(?:\.\d+)?)\s*\*\s*var\(--hud-unit\)/))
      .filter(Boolean)
      .map((m) => Number(m![1]));
    assert.ok(widths.length > 0, "车机横屏块里 .hud-week__range 要有按 --hud-unit 写的 min-width");
    assert.ok(Math.max(...widths) >= 126, `槽宽 ${Math.max(...widths)}u < 126u：12 月的周范围会把工具条撑宽、挤走标题`);
  });
});
