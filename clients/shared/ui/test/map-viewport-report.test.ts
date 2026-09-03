/**
 * 「地图动了 → 记住它」这一环。
 *
 * 它值得单独一组测试的理由很实在：**无头浏览器里合成的拖动到不了高德的手势层**，
 * 所以这一环在走查里验不了；而它坏掉的表现是"地图能拖，拖完什么也没记住"——
 * 与功能没做完全一样。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bindViewportReporter,
  MAP_VIEWPORT_EVENTS,
  type ViewportReport,
} from "../src/map/viewport-report";

/** 最小假地图：只实现 on/off/getCenter/getZoom。 */
// zoom 不给默认值：`fakeMap(c, undefined)` 要真的表示"拿不到缩放"，
// 给了默认值就会被悄悄补成 13，那条用例等于没测。
function fakeMap(center: { lat: number; lng: number }, zoom: number | undefined) {
  const handlers = new Map<string, Set<() => void>>();
  return {
    on(event: string, h: () => void) {
      (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(h);
    },
    off(event: string, h: () => void) {
      handlers.get(event)?.delete(h);
    },
    getCenter: () => center,
    getZoom: () => zoom,
    emit(event: string) {
      handlers.get(event)?.forEach((h) => h());
    },
    count: (event: string) => handlers.get(event)?.size ?? 0,
  };
}

describe("地图视图上抛", () => {
  it("**每一个**事件都要能触发上抛——只订 moveend 的坏法是静默的", () => {
    for (const event of MAP_VIEWPORT_EVENTS) {
      const map = fakeMap({ lat: 22.54, lng: 114.06 }, 13);
      const seen: ViewportReport[] = [];
      bindViewportReporter(map, 12, (v) => seen.push(v));
      map.emit(event);
      assert.equal(seen.length, 1, `${event} 没有上抛：地图能拖，拖完什么也没记住`);
      assert.deepEqual(seen[0], { lat: 22.54, lon: 114.06, zoom: 13 });
    }
  });

  it("getZoom 拿不到数就用兜底缩放，**不写 undefined**", () => {
    // 写 undefined 的下场：那份记录之后被整份丢掉，表现是"拖了半天还是老地方"。
    const map = fakeMap({ lat: 31.2, lng: 121.5 }, undefined);
    const seen: ViewportReport[] = [];
    bindViewportReporter(map, 9, (v) => seen.push(v));
    map.emit("moveend");
    assert.deepEqual(seen[0], { lat: 31.2, lon: 121.5, zoom: 9 });
  });

  it("拿不到中心就什么都不上抛", () => {
    const map = { ...fakeMap({ lat: 22.54, lng: 114.06 }, 13), getCenter: () => undefined };
    let called = 0;
    bindViewportReporter(map, 12, () => (called += 1));
    map.emit("moveend");
    assert.equal(called, 0);
  });

  it("解绑之后不再上抛——地图销毁后还在回调是典型的内存泄漏", () => {
    const map = fakeMap({ lat: 22.54, lng: 114.06 }, 13);
    let called = 0;
    const unbind = bindViewportReporter(map, 12, () => (called += 1));
    map.emit("moveend");
    unbind();
    map.emit("moveend");
    assert.equal(called, 1);
    for (const event of MAP_VIEWPORT_EVENTS) assert.equal(map.count(event), 0);
  });
});
