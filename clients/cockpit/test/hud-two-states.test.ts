/**
 * [F-01-05][AC-01-5] 主页三态的结构（施工单 M73-02）。
 *
 * 与 `hud-window-card.test.ts` 同一条教训：`HudScreen.tsx` 有两处悬浮层渲染，日期条要两处都挂；
 * 三态的判断（无行程 / 有行程未选中 / 选中）只能写一处。读源码断言，不渲染。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/hud/HudScreen.tsx", import.meta.url), "utf8");
const APP = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const count = (src: string, needle: string) => src.split(needle).length - 1;

describe("三态只判一处、挂两处", () => {
  it("周日历卡与日期条各出现一次、紧凑列表卡不再出现（选中态右列只剩提示卡）；`{dateBanner}` 两处；`{tripsCard}` 两处", () => {
    assert.equal(count(SRC, "<TripCalendarCard"), 1);
    assert.equal(count(SRC, "<TripListCard"), 0, "2026-09-08 产品走查：选中后不显示「我的行程」卡");
    assert.equal(count(SRC, "<TripDateBanner"), 1);
    assert.equal(count(SRC, "{dateBanner}"), 2, "漏一处的表现是「有地图时有日期条、没地图时没有」");
    assert.equal(count(SRC, "{tripsCard}"), 2);
  });

  it("提示卡只在「无行程」或「选中」时渲染；日期条跟车时不渲染", () => {
    assert.match(SRC, /const showTips = !hasTrips \|\| selectedTrip !== undefined;/);
    assert.match(SRC, /const windowCard = !showTips \? null :/);
    assert.match(SRC, /trips && selectedTrip && !tripMap\?\.nav \?/);
  });

  it("两个修饰类各判一次（互斥），一起传给两处 HudStage；选中态不渲染行程卡", () => {
    assert.equal(count(SRC, '"hud-stage--has-trips"'), 1);
    assert.equal(count(SRC, '"hud-stage--trip-selected"'), 1);
    assert.equal(count(SRC, "className={stageClass}"), 2);
    assert.match(SRC, /const tripsCard = !trips \|\| !hasTrips \|\| selectedTrip \? null :/);
  });
});

describe("App：选中不回落、× 清除", () => {
  it("高亮只认真正选中的那程（演示态也从未选中开始）", () => {
    assert.match(APP, /selectedPlanId && tripEntries\.some\(\(e\) => e\.planId === selectedPlanId\) \? selectedPlanId : undefined/);
    assert.ok(!/DEMO_TRIP_ENTRIES\[0\]!\.planId/.test(APP), "演示态不再默认高亮首程");
  });

  it("× → setSelectedPlanId(null) 且 source.select(null)", () => {
    assert.match(APP, /onClearTripSelection = useCallback\(\(\) => \{\s*setSelectedPlanId\(null\);\s*if \("select" in source\) \(source as GatewayHudSource\)\.select\(null\);/);
    assert.match(APP, /onClearSelection: onClearTripSelection/);
  });
});
