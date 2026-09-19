/**
 * [F-18-15][AC-18-11] 行程详情抽屉展示态（M83-03）。
 *
 * 两条容易在"照着参考图做"时溜进来的东西，这里各有一条断言挡着：
 * 参考图那套「方案一 / 二 / 三 + 推荐角标」（我们没有比选），以及 Day 卡上的
 * `36 km` / `21%`（那是整程出发段的数，按天的没有数据源）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { tripServicesKey } from "@carlife/shared";
import type { TripPlanListEntry, TripPlanSnapshot } from "@carlife/shared";

import { TripDetailDrawer, drawerSubtitle } from "../src/hud/TripDetailDrawer";

const spot = (name: string, estStart?: string, estEnd?: string) => ({
  name,
  ...(estStart ? { estStart } : {}),
  ...(estEnd ? { estEnd } : {}),
});

function plan(days = 3, over: Partial<TripPlanSnapshot> = {}): TripPlanSnapshot {
  const skeleton = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    theme: `第 ${i + 1} 天主题`,
    spots: [spot(`D${i + 1}第一站`, "09:00", "11:30"), spot(`D${i + 1}第二站`, "13:00", "16:30")],
    hotel: { name: `D${i + 1}酒店` },
  }));
  return {
    status: "confirmed",
    destination: "徐州",
    origin: "杭州",
    startDate: "2026-09-09",
    days,
    skeleton,
    caveats: [],
    updatedTurnId: "t",
    ...over,
  };
}

/** 带大交通分段的行程：日卡上唯一还画的那一行（行车时长）要有 `legs` 才出现。 */
const planWithLegs = () =>
  plan(3, {
    legs: [
      { day: 1, driveMinutes: 40, reason: "charge" },
      { day: 1, driveMinutes: 60 },
    ],
  } as Partial<TripPlanSnapshot>);

