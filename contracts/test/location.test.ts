/**
 * 定位契约的三条不变量。
 *
 * 盯的都是**不会有症状的**那几种坏法：模糊定位其实交出了精确坐标、
 * 半截的视图被原样喂给地图、以及"关掉定位顺手把地图视图也清了"。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyPrecision,
  coarsenLatLon,
  COARSE_GRID_DEG,
  COARSE_MIN_ACCURACY_M,
  DEFAULT_LOCATION_CONSENT,
  MAP_ZOOM_MAX,
  MAP_ZOOM_MIN,
  normalizeViewport,
  sameViewport,
  viewportFromFix,
} from "../src/domain/location";

const RAW = {
  lat: 22.543123,
  lon: 114.057912,
  accuracyM: 12,
  source: "gps" as const,
  at: "2026-08-30T10:00:00.000Z",
};

describe("定位授权粒度", () => {
  it("默认是关的，且默认粒度是模糊", () => {
    assert.equal(DEFAULT_LOCATION_CONSENT.enabled, false, "默认开 = 用户还没授权就已经被定位了");
    assert.equal(DEFAULT_LOCATION_CONSENT.precision, "coarse");
  });

  it("precise 原样交出，只夹掉负精度", () => {
    const fix = applyPrecision(RAW, "precise");
    assert.equal(fix.lat, RAW.lat);
    assert.equal(fix.lon, RAW.lon);
    assert.equal(fix.accuracyM, 12);
  });

  it("coarse **必须**丢掉小数位，且不许声称自己是米级", () => {
    const fix = applyPrecision(RAW, "coarse");
    assert.notEqual(fix.lat, RAW.lat, "模糊定位交出了精确坐标——这种坏法没有任何症状");
    assert.equal(fix.lat, 22.54);
    assert.equal(fix.lon, 114.06);
    assert.ok(
      fix.accuracyM >= COARSE_MIN_ACCURACY_M,
      "报 12 米会让上层拿模糊坐标去画一个米级的圈",
    );
  });

  it("网格是四舍五入而不是截断——截断会让位置恒偏西南", () => {
    const { lat } = coarsenLatLon(22.5399, 114);
    assert.equal(lat, 22.54, `0.0099 应进位到一格，网格 ${COARSE_GRID_DEG}`);
  });

  it("同一格子里的任意两点吸附到同一坐标（这才叫模糊）", () => {
    const a = coarsenLatLon(22.5412, 114.0561);
    const b = coarsenLatLon(22.5438, 114.0559);
    assert.deepEqual(a, b);
  });
});

describe("地图视图的恢复", () => {
  it("半截 / 脏数据一律当没存过", () => {
    assert.equal(normalizeViewport(null), null);
    assert.equal(normalizeViewport({ lat: 22.5, lon: 114 }), null, "缺 zoom");
    assert.equal(normalizeViewport({ lat: Number.NaN, lon: 114, zoom: 12 }), null);
    assert.equal(normalizeViewport({ lat: 999, lon: 114, zoom: 12 }), null);
    assert.equal(normalizeViewport('{"lat":1}'), null, "字符串不是视图");
  });

  it("越界的 zoom 夹回区间，而不是整份丢掉", () => {
    // 丢掉的话用户会回到深圳市中心；夹回去只是缩放差一档，中心还在他自己那儿。
    assert.equal(normalizeViewport({ lat: 31.2, lon: 121.5, zoom: 999 })?.zoom, MAP_ZOOM_MAX);
    assert.equal(normalizeViewport({ lat: 31.2, lon: 121.5, zoom: -4 })?.zoom, MAP_ZOOM_MIN);
    assert.equal(normalizeViewport({ lat: 31.2, lon: 121.5, zoom: 999 })?.lat, 31.2);
  });

  it("米级以下的漂移不算变化——否则地图一渲染就写一次盘", () => {
    const base = { lat: 22.54, lon: 114.06, zoom: 12 };
    assert.ok(sameViewport(base, { ...base, lat: 22.540001 }));
    assert.equal(sameViewport(base, { ...base, zoom: 13 }), false);
    assert.equal(sameViewport(base, { ...base, lat: 22.55 }), false);
  });

  it("由定位结果生成视图时保留坐标、缩放可指定", () => {
    const v = viewportFromFix(applyPrecision(RAW, "precise"), 16);
    assert.equal(v.lat, RAW.lat);
    assert.equal(v.zoom, 16);
  });
});
