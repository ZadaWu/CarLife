/**
 * [F-18-15][AC-18-11] 顶部日期条（M73-01）：文案逐字、× 有可读名字、没定日期按默认明天出发 + 「待定」标。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { TripPlanListEntry } from "@carlife/shared";

import { TripDateBanner, shortDateLabel } from "../src/hud/TripDateBanner";

function entry(startDate: string | undefined, days = 3): TripPlanListEntry {
  return {
    planId: "p",
    plan: { status: "confirmed", destination: "青岛", startDate, days, skeleton: [], caveats: [], updatedTurnId: "t" },
    committedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}
const render = (e: TripPlanListEntry) => renderToStaticMarkup(createElement(TripDateBanner, { entry: e, today: "2026-09-17", onClose: () => {} }));

describe("顶部日期条", () => {
  it("shortDateLabel：9/19 周六", () => {
    assert.equal(shortDateLabel("2026-09-19"), "9/19 周六");
  });

  it("起止日、周几、目的地、天数、相对时间逐字；× 带 aria-label", () => {
    const html = render(entry("2026-09-19"));
    assert.ok(html.includes("<b>9/19 周六</b>"));
    assert.ok(html.includes("<b>9/21 周一</b>"));
    assert.ok(html.includes("青岛 · 3 天 · 2 天后出发"));
    assert.ok(html.includes('aria-label="取消选中"'));
    assert.ok(html.includes("hud-card hud-datebar"));
  });

  it("没定日期：按明天起画起止日 + 「待定」标 + 「明天出发」", () => {
    const html = render(entry(undefined, 2));
    assert.ok(html.includes("<b>9/18 周五</b>"));
    assert.ok(html.includes("<b>9/19 周六</b>"));
    assert.ok(html.includes("hud-datebar__tentative"));
    assert.ok(html.includes(">待定</span>"));
    assert.ok(html.includes("青岛 · 2 天 · 明天出发"));
    assert.ok(!html.includes("日期待定"));
    assert.ok(!render(entry("2026-09-19")).includes("hud-datebar__tentative"), "定了日期没有待定标");
  });

  it("进行中：第 N 天", () => {
    const html = render(entry("2026-09-16"));
    assert.ok(html.includes("进行中 · 第 2 天"));
  });
});

/**
 * [F-18-15][AC-18-11] 工具按钮与下拉菜单（M83-02）。
 *
 * 两条判据值得单独守：**缺省不渲染**（手机端也用这个组件，CSS 藏起来的按钮仍然点得到），
 * 以及**展开时必须有遮罩**（没有它，菜单在 HUD 上收不起来——HUD 没有"外面"）。
 */
const renderTools = (e: TripPlanListEntry, menuOpen: boolean, showTools = true) =>
  renderToStaticMarkup(
    createElement(TripDateBanner, {
      entry: e,
      today: "2026-09-17",
      onClose: () => {},
      showTools,
      menuOpen,
      onToggleMenu: () => {},
      onOpenDetail: () => {},
    }),
  );

describe("顶部日期条的工具菜单", () => {
  it("缺省不渲染工具按钮：手机端不传 showTools，DOM 里就不该有它", () => {
    const html = render(entry("2026-09-19"));
    assert.ok(!html.includes("hud-datebar__tools"));
    assert.ok(!html.includes("hud-datebar__menu"));
  });

  it("showTools 且未展开：有按钮、aria-expanded=false、没有菜单也没有遮罩", () => {
    const html = renderTools(entry("2026-09-19"), false);
    assert.ok(html.includes("hud-datebar__tools"));
    assert.ok(html.includes('aria-expanded="false"'));
    assert.ok(html.includes('aria-haspopup="menu"'));
    assert.ok(!html.includes("hud-datebar__menu"));
    assert.ok(!html.includes("hud-datebar__scrim"));
    assert.ok(!html.includes("is-menu-open"));
  });

  it("展开：菜单只有「行程详情」一项，遮罩在场，整条带 is-menu-open", () => {
    const html = renderTools(entry("2026-09-19"), true);
    assert.ok(html.includes('role="menu"'));
    assert.equal(html.split('role="menuitem"').length - 1, 1, "v1 只有一项");
    assert.ok(html.includes("行程详情"));
    assert.ok(html.includes("hud-datebar__scrim"), "没有遮罩菜单就收不起来");
    assert.ok(html.includes('aria-expanded="true"'));
    assert.ok(html.includes("hud-datebar__tools is-open"));
    assert.ok(html.includes("hud-card hud-datebar is-menu-open"));
  });

  it("菜单展开不动既有内容：日期、目的地、× 一字不变", () => {
    const html = renderTools(entry("2026-09-19"), true);
    assert.ok(html.includes("<b>9/19 周六</b>"));
    assert.ok(html.includes("青岛 · 3 天 · 2 天后出发"));
    assert.ok(html.includes('aria-label="取消选中"'));
  });

  it("showTools=false 时即使 menuOpen 也不展开（两道兜底里的组件那道）", () => {
    const html = renderTools(entry("2026-09-19"), true, false);
    assert.ok(!html.includes("hud-datebar__menu"));
    assert.ok(!html.includes("hud-datebar__scrim"));
  });
});
