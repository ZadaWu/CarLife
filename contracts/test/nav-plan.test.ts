/**
 * 出发导航方案的可用性判据（M66-01）。
 *
 * 只有一个函数，但它决定出发卡按钮走"方案"还是"直连"：判松了会拿一份没有终点坐标的方案去唤起高德，
 * 判紧了会把"这段不需要休息"当成失败。两个方向都要钉。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { navPlanIsUsable, type NavPlan } from "../src/index";

const BASE: NavPlan = {
  origin: { lat: 31.23, lon: 121.47, source: "fix", ageMinutes: 3 },
  destination: { name: "灵隐寺", lat: 30.24, lon: 120.1 },
  strategy: "highway",
  strategyReason: "默认走高速",
  summary: { distanceKm: 180, durationMin: 150, tollYuan: 76 },
  waypoints: [{ name: "嘉兴服务区", lat: 30.75, lon: 120.76, atMinute: 70 }],
  legMinutes: [70, 80],
  constraints: [],
  caveats: [],
  computedAt: "2026-09-02T00:00:00.000Z",
};

test("有终点坐标即可用；途经点为空仍可用（空 = 不需要歇，不是失败）", () => {
  assert.equal(navPlanIsUsable(BASE), true);
  assert.equal(navPlanIsUsable({ ...BASE, waypoints: [], legMinutes: [150] }), true);
});

test("无终点坐标 / (0,0) / 空值 → 不可用", () => {
  assert.equal(navPlanIsUsable({ ...BASE, destination: { name: "x", lat: 0, lon: 0 } }), false);
  assert.equal(
    navPlanIsUsable({ ...BASE, destination: { name: "x", lat: Number.NaN, lon: 120 } }),
    false,
  );
  assert.equal(navPlanIsUsable(undefined), false);
  assert.equal(navPlanIsUsable(null), false);
});
