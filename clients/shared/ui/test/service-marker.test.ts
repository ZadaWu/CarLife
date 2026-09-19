/**
 * [F-18-15][AC-18-11] 沿途服务点的地图标记（M93-05）。
 *
 * 图标一套两处用：抽屉里的格子与图上的点是**同一个开关的两端**，
 * 长得不像就等于开关没接上。所以两边都读 `SERVICE_ICON_PATHS`，这里守住它。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import {
  SERVICE_ICON_PATHS,
  SERVICE_MARKER_CLASS,
  SERVICE_NAME_ZOOM,
  serviceMarkerHtml,
} from "../src/map/service-marker";
import { SERVICE_CATEGORY_KEYS } from "../src/hud/trip-detail";

const poi = (name: string) => ({ name, lat: 34.24, lon: 117.16 });

describe("[F-18-15][AC-18-11] serviceMarkerHtml", () => {
  it("四类各产出带自己类名与 path 的标记", () => {
    for (const key of SERVICE_CATEGORY_KEYS) {
      const html = serviceMarkerHtml(poi("某某站"), key);
      assert.ok(html.includes(`${SERVICE_MARKER_CLASS}--${key}`), html);
      assert.ok(html.includes(`data-svc="${key}"`), html);
      assert.ok(html.includes(SERVICE_ICON_PATHS[key]), `${key} 的 path 必须来自同一份常量`);
    }
  });

  it("图标常量与格子的四个键一一对应，不多不少", () => {
    assert.deepEqual(Object.keys(SERVICE_ICON_PATHS).sort(), [...SERVICE_CATEGORY_KEYS].sort());
  });

  it("名字经 escapeHtml——POI 名字来自高德，不是我们写的字符串", () => {
    const html = serviceMarkerHtml(poi(`国网"充电"站 <b>&</b>`), "charge");
    // `escapeHtml` 发数字实体（`&#60;` 这一类），不是 `&lt;`。
    assert.ok(!html.includes("<b>"), html);
    assert.ok(html.includes("&#60;b&#62;") && html.includes("&#38;"), html);
    assert.ok(html.includes("&#34;"), "属性里的引号必须转义，否则标记结构被撑破");
  });

  it("名字进 title / aria-label，另带一个默认藏着的标签——不做成气泡", () => {
    /*
     * 走查第四轮之前这里断言的是"名字根本不作为可见文本出现"。
     * 那一版的代价是：推近到街道级也不知道是哪家（走查原话）。
     * 现在名字**随标记一起建**、默认 display:none，由地图缩放过门槛时放出来——
     * 仍然不是气泡：不可点、不拦手势、没有详情，这一层回答的还是"这附近有没有"。
     */
    const html = serviceMarkerHtml(poi("云龙湖食堂"), "food");
    assert.ok(html.includes('title="云龙湖食堂"') && html.includes('aria-label="云龙湖食堂"'));
    assert.ok(html.includes(`class="${SERVICE_MARKER_CLASS}__name" aria-hidden="true">云龙湖食堂`));
    // 仍然不是气泡：没有点击、没有箭头、没有第二行说明
    assert.ok(!html.includes("onclick") && !html.includes("popup"), html);
  });
});

/**
 * [F-18-15][AC-18-11] 名字跟着缩放露出来（2026-09-16 走查第四轮）。
 *
 * 走查原话：「沿途服务选中显示在地图上后，当地图放大后没有展示出信息，
 * 不知道店名或者地点名称」。名字一直显示不行——一天四类最多 80 个点，
 * 全程视野下是一片糊字；推近到看得清街道时屏幕上通常只剩几个点，那时名字才有用。
 */
describe("服务点的名字标签", () => {
  const LAYER = readFileSync(new URL("../src/map/AmapTripLayer.tsx", import.meta.url), "utf8");
  const CSS = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");

  it("标签随标记一起建，名字照样过转义", () => {
    const html = serviceMarkerHtml({ name: '海底捞<b>"火锅"</b>', lat: 1, lon: 2 }, "food");
    assert.ok(html.includes(`class="${SERVICE_MARKER_CLASS}__name"`));
    assert.ok(!html.includes("<b>"), "名字里的标签必须被转义");
    assert.ok(html.includes("&#60;b&#62;"));
    // title 与 aria-label 照旧：读屏与鼠标悬停这两条路不依赖缩放
    assert.ok(html.includes('title="海底捞'));
  });

  it("默认藏着，靠容器上那个类放出来——不是另开一层覆盖物", () => {
    assert.match(CSS, /\.hud-tripsvc__name \{\n\s*display: none;/);
    assert.match(CSS, /\.hud-map--svcnames \.hud-tripsvc__name \{ display: block; \}/);
    // 标记本体要当定位参照，名字才挂得住
    assert.match(CSS, /\.hud-tripsvc \{\n(\s*\/\*[^]*?\*\/\n)?\s*position: relative;/);
  });

  it("门槛比按天取景那一档近两级：先看「这一带有什么」，推近才问「具体哪家」", () => {
    assert.equal(SERVICE_NAME_ZOOM, 15);
    assert.match(LAYER, /const DAY_FIT_MAX_ZOOM = 13;/);
  });

  it("**只翻 class，不重建覆盖物**——缩放是会连推好几下的动作", () => {
    const at = LAYER.indexOf("const sync = () => {");
    assert.notEqual(at, -1, "找不到缩放同步那段");
    const body = LAYER.slice(at, LAYER.indexOf("}, [mapEpoch, servicePoisKey]);", at));
    assert.ok(body.includes("classList.toggle(SERVICE_NAME_ON_CLASS"));
    for (const forbidden of ["serviceOverlaysRef", "overlaysRef", "map.add", "planDrivingLegs"]) {
      assert.ok(!body.includes(forbidden), `缩放一变就碰 ${forbidden} = 每推一下重做一遍`);
    }
    /*
     * 依赖里的 servicePoisKey 是走查第五轮（碰撞消隐）加的：换了类目就是另一批点，
     * 得按新的那批重摆一次名字。代价只是重挂两个监听——
     * 而这条断言真正守的那件事（**不碰覆盖物**）逐字没动，见上面的禁用清单。
     */
    assert.match(LAYER.slice(at), /^[\s\S]*?\}, \[mapEpoch, servicePoisKey\]\);/);
  });
});
