/**
 * `resampleEven` 的单测。
 *
 * 这一层看不见效果、也不会报错：`moveAlong` 的 `duration` 是每段时长，
 * 段长不均就是流速不均，而"流速不均"在代码里没有任何症状——
 * 只能在这里量。所以判据直接写成"相邻间距的极差不超过均值的 1%"。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { resampleEven } from "../src/map/trip-route";

const KX = Math.cos((23.1 * Math.PI) / 180);

/** 与 resampleEven 同一套度量（cos 纬度校正的平面近似）。 */
function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot((b[0] - a[0]) * KX, b[1] - a[1]);
}

function gaps(p: Array<[number, number]>): number[] {
  return p.slice(1).map((q, i) => dist(p[i], q));
}

test("等分后点数与首尾都按约定给", () => {
  const path: Array<[number, number]> = [
    [113.3, 23.1],
    [113.4, 23.15],
    [113.42, 23.3],
  ];
  const out = resampleEven(path, 50);
  assert.equal(out.length, 50);
  assert.deepEqual(out[0], path[0]);
  assert.deepEqual(out[out.length - 1], path[path.length - 1]);
});

test("点疏密悬殊的折线被摊成等距", () => {
  // 前半段密（弯道，每 0.001° 一个点），后半段疏（直路，一步 0.2°）——
  // 高德返回的折线就是这个形状，也正是原来粒子忽停忽跳的根源。
  //
  // 取共线的一条来量：转角处两个采样点之间的**直线距离**天然短于沿线弧长
  //（抄的是那个角的弦），那是几何事实不是缺陷，混进来只会让判据失去意义。
  // 转角本身由下一条"不抄近道"覆盖。
  const path: Array<[number, number]> = [];
  for (let i = 0; i <= 20; i += 1) path.push([113.3 + i * 0.001, 23.1]);
  path.push([113.52, 23.1]);
  path.push([113.72, 23.1]);

  const g = gaps(resampleEven(path, 240));
  const avg = g.reduce((a, b) => a + b, 0) / g.length;
  const spread = Math.max(...g) - Math.min(...g);
  assert.ok(spread < avg * 0.01, `间距极差 ${spread} 应远小于均值 ${avg}`);
});

test("等分点落在原折线上，不抄近道", () => {
  // 直角折线：任何一个采样点要么在横边上（lat 不变）、要么在竖边上（lon 不变）。
  const path: Array<[number, number]> = [
    [113.3, 23.1],
    [113.5, 23.1],
    [113.5, 23.3],
  ];
  for (const [lon, lat] of resampleEven(path, 120)) {
    const onH = Math.abs(lat - 23.1) < 1e-9 && lon >= 113.3 - 1e-9 && lon <= 113.5 + 1e-9;
    const onV = Math.abs(lon - 113.5) < 1e-9 && lat >= 23.1 - 1e-9 && lat <= 23.3 + 1e-9;
    assert.ok(onH || onV, `采样点 ${lon},${lat} 不在折线上`);
  }
});

test("退化输入原样返回，不抛也不产出空路径", () => {
  const single: Array<[number, number]> = [[113.3, 23.1]];
  assert.deepEqual(resampleEven(single, 240), single);
  assert.deepEqual(resampleEven([], 240), []);

  // 全部重合：总长为 0，无从等分。
  const same: Array<[number, number]> = [
    [113.3, 23.1],
    [113.3, 23.1],
  ];
  assert.deepEqual(resampleEven(same, 240), same);

  // count < 2：一圈没有段，除下去会是 Infinity——必须在这里就挡住。
  const pair: Array<[number, number]> = [
    [113.3, 23.1],
    [113.4, 23.2],
  ];
  assert.deepEqual(resampleEven(pair, 1), pair);
});

// ── 步行接驳（折线端点 → 站点圆点的虚线）────────────────────────

test("walkConnectors：贴路网收尾的差距按对给出；到达/出发各一条", async () => {
  const { walkConnectors } = await import("../src/map/trip-route");
  // 照抄普陀山实测形状：百步沙圆点在沙滩上，驾车折线在 ~85m 外的路上收尾。
  const guanyin: [number, number] = [122.393802, 29.97406];
  const baibu: [number, number] = [122.390693, 29.984555];
  const puji: [number, number] = [122.386972, 29.985861];
  const roadNearBaibu: [number, number] = [122.38985, 29.98435]; // 距百步沙 ~85m
  const roadNearPuji: [number, number] = [122.38763, 29.98545]; // 距普济 ~76m
  const legs = [
    { path: [guanyin, roadNearBaibu], durationS: 300 }, // 起点就在站点上（观音有路）
    { path: [roadNearBaibu, roadNearPuji], durationS: 240 },
  ];
  const pairs = walkConnectors([guanyin, baibu, puji], legs);
  // 百步沙的到达与出发共用同一落路点 → 去重成一条；普济到达一条。
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs[0], [baibu, roadNearBaibu]);
  assert.deepEqual(pairs[1], [puji, roadNearPuji]);
});

test("walkConnectors：阈值内不画、失败段不画——直线回落的端点就是站点", async () => {
  const { walkConnectors, WALK_CONNECTOR_MIN_M } = await import("../src/map/trip-route");
  const a: [number, number] = [113.3, 23.1];
  const b: [number, number] = [113.31, 23.11];
  // 端点与站点差 ~11m（< 30m 阈值）：GPS 级偏差，不画毛刺。
  const nearB: [number, number] = [113.3101, 23.11];
  assert.equal(WALK_CONNECTOR_MIN_M, 30);
  assert.deepEqual(walkConnectors([a, b], [{ path: [a, nearB], durationS: 60 }]), []);
  // 规划失败（null）：那段回落直线，两端即站点，无缝可接。
  assert.deepEqual(walkConnectors([a, b], [null]), []);
  // 空 legs / 点数不齐也不抛。
  assert.deepEqual(walkConnectors([a], []), []);
});
