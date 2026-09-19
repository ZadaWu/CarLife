/**
 * [F-18-15][AC-18-11] 切天时镜头跟着挪到那一天（2026-09-16 走查）。
 *
 * 走查原话：「切换天时，地图的焦点没有切换，期望是能切换到那天所在的行程区域」。
 * 此前 `focusDay` 只做淡出——别的天灰掉了，镜头仍框着全程。
 *
 * 能直接跑的只有"挑哪几个点"那一段（`indexesOfDay`）：`setFitView` 要浏览器里的
 * AMap。接线上的三条纪律（只在真切天时动、不重建覆盖物、取完景把镜头判给用户）
 * 由源码断言守——与 `trip-map-dim.test.ts` 同一手法。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { avoidXWithDrawer, fitCenterX } from "../src/map/fit-avoid";
import { indexesOfDay, markerDays } from "../src/map/trip-marker";

const LAYER = readFileSync(new URL("../src/map/AmapTripLayer.tsx", import.meta.url), "utf8");

/** 按天取景那个 effect 的函数体（从注释标题到它的依赖数组）。 */
function focusEffectBody(): string {
  const at = LAYER.indexOf("const fitDayRef");
  assert.notEqual(at, -1, "找不到按天取景的 effect");
  const end = LAYER.indexOf("}, [focusDay, ready, fitToStops, fitOverlays]);", at);
  assert.notEqual(end, -1, "按天取景 effect 的依赖数组变了——改依赖前先看本文件的断言");
  return LAYER.slice(at, end);
}

describe("按天挑落点", () => {
  it("只挑那一天的；连住酒店跨两天，两天都算它", () => {
    // 第 1 天两个景点 + 一家连住 1–2 天的酒店，第 2 天一个景点。
    const dayLists = [markerDays({ name: "A", day: 1, kind: "spot" }), markerDays({ name: "B", day: 1, kind: "spot" }), markerDays({ name: "H", day: 1, kind: "hotel", days: [1, 2] }), markerDays({ name: "C", day: 2, kind: "spot" })];
    assert.deepEqual(indexesOfDay(dayLists, 1), [0, 1, 2]);
    // 第 2 天必须带上酒店：不带的话框出来的视野把当晚住的地方甩在框外
    assert.deepEqual(indexesOfDay(dayLists, 2), [2, 3]);
  });

  it("那一天一个点都没有 → 空数组（调用方据此不动镜头）", () => {
    assert.deepEqual(indexesOfDay([[1], [1]], 3), []);
    assert.deepEqual(indexesOfDay([], 1), []);
  });

  it("圆点的天表与圆点**逐条对齐**地建——覆盖物对象本身问不出天", () => {
    assert.match(LAYER, /dotsRef\.current = dots;\n(\s*\/\/.*\n)*\s*dotDaysRef\.current = located\.map\(markerDays\);/);
  });
});

describe("切天取景的三条纪律", () => {
  it("只在真的切了天时动镜头——effect 还会因就绪/回调重跑，那时抢镜头就是 M19-05 那个坑", () => {
    const body = focusEffectBody();
    assert.match(body, /if \(fitDayRef\.current === focusDay\) return;/);
    assert.match(body, /fitDayRef\.current = focusDay;/);
  });

  it("**不重建覆盖物**：只读已经在图上的圆点，不碰路径规划与行程标注", () => {
    const body = focusEffectBody();
    assert.ok(body.includes("dotsRef.current"), "取景该读 dotsRef");
    for (const forbidden of ["overlaysRef", "routeLinesRef", "planDrivingLegs", "Driving", "setContent"]) {
      assert.ok(!body.includes(forbidden), `按天取景碰了 ${forbidden} = 切一天重做一次路径规划`);
    }
  });

  it("取完景把镜头判给用户，「回到全程」按钮就是退路", () => {
    const body = focusEffectBody();
    assert.match(body, /userMovedRef\.current = true;\n\s*setUserMoved\(true\);/);
  });

  it("那天没有带坐标的落点时不动镜头——猜一个位置框过去比不动更糟", () => {
    assert.match(focusEffectBody(), /if \(!fitOverlays\(ofDay, DAY_FIT_MAX_ZOOM\)\) return;/);
  });

  it("关抽屉回到全程：镜头交还程序并框一次——淡出已经恢复成全程的样子了", () => {
    const body = focusEffectBody();
    assert.match(body, /if \(focusDay === undefined\) \{\n\s*userMovedRef\.current = false;\n\s*setUserMoved\(false\);\n\s*fitToStops\(\);/);
  });

  it("点挨得近的那天不怼到最大级：13 级 ≈ 一个新城片区，看得见周边参照", () => {
    // 走查第二轮把它从 15 退到 13（「缩放不要放那么大」）；改之前先看下面那条避让断言。
    assert.match(LAYER, /const DAY_FIT_MAX_ZOOM = 13;/);
    assert.match(LAYER, /\(map, list, true, avoid, maxZoom\)|maxZoom,\n\s*\);/);
  });

  it("取景的依赖里没有 stopsKey——行程内容一变就抢镜头的话，用户正看的那天会被拽走", () => {
    assert.ok(!focusEffectBody().includes("stopsKey"));
    assert.match(LAYER, /\}, \[focusDay, ready, fitToStops, fitOverlays\]\);/);
  });
});

