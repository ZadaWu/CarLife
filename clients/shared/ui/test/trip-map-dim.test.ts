/**
 * [F-18-15][AC-18-11] 地图按天淡出（M83 走查追修）。
 *
 * 抽屉里选了某一天，别的天的站点与路线退成灰色半透明——**不是隐藏**：
 * 整程的形状要还在，否则"这一程有几天、别的天在哪"就没了。
 *
 * 这里只验得了纯函数与 CSS：AMap 要浏览器。淡出的接线（只翻 class 不重建覆盖物）
 * 由 `hud-detail-drawer.test.ts` 的源码断言守。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { TRIP_MARKER_DIM_CLASS, markerDays, tripMarkerHtml } from "../src/map/trip-marker";

const CSS = readFileSync(new URL("../src/map/map.css", import.meta.url), "utf8");
const LAYER = readFileSync(new URL("../src/map/AmapTripLayer.tsx", import.meta.url), "utf8");

describe("地图按天淡出", () => {
  it("胶囊带 data-days：连住酒店跨几天就写几天", () => {
    assert.deepEqual(markerDays({ name: "H", day: 1, kind: "hotel", days: [1, 2] }), [1, 2]);
    assert.deepEqual(markerDays({ name: "A", day: 3, kind: "spot" }), [3]);
    const html = tripMarkerHtml({ name: "H", day: 1, kind: "hotel", days: [1, 2] }, { seq: null, showDayBadge: true });
    assert.ok(html.includes('data-days="1,2"'));
  });

  it("dim 初值写进 HTML（首帧不闪），缺省不带这个类", () => {
    const on = tripMarkerHtml({ name: "A", day: 2, kind: "spot" }, { seq: 1, showDayBadge: true, dim: true });
    const off = tripMarkerHtml({ name: "A", day: 2, kind: "spot" }, { seq: 1, showDayBadge: true });
    assert.ok(on.includes(TRIP_MARKER_DIM_CLASS));
    assert.ok(!off.includes(TRIP_MARKER_DIM_CLASS));
  });

  it("淡出是灰度 + 半透明两样一起——只降不透明度的话琥珀徽标仍然跳眼", () => {
    const at = CSS.indexOf(".hud-tripmark--dim");
    assert.notEqual(at, -1);
    const block = CSS.slice(at, CSS.indexOf("}", at));
    assert.match(block, /opacity:\s*0?\.\d+/);
    assert.match(block, /filter:\s*grayscale\(1\)/);
  });

  it("圆点一起淡：只淡胶囊会剩下一串没有胶囊的点", () => {
    assert.ok(CSS.includes(".hud-tripmark__dot--dim"));
    assert.ok(LAYER.includes('classList.toggle("hud-tripmark__dot--dim"'));
  });

  it("**切天只翻 class 与折线不透明度，不重建覆盖物**——重建等于把路径规划与取景全部重做", () => {
    // 淡出 effect 的依赖里有 focusDay；而重建那一路的依赖数组里**不能**有它。
    assert.match(LAYER, /\}, \[focusDay, mapEpoch, stopsKey\]\);/);
    const rebuildDeps = /\}, \[\s*stopsKey,[\s\S]*?\]\);/.exec(LAYER)?.[0] ?? "";
    assert.ok(rebuildDeps.length > 0, "找不到重建 effect 的依赖数组");
    assert.ok(!rebuildDeps.includes("focusDay"), "focusDay 进了重建依赖 = 每切一天重做一次路径规划");
  });

  it("非选中天的折线淡到 0.25：再低在灰白底图上就等于消失，而消失是另一个意思", () => {
    assert.match(LAYER, /const ROUTE_DIM_FACTOR = 0\.25;/);
    assert.match(LAYER, /layer\.opacity \* \(dim \? ROUTE_DIM_FACTOR : 1\)/);
  });
});

/**
 * [F-18-15][AC-18-11] 标记出生就带对淡出态（M83 走查追修）。
 *
 * 实测：抽屉打开时选的是 Day 1，而标记要**晚 4 秒**才上图；那时淡出 effect 的依赖
 * （focusDay / mapEpoch / stopsKey）一个都没变，它补不上——于是打开抽屉的第一眼，
 * 别的天一个都没淡。所以建标记那一路也要用同一份判断。
 */
describe("标记出生就带对淡出态", () => {
  it("胶囊与圆点建的时候都过 isDimmed", () => {
    assert.match(LAYER, /guidedRef\.current\.has\(s\.name\),\s*\n\s*isDimmed\(s\.days\?\.length \? s\.days : \[s\.day\]\),/);
    assert.match(LAYER, /isDimmed\(s\.days\?\.length \? s\.days : \[s\.day\]\) \? " hud-tripmark__dot--dim" : ""/);
  });

  it("折线建的时候也按天定基准，不是建完再调", () => {
    assert.match(LAYER, /makeRouteLines\(seg, 0, daySegDays\[i\]\)/);
  });

  it("焦点天走 ref——它一旦进重建依赖，切一天就重做一次路径规划", () => {
    assert.match(LAYER, /const focusDayRef = useRef<number \| undefined>\(undefined\);/);
    assert.match(LAYER, /focusDayRef\.current = focusDay;/);
  });
});

/**
 * [F-18-15][AC-18-11] 异步补时刻不许把淡出类冲掉（M83 走查追修）。
 *
 * 路径规划回来后会 `setContent` 把整段胶囊 HTML 换掉。那一路不带 `dim` 的话，
 * 现象是「打开抽屉时别的天没淡，过几秒才淡」——而补时刻是异步的，看起来就是随机。
 */
describe("补时刻重发 content 时保住淡出态", () => {
  it("setContent 那一路也过 isDimmed", () => {
    const at = LAYER.indexOf("const setContent");
    assert.notEqual(at, -1);
    const block = LAYER.slice(at, at + 1400);
    assert.match(block, /isDimmed\(stop\.days\?\.length \? stop\.days : \[stop\.day\]\)/);
  });
});
