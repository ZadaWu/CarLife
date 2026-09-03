/**
 * 导航状态的过期判据（M31-01）。
 *
 * 这一层只有一个函数，但它决定了"屏幕上还跟不跟车"，两个方向都会伤人：
 * 判松了是昨天的导航挂到今天（c256a5d 那类假象），判紧了是开着车导航自己没了。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { NAV_MAX_AGE_H, tripPlanNavDay, type TripPlanSnapshot } from "../src/index";

const BASE: TripPlanSnapshot = {
  status: "confirmed",
  destination: "广州",
  days: 3,
  startDate: "2026-08-27",
  skeleton: [
    { day: 1, theme: "老城", spots: [{ name: "陈家祠" }] },
    { day: 2, theme: "江边", spots: [{ name: "沙面岛" }] },
    { day: 3, theme: "返程", spots: [{ name: "白云机场" }] },
  ],
  caveats: [],
  updatedTurnId: "turn-1",
};

const NOW = "2026-08-27T10:00:00.000Z";

function withNav(nav: TripPlanSnapshot["nav"], over: Partial<TripPlanSnapshot> = {}) {
  return { ...BASE, ...over, nav };
}

test("没有 nav 就是没在导航", () => {
  assert.equal(tripPlanNavDay(BASE, NOW), undefined);
});

test("正常在导航：返回第几天", () => {
  const plan = withNav({ day: 2, startedAt: "2026-08-27T09:30:00.000Z" });
  assert.equal(tripPlanNavDay(plan, NOW), 2);
});

test("行程不是 confirmed 时一律不算在导航——草案不该有跟车模式", () => {
  const plan = withNav({ day: 1, startedAt: NOW }, { status: "refining" });
  assert.equal(tripPlanNavDay(plan, NOW), undefined);
});

test("行程被取消后 nav 立刻失效", () => {
  const plan = withNav({ day: 1, startedAt: NOW }, { status: "cancelled" });
  assert.equal(tripPlanNavDay(plan, NOW), undefined);
});

test(`超过 ${NAV_MAX_AGE_H} 小时的导航作废`, () => {
  const started = new Date(Date.parse(NOW) - (NAV_MAX_AGE_H + 1) * 3_600_000).toISOString();
  assert.equal(tripPlanNavDay(withNav({ day: 1, startedAt: started }), NOW), undefined);
});

test("刚好在阈值以内仍然有效——边界不能把正在开的那趟判掉", () => {
  const started = new Date(Date.parse(NOW) - (NAV_MAX_AGE_H - 0.5) * 3_600_000).toISOString();
  assert.equal(tripPlanNavDay(withNav({ day: 1, startedAt: started }), NOW), 1);
});

/**
 * 这一条是本文件存在的主要理由：判据故意不看"是不是同一天"。
 * `startedAt` 是 UTC，东八区早上 7 点出发 = UTC 前一天 23 点——
 * 按日期比就会在刚说完「出发」的那一秒把导航判成"昨天的"。
 */
test("东八区清早出发不会被当成昨天的导航", () => {
  const startedAt = "2026-08-26T23:10:00.000Z"; // = 北京时间 8/27 07:10
  const now = "2026-08-27T00:10:00.000Z"; // = 北京时间 8/27 08:10，才过一小时
  assert.equal(tripPlanNavDay(withNav({ day: 1, startedAt }), now), 1);
});

test("day 落在行程天数之外时不算——行程被改短后 nav 会指向不存在的那天", () => {
  assert.equal(tripPlanNavDay(withNav({ day: 9, startedAt: NOW }), NOW), undefined);
  assert.equal(tripPlanNavDay(withNav({ day: 0, startedAt: NOW }), NOW), undefined);
});

test("时间戳解析不了就不认这次导航——拿不准时停在行程模式", () => {
  assert.equal(tripPlanNavDay(withNav({ day: 1, startedAt: "不是时间" }), NOW), undefined);
  assert.equal(tripPlanNavDay(withNav({ day: 1, startedAt: NOW }), "也不是时间"), undefined);
});