describe("抽屉开着时的取景居中", () => {
  it("**内容正好落在可见区的水平中心**——右让量 = 抽屉占宽 + 左让量", () => {
    // 走查实测的那一组：视口 1600、抽屉左缘 976（占宽 624）、基准让量 130/520、gap 80。
    const W = 1600, drawerLeft = 976, drawerW = W - drawerLeft;
    const [l, r] = avoidXWithDrawer(drawerW, 130, 520, 80);
    assert.deepEqual([l, r], [210, 834]);
    // 可见区是 0 ~ 抽屉左缘，它的中心就是落点包围盒该去的地方
    assert.equal(fitCenterX(W, l, r), drawerLeft / 2);
  });

  it("换一块屏、换一个抽屉宽度，居中这条关系仍然成立", () => {
    for (const [W, drawerLeft, gap] of [[2000, 1230, 80], [1440, 900, 80], [1600, 976, 0]] as const) {
      const [l, r] = avoidXWithDrawer(W - drawerLeft, 130, 520, gap);
      assert.equal(fitCenterX(W, l, r), drawerLeft / 2, `${W}×${drawerLeft} 没居中`);
    }
  });

  it("只加右让量就会偏心——前两版栽的正是这里", () => {
    // 第二版：右侧一路加到「抽屉 + 180」而左侧不动，内容被推到可见区中心左边 25 px。
    const off = fitCenterX(1600, 130, (1600 - 976) + 180);
    assert.equal(Math.round(976 / 2 - off), 25);
  });

  it("抽屉没开 / 手机端根本不挂它 → 让量原样返回，行为与从前逐字一致", () => {
    assert.deepEqual(avoidXWithDrawer(0, 130, 520, 80), [130, 520]);
  });

  it("取景避让量着真实抽屉，不抄 CSS 里那个 620", () => {
    assert.match(LAYER, /const \[l2, r2\] = avoidXWithDrawer\(drawerWidth\(width\), l, r, DRAWER_FIT_GAP\);/);
    const at = LAYER.indexOf("function drawerWidth");
    assert.notEqual(at, -1);
    const fn = LAYER.slice(at, LAYER.indexOf("\n}", at));
    assert.ok(fn.includes('querySelector(".hud-tripdetail")'));
    assert.match(fn, /if \(!el\) return 0;/);
    // 余量由调用方按配法加，量抽屉的这一步只回答"抽屉占了多宽"
    assert.ok(!fn.includes("DRAWER_FIT_GAP"));
  });

  it("横向夹持单独一档（0.55）：0.4 会把「让开抽屉」直接抹掉", () => {
    // 实测 1600 宽下想让 834、被 0.4 夹回 640，胶囊照样压在抽屉边上。
    assert.match(LAYER, /const AVOID_MAX_RATIO_X = 0\.55;/);
    assert.match(LAYER, /const capX = width \* AVOID_MAX_RATIO_X;/);
    // 纵向不动：顶栏/屏底那两条让量与从前逐字一致
    assert.match(LAYER, /const capY = height \* AVOID_MAX_RATIO;/);
  });

  it("避让仍受夹持——抽屉比半屏还宽时不能把视野挤没", () => {
    assert.match(LAYER, /Math\.min\(r2, capX\)/);
  });
});
