/**
 * [F-18-15][AC-18-11] 行程详情抽屉的编辑态（M83-04）。
 *
 * 三条最容易在实现中走样的：出发行与酒店行不该有控件（住宿是锚点不是 POI）、
 * 删除图标不许用红（红只给「拥堵」与「读不到」）、预览必须走契约的
 * `applyStructureEdits` 而不是组件自己改 `plan`（屏上与发给暖暖的必须同源）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { TripPlanListEntry, TripPlanSnapshot, TripStructureEdit } from "@carlife/shared";

import { TripDetailDrawer } from "../src/hud/TripDetailDrawer";

const spot = (name: string, s?: string, e?: string) => ({ name, ...(s ? { estStart: s } : {}), ...(e ? { estEnd: e } : {}) });

const plan = (): TripPlanSnapshot => ({
  status: "confirmed",
  destination: "徐州",
  origin: "杭州",
  startDate: "2026-09-09",
  days: 3,
  skeleton: [
    { day: 1, theme: "一", spots: [spot("甲景区", "09:00", "11:00"), spot("乙博物馆", "12:00", "13:00"), spot("丙纪念塔", "14:00", "17:00")], hotel: { name: "酒店甲" } },
    { day: 2, theme: "二", spots: [spot("丁山")], hotel: { name: "酒店甲" } },
    { day: 3, theme: "三", spots: [spot("戊街")] },
  ],
  caveats: [],
  updatedTurnId: "t",
});

const entry = (p: TripPlanSnapshot): TripPlanListEntry => ({
  planId: "p1",
  plan: p,
  committedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const render = (extra: Record<string, unknown> = {}, p = plan()) =>
  renderToStaticMarkup(
    createElement(TripDetailDrawer, {
      plan: p,
      entry: entry(p),
      selectedDay: 1,
      onSelectDay: () => {},
      onClose: () => {},
      ...extra,
    } as never),
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("行程详情抽屉 · 编辑态", () => {
  it("展示态：有「调整行程」，没有两个出口，景点行没有控件", () => {
    const html = render();
    assert.ok(html.includes("调整行程"));
    assert.ok(!html.includes("取消调整"));
    assert.ok(!html.includes("保存调整"));
    assert.equal(count(html, "hud-tripdetail__ctrls"), 0);
  });

  it("编辑态：「调整行程」消失，出现取消 / 保存两个出口", () => {
    const html = render({ editing: true });
    assert.ok(!html.includes("调整行程"));
    assert.ok(html.includes("取消调整"));
    assert.ok(html.includes("保存调整"));
  });

  it("每个景点行 4 个控件：天数下拉 + ▲ + ▼ + 删除", () => {
    const html = render({ editing: true });
    assert.equal(count(html, "hud-tripdetail__ctrls"), 3, "当天 3 个景点");
    assert.equal(count(html, "hud-tripdetail__daypick"), 3);
    assert.equal(count(html, 'class="hud-tripdetail__ctrl"'), 9, "每行 ▲▼删 三个");
  });

  it("出发行与酒店行没有任何控件——住宿是锚点不是 POI", () => {
    const html = render({ editing: true });
    const origin = html.slice(html.indexOf("hud-tripdetail__row--origin"), html.indexOf("hud-tripdetail__row--spot"));
    assert.ok(!origin.includes("hud-tripdetail__ctrls"));
    const hotel = html.slice(html.lastIndexOf("hud-tripdetail__row--hotel"));
    assert.ok(!hotel.includes("hud-tripdetail__ctrls"));
    assert.ok(html.includes("is-locked"), "两行整体降一档");
  });

  it("首行 ▲ 与末行 ▼ 禁用", () => {
    const html = render({ editing: true });
    assert.ok(html.includes('aria-label="把「甲景区」往前挪" disabled'), "首个景点不能再往前");
    assert.ok(html.includes('aria-label="把「丙纪念塔」往后挪" disabled'), "末个景点不能再往后");
  });

  it("编辑态不显示时间——那些时间正要被暖暖重排，摆着是误导", () => {
    const view = render();
    const edit = render({ editing: true });
    assert.ok(view.includes("09:00 – 11:00"));
    assert.ok(!edit.includes("09:00 – 11:00"));
    assert.ok(!edit.includes("建议停留"));
  });

  it("变更集为空时「保存调整」禁用（空集发出去等于让暖暖白跑一轮）", () => {
    const html = render({ editing: true, edits: [] });
    const save = html.slice(html.indexOf("hud-tripdetail__btn--cta"));
    assert.ok(save.includes("disabled"));
  });

  it("有变更时「保存调整」可点，并出现「已改 n 处」", () => {
    const edits: TripStructureEdit[] = [
      { kind: "remove", day: 1, spot: "乙博物馆" },
      { kind: "move", day: 1, spot: "丙纪念塔", toDay: 2 },
    ];
    const html = render({ editing: true, edits });
    assert.ok(html.includes("已改 2 处"));
    assert.ok(html.includes("保存后由暖暖重排时间"));
  });

  it("软删的行划线并给「撤销」", () => {
    const html = render({ editing: true, edits: [{ kind: "remove", day: 1, spot: "乙博物馆" }] });
    assert.ok(html.includes("is-removed"));
    assert.ok(html.includes("撤销"));
    assert.ok(html.includes("乙博物馆"), "软删的行仍然渲染，否则撤销无处可点");
  });

  it("换天的站从当前天的时间轴上消失，同一天的另外两站还在", () => {
    const html = render({ editing: true, edits: [{ kind: "move", day: 1, spot: "丙纪念塔", toDay: 2 }] });
    assert.ok(!html.includes("丙纪念塔"));
    // "另外两站还在"是必须的第二条：只验消失的话，整天被清空也照样绿
    assert.ok(html.includes("乙博物馆"));
    // 景点数不再验——走查第七轮把它从日卡上去掉了（时间轴逐行数得出来）
  });

  it("改过的那天带标记，切走也看得出", () => {
    const html = render({ editing: true, edits: [{ kind: "remove", day: 1, spot: "乙博物馆" }] });
    assert.ok(html.includes("is-touched"));
    assert.ok(html.includes("这一天有调整"));
  });

  it("保存中：两个出口都禁用，文案变「正在发送…」", () => {
    const html = render({ editing: true, saving: true, edits: [{ kind: "remove", day: 1, spot: "乙博物馆" }] });
    assert.ok(html.includes("正在发送…"));
    assert.equal(count(html, "disabled"), count(html, "disabled"));
    const cancel = html.slice(html.indexOf("取消调整") - 200, html.indexOf("取消调整"));
    assert.ok(cancel.includes("disabled"));
  });

  it("发不出去时写出原因且保存禁用", () => {
    const html = render({ editing: true, edits: [{ kind: "remove", day: 1, spot: "乙博物馆" }], saveDisabledReason: "浏览器走查不发送" });
    assert.ok(html.includes("浏览器走查不发送"));
    const save = html.slice(html.indexOf("hud-tripdetail__btn--cta"));
    assert.ok(save.includes("disabled"));
  });

  it("未保存确认：两个键都是次级，没有主行动——放弃不是我们要推荐的动作", () => {
    const html = render({ editing: true, confirmDiscard: true, edits: [{ kind: "remove", day: 1, spot: "乙博物馆" }] });
    assert.ok(html.includes("有未保存的调整，放弃？"));
    assert.ok(html.includes("继续调整") && html.includes("放弃"));
    const confirm = html.slice(html.indexOf("hud-tripdetail__confirm"));
    assert.ok(!confirm.includes("btn--cta"), "确认层里不放橙渐变");
  });

  it("预览走契约的 applyStructureEdits，组件不自己改 plan", () => {
    const src = readFileSync(new URL("../src/hud/TripDetailDrawer.tsx", import.meta.url), "utf8");
    assert.ok(src.includes("applyStructureEdits(plan, edits)"));
    assert.ok(!src.includes(".splice("), "组件里不许直接改数组——两套应用逻辑迟早对不上");
    assert.ok(!src.includes("spots.filter("));
  });

  it("删除图标不用红（红只给拥堵与读不到）", () => {
    const css = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");
    const at = css.indexOf(".hud-tripdetail__ctrl {");
    const block = css.slice(at, css.indexOf("}", at));
    assert.ok(block.includes("var(--hud-text-muted)"));
    assert.ok(!block.includes("--hud-danger"));
  });
});