const entryOf = (p: TripPlanSnapshot): TripPlanListEntry => ({
  planId: "p1",
  plan: p,
  committedAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const render = (p: TripPlanSnapshot, day = 1, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(TripDetailDrawer, {
      plan: p,
      entry: entryOf(p),
      selectedDay: day,
      onSelectDay: () => {},
      onClose: () => {},
      ...extra,
    } as never),
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("行程详情抽屉 · 展示态", () => {
  it("三天出三张 Day 卡，第一张选中", () => {
    const html = render(plan(3));
    assert.equal(count(html, 'role="tab"'), 3);
    assert.equal(count(html, "hud-tripdetail__day is-on"), 1);
    assert.ok(html.includes('aria-selected="true"'));
    assert.ok(html.includes("Day 1") && html.includes("Day 3"));
  });

  it("[F-18-15][AC-18-11] 日卡上不出现主题文字（2026-09-16 走查第四轮）", () => {
    /*
     * M93-03 曾把主题 clamp 成两行，因为卡宽约装 13 个字而真跑落库的主题是 27~31 字。
     * 走查第四轮直接否掉了这个位置：「豆腐块里就不需要展示文字，因为下面已经有完整的信息」——
     * 两行 clamp 之后剩下的是一句半截话，而它讲的事下面的时间轴逐行都有、且是全的。
     */
    const theme = "临港亲子日：海昌海洋公园半日＋航海博物馆，晚宿奥特曼主题酒店";
    const p = plan(3);
    p.skeleton[0]!.theme = theme;
    const html = render(p);
    assert.ok(!html.includes(theme), "主题不该出现在日卡里");
    assert.equal(count(html, "hud-tripdetail__daytheme"), 0, "连类名一起去掉，别留空壳");
  });

  it("[F-18-15][AC-18-11] 日卡只留行车时长（2026-09-16 走查第七轮）", () => {
    /*
     * 走查原话：「4 个景点、无补能停靠可以去掉，只保留行车时长」。
     * 判据是"下面的时间轴有没有"：景点数 = 数一下时间轴的景点行；补能停靠同理，
     * 而且它多半是「无补能停靠」——一整行只为了说"没有这回事"。
     * 行车时长留着，是因为它只在这里有：时间轴给的是各段钟点，一天开多久得自己去加。
     */
    const html = render(plan(3));
    assert.ok(!html.includes("个景点"), "景点数下面的时间轴逐行都有");
    assert.ok(!html.includes("补能停靠") && !html.includes("个充电站"));
    // 这份夹具没有 legs，所以整行不画（没有"0 分钟"这个选项）——真有 legs 时才出现
    assert.ok(!html.includes("行车约"));
    const withDrive = render(planWithLegs());
    assert.ok(withDrive.includes("行车约"), "有 legs 就该给出这一天开多久");
    assert.ok(!withDrive.includes("个景点") && !withDrive.includes("补能停靠"));
  });

  it("五天出五张卡，容器带横向滚动的类（不折行、不分页）", () => {
    const html = render(plan(5));
    assert.equal(count(html, 'role="tab"'), 5);
    assert.ok(html.includes("hud-tripdetail__days"));
    assert.ok(html.includes("Day 5"));
  });

  it("Day 卡上没有公里数与电量百分比——按天的那两个数契约里没有", () => {
    const html = render(plan(3));
    assert.ok(!html.includes("km"), "整程出发段的里程在屏底状态栏，不在这里");
    assert.ok(!html.includes("%"));
  });

  it("没有「推荐」角标、没有「更多」——我们不是路线比选", () => {
    const html = render(plan(3));
    assert.ok(!html.includes("推荐"));
    assert.ok(!html.includes("更多"));
    assert.ok(!html.includes("方案一"));
  });

  it("切到第 2 天：时间轴只画那一天", () => {
    const html = render(plan(3), 2);
    assert.ok(html.includes("D2第一站"));
    assert.ok(!html.includes("D1第一站"), "第 1 天的站不该出现在第 2 天的时间轴上");
  });

  it("[M93-05] 沿途服务四格、没有「景区」，没数据源时四格全「待查」", () => {
    const html = render(plan(3));
    assert.equal(count(html, 'class="hud-tripdetail__cell"'), 4);
    // 只数**格子里**的：下面那行出处说明本身也含「待查」二字。
    assert.equal(count(html, 'cellvalue">待查'), 4, "四格同源，充电站也不例外");
    assert.ok(!html.includes(">景区<"), "「景区」那一格数的是本行程自己的站，与周边查到什么不是一件事");
    assert.ok(!html.includes("无需补能"), "那句话属于旧口径：格子说的是周边有多少桩");
  });

  it("[M93-05] 快照带 services 时四格写数字（0 照写）、列出高速服务区、出处说明切换", () => {
    const base = plan(3);
    const p = plan(3, {
      services: {
        computedAt: "2026-09-15T08:00:00.000Z",
        radiusM: 3000,
        skeletonKey: tripServicesKey(base),
        days: [
          { day: 1, charging: 4, food: 12, restroom: 0, parking: 7, serviceAreas: ["长安服务区"] },
        ],
      },
    });
    const html = render(p);
    assert.equal(count(html, 'cellvalue">待查'), 0);
    assert.ok(html.includes('cellvalue">12 个'));
    assert.ok(html.includes('cellvalue">4 个'), "充电站与其余三格同源同口径");
    assert.ok(html.includes('cellvalue">0 个'), "0 是查过了没有");
    assert.ok(html.includes("高速服务区") && html.includes("长安服务区"));
    // 出处与口径从屏幕上挪进了格子的 title（走查第四轮：那段说明删掉）
    assert.ok(!html.includes("<p class=\"hud-tripdetail__note--source\""), "说明行不该再有");
    // 这份夹具只有计数、没有 pois 明细（M93-04 之前的老快照形状）→ 四格置灰，
    // title 先回答"为什么点不动"；口径那一份 title 由下面「图层开关」那组验。
    assert.ok(html.includes('title="这一天没有存下点位，没法在地图上显示"'));
    // 第 2 天没算过：四格回到待查
    assert.equal(count(render(p, 2), 'cellvalue">待查'), 4);
  });

  it("时间轴首行出发、末行入住", () => {
    const html = render(plan(3));
    assert.ok(html.includes("杭州"));
    assert.ok(html.includes("入住"));
    assert.ok(html.includes("D1酒店"));
  });

  it("「调整行程」按钮在；canEdit=false 时禁用并写出原因", () => {
    assert.ok(render(plan(3)).includes("调整行程"));
    const html = render(plan(3), 1, { canEdit: false });
    assert.ok(html.includes("disabled"));
    assert.ok(html.includes("行驶中不能调整"), "拦住用户却不说为什么，是缺陷");
  });

  it("副标题：有日期给区间，没日期写「日期待定」", () => {
    assert.equal(drawerSubtitle(entryOf(plan(3))), "徐州 · 3 天 · 9/9 → 9/11");
    assert.equal(drawerSubtitle(entryOf(plan(3, { startDate: undefined }))), "徐州 · 3 天 · 日期待定");
  });
});

/**
 * [F-18-15][AC-18-11] 格子是图层开关（M93-05）。
 *
 * 用户走查："充电站|餐饮|卫生间|停车场 点击选中某个，就在地图上显示出地点，可多选、可切换。"
 * 所以这一排不再是标签而是 `role="switch"`：有明确的开/关两态，屏读器念得出"已选中"。
 *
 * 点击本身在这里断言不到（`renderToStaticMarkup` 不派发事件），守住它的是 `disabled`——
 * **没有点位明细的格子根本点不动**，而不是点了没反应。
 */
describe("[F-18-15][AC-18-11] 沿途服务格子 · 图层开关", () => {
  const poi = (name: string, lat: number, lon: number) => ({ name, lat, lon });
  /** 第 1 天：餐饮有明细，停车场只有计数没明细（M93-04 之前落的老快照就是这形状）。 */
  const withPois = () => {
    const base = plan(3);
    return plan(3, {
      services: {
        computedAt: "2026-09-15T08:00:00.000Z",
        radiusM: 3000,
        skeletonKey: tripServicesKey(base),
        days: [
          {
            day: 1,
            food: 2,
            parking: 7,
            pois: { food: [poi("云龙湖食堂", 34.24, 117.16), poi("彭城饭庄", 34.25, 117.17)] },
          },
        ],
      },
    });
  };

  it("四格都是 role=switch，未选中时 aria-checked=false", () => {
    const html = render(withPois());
    assert.equal(count(html, 'role="switch"'), 4);
    assert.equal(count(html, 'aria-checked="true"'), 0);
  });

  it("选中集合里的那一类 aria-checked=true 并带 is-on；其余仍是 false", () => {
    const html = render(withPois(), 1, { selectedServices: ["food"] });
    assert.equal(count(html, 'aria-checked="true"'), 1);
    assert.equal(count(html, "hud-tripdetail__cell is-on"), 1);
    // 选中的那一格必须是餐饮：`is-on` 与 `餐饮` 在同一个按钮里。
    const on = html.slice(html.indexOf("hud-tripdetail__cell is-on"));
    assert.ok(on.slice(0, 400).includes("餐饮"), on.slice(0, 400));
  });

  it("没有点位明细的格子点不动：aria-disabled + disabled + 说清为什么", () => {
    const html = render(withPois());
    // 有明细的只有餐饮一格，其余三格（含只有计数的停车场）都点不动。
    assert.equal(count(html, 'aria-disabled="true"'), 3);
    assert.equal(count(html, "disabled=\"\""), 3);
    assert.ok(html.includes("这一天没有存下点位，没法在地图上显示"), "置灰却不说为什么，是缺陷");
  });

  it("选过但这一天没点位 → 格子不亮：亮着就是在说「图上有」", () => {
    // 选中集合跨天保留（切回有点位那天照旧画），但那一天画不出来时不许亮着。
    const html = render(withPois(), 2, { selectedServices: ["food"] });
    assert.equal(count(html, 'aria-checked="true"'), 0);
    assert.equal(count(html, "hud-tripdetail__cell is-on"), 0);
  });

  it("屏幕上不再有那段出处说明，口径改挂在每一格的 title 上", () => {
    /*
     * 走查第四轮：「这句话删除」。它占三行、把时间轴挤到要滚两屏，
     * 而它回答的是一个只需要问一次的问题。信息不能跟着一起删——
     * 一排「待查」不解释就是看起来坏了（M83 走查的原话），所以挪进 title。
     */
    const html = render(withPois(), 1, { selectedServices: ["food"] });
    assert.ok(!html.includes("hud-tripdetail__note--source"), "说明行整段去掉");
    assert.ok(!html.includes("图上画了"), "「图上画了最近的 N 个」随那段一起去掉");
    assert.match(html, /title="[^"]*点一下可以把这一类的点位显示在地图上/);
  });
});
