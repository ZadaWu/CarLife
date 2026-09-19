/**
 * [F-18-15][AC-18-11] 行程详情抽屉的接线（施工单 M83-03）。
 *
 * 三件在浏览器里才看得见、而看见时已经晚了的事，在源码上判：
 * 抽屉是不是只写一处用两处；轮播有没有在抽屉开着时暂停；提示卡窗的几何有没有被动。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/hud/HudScreen.tsx", import.meta.url), "utf8");
const APP = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../../shared/ui/src/hud/hud.css", import.meta.url), "utf8");
const count = (src: string, needle: string) => src.split(needle).length - 1;

describe("行程详情抽屉的接线", () => {
  it("抽屉只写一处、两个布局分支各挂一次", () => {
    assert.equal(count(SRC, "<TripDetailDrawer"), 1, "与 windowCard / tripsCard 同一条纪律");
    assert.equal(count(SRC, "{detailDrawer}"), 2);
  });

  it("画的是选中那一程的快照，不是 App 的当前行程", () => {
    assert.match(SRC, /plan=\{selectedTrip\.plan\}/);
  });

  it("抽屉开着时轮播暂停（暂停不是隐藏：关掉要原样接着翻）", () => {
    assert.match(APP, /useCarousel\(view\.tips\.pages\.length,\s*\{\s*paused:\s*detailOpen\s*\}\)/);
  });

  it("打开时默认看当前导航天，没在跟车就第 1 天", () => {
    const body = /onOpenDetail = useCallback\(\(\) => \{([\s\S]*?)\}, \[navDay\]\);/.exec(APP)?.[1];
    assert.ok(body, "找不到 onOpenDetail");
    assert.match(body, /setDetailDay\(navDay \?\? 1\)/);
    assert.match(body, /setDetailOpen\(true\)/);
  });

  it("行驶中可看不可改：canEditDetail 由 navDay 推出，与 TripReviewSheet 同口径", () => {
    assert.match(APP, /canEditDetail: navDay === undefined/);
    assert.match(APP, /canAdjust=\{isTauriEnv\(\) && navDay === undefined\}/, "既有口径没被改动");
  });

  it("换一程 / 取消选中都关抽屉", () => {
    const onSelect = /onSelectTrip = useCallback\(\s*\(planId: string\) => \{([\s\S]*?)\},\s*\[source\],/.exec(APP)?.[1];
    const onClear = /onClearTripSelection = useCallback\(\(\) => \{([\s\S]*?)\}, \[source\]\);/.exec(APP)?.[1];
    assert.ok(onSelect && onClear);
    assert.match(onSelect, /setDetailOpen\(false\)/);
    assert.match(onClear, /setDetailOpen\(false\)/);
  });

  it("提示卡窗的几何一字未动——抽屉是盖上去的另一层，不是把面板改小", () => {
    // `.hud-tips` 的四个数（right 32 / top 112 / width 462 / height 578）是 HighlightsCard
    // 文件头点名不许动的：外框跳尺寸的代价是地图被遮挡的面积每 6 秒跳一次。
    assert.match(CSS, /\.hud-tips \{[\s\S]*?right: calc\(32 \* var\(--hud-unit\)\)/);
    assert.match(CSS, /\.hud-tips \{[\s\S]*?width: calc\(462 \* var\(--hud-unit\)\)/);
    assert.match(CSS, /\.hud-tips \{[\s\S]*?height: calc\(578 \* var\(--hud-unit\)\)/);
  });

  it("抽屉的 z 落在提示卡之上、跟车顶栏之下", () => {
    const z = Number(/\.hud-viewport \.hud-tripdetail \{[\s\S]*?z-index:\s*(\d+)/.exec(CSS)?.[1]);
    assert.equal(z, 91);
    assert.ok(z > 90 && z < 92, "高于逐日页签 90，低于跟车顶栏 92");
  });
});

/**
 * [F-18-15][AC-18-11] 编辑态的接线（M83-04）。
 */
describe("编辑态的接线", () => {
  it("编辑态与变更集都在 App，不在抽屉里", () => {
    assert.match(APP, /const \[detailEditing, setDetailEditing\] = useState\(false\)/);
    assert.match(APP, /const \[detailEdits, setDetailEdits\] = useState<TripStructureEdit\[\]>\(\[\]\)/);
  });

  it("有未保存变更时关抽屉先弹确认，不静默丢弃", () => {
    const body = /onRequestCloseDetail = useCallback\(\(\) => \{([\s\S]*?)\}, \[/.exec(APP)?.[1];
    assert.ok(body, "找不到 onRequestCloseDetail");
    assert.match(body, /detailEditing && detailEdits\.length > 0/);
    assert.match(body, /setDetailConfirmDiscard\(true\)/);
    assert.match(APP, /onCloseDetail: onRequestCloseDetail/, "抽屉的 × 走的是带确认的那条");
  });

  it("换一程 / 取消选中把编辑态也丢掉——那是对另一程的改动", () => {
    const onSelect = /onSelectTrip = useCallback\(\s*\(planId: string\) => \{([\s\S]*?)\},\s*\[source\],/.exec(APP)?.[1];
    const onClear = /onClearTripSelection = useCallback\(\(\) => \{([\s\S]*?)\}, \[source\]\);/.exec(APP)?.[1];
    assert.ok(onSelect && onClear);
    assert.match(onSelect, /setDetailEdits\(\[\]\)/);
    assert.match(onClear, /setDetailEdits\(\[\]\)/);
  });

  it("编辑态时底栏「开始行程」禁用——一屏只有一个主行动", () => {
    assert.match(SRC, /startDisabled=\{trips\?\.detailEditing === true\}/);
  });

  it("打开抽屉总是从展示态开始", () => {
    const body = /onOpenDetail = useCallback\(\(\) => \{([\s\S]*?)\}, \[navDay\]\);/.exec(APP)?.[1];
    assert.ok(body);
    assert.match(body, /setDetailEditing\(false\)/);
    assert.match(body, /setDetailEdits\(\[\]\)/);
  });
});

/**
 * [F-18-15][AC-18-11] 地图按天淡出的接线（M83-06）。
 */
describe("地图跟着抽屉选的那一天", () => {
  it("抽屉开着才有焦点天，关掉就回到全程原样", () => {
    assert.match(APP, /focusDay: detailOpen \? detailDay : undefined/);
  });

  it("focusDay 透传到地图层，且只写一处", () => {
    assert.equal(count(SRC, "focusDay={tripMap.focusDay}"), 1);
  });
});
