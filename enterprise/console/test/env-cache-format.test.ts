/**
 * ⑤缓存详情的格式化纯函数（M-mem-cache-detail）。
 *
 * 详情弹窗的意义是把 JSON 读成人话；"人话"里每一处数字怎么读都在这里定，
 * 写错了只会在页面上看得见——所以这些函数不进 JSX，进这里测。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chargingKeyToCenter,
  coordText,
  dateLabel,
  distanceText,
  durationText,
  hostOf,
  nsLabel,
  regeoKeyToPoint,
  routeKeyToEnds,
  splitKey,
  tempRangeText,
  weatherText,
  windText,
} from "../src/pages/memory/env-cache-format";

describe("键的解析", () => {
  it("regeo 键 → 坐标；别的命名空间 / 坏键 → undefined", () => {
    assert.deepEqual(regeoKeyToPoint("carlife:env:regeo:23.18:113.3"), { lat: 23.18, lon: 113.3 });
    assert.equal(regeoKeyToPoint("carlife:env:amap-forecast:440104"), undefined);
    assert.equal(regeoKeyToPoint("carlife:env:regeo:x:1"), undefined);
    assert.equal(splitKey("random:key"), undefined);
  });

  it("route 键：起终点 + 途经点 + 策略（途经点 `-` 表示没有）", () => {
    const r = routeKeyToEnds("carlife:env:route:31.23:121.47:30.75:120.75:-:default");
    assert.deepEqual(r?.origin, { lat: 31.23, lon: 121.47 });
    assert.deepEqual(r?.destination, { lat: 30.75, lon: 120.75 });
    assert.deepEqual(r?.waypoints, []);
    assert.equal(r?.strategy, "default");
    const w = routeKeyToEnds("carlife:env:route:1:2:3:4:1.5,2.5|3.5,4.5:36");
    assert.deepEqual(w?.waypoints, [
      { lat: 1.5, lon: 2.5 },
      { lat: 3.5, lon: 4.5 },
    ]);
    assert.equal(w?.strategy, "36");
  });

  it("charging 键：中心 + 半径", () => {
    assert.deepEqual(chargingKeyToCenter("carlife:env:charging:30.24:120.11:5000"), {
      center: { lat: 30.24, lon: 120.11 },
      radiusM: 5000,
    });
  });

  it("命名空间的人话：表里没有的原样显示，不猜", () => {
    assert.equal(nsLabel("guide-brief"), "景区导览简报");
    assert.equal(nsLabel("dest-highlights"), "目的地推荐");
    assert.equal(nsLabel("brand-new"), "brand-new");
  });
});

describe("人话格式", () => {
  it("坐标带方向", () => {
    assert.equal(coordText({ lat: 23.18, lon: 113.3 }), "23.18°N, 113.30°E");
    assert.equal(coordText({ lat: -33.87, lon: -70.6 }), "33.87°S, 70.60°W");
  });

  it("日期：不走 Date.parse（无时区日期会被当 UTC，东八区差一天）", () => {
    assert.equal(dateLabel("2026-09-03"), "9月3日 周四");
    assert.equal(dateLabel("2026-09-03", new Date(2026, 8, 2)), "明天 · 9月3日 周四");
    assert.equal(dateLabel("2026-09-02", new Date(2026, 8, 2)), "今天 · 9月2日 周三");
    assert.equal(dateLabel("2026-09-10", new Date(2026, 8, 2)), "9月10日 周四");
    assert.equal(dateLabel("garbage"), "garbage");
  });

  it("天气：同一种只说一次，不同就「转」", () => {
    assert.equal(weatherText("多云", "多云"), "多云");
    assert.equal(weatherText("雷阵雨", "中雨"), "雷阵雨转中雨");
    assert.equal(weatherText("", ""), "—");
  });

  it("气温：缺一边只说有的那边，**不补零**", () => {
    assert.equal(tempRangeText(30, 24), "24 ~ 30℃");
    assert.equal(tempRangeText(null, 24), "夜间 24℃");
    assert.equal(tempRangeText(30, undefined), "白天 30℃");
    assert.equal(tempRangeText(null, null), "—");
  });

  it("风：方向补「风」、档位补「级」，已带的不重复", () => {
    assert.equal(windText("北", "1-3"), "北风 1-3级");
    assert.equal(windText("东南风", "4级"), "东南风 4级");
    assert.equal(windText(null, null), "—");
  });

  it("距离与时长", () => {
    assert.equal(distanceText(100), "100 米");
    assert.equal(distanceText(7500), "7.5 公里");
    assert.equal(distanceText(219_000), "219 公里");
    assert.equal(distanceText(null), "—");
    assert.equal(durationText(25 * 60), "25 分钟");
    assert.equal(durationText(65 * 60), "1 小时 5 分");
    assert.equal(durationText(7200), "2 小时");
  });

  it("出处只显示主机名；解析不了原样给", () => {
    assert.equal(hostOf("https://tw.trip.com/moments/detail/x"), "tw.trip.com");
    assert.equal(hostOf("not a url"), "not a url");
  });
});
