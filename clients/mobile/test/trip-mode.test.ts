/**
 * [F-01-10][AC-01-6] 真实地图行程模式的判定（M13-06；M65-01 手机端抽成纯函数）。
 * 四个条件缺一样都回落装饰概览——判据与车机 App.tsx 逐字相同。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TripPlanSnapshot } from "@carlife/shared";

import { tripActiveFor } from "../src/data/tripMode";

const TODAY = "2026-09-02";
// 不从 @carlife/ui 取 DEMO_TRIP_PLAN：包入口会带出 assistant-avatar 的 .png，node:test 加载不了。
const plan: TripPlanSnapshot = {
  status: "confirmed",
  destination: "广州（测试）",
  startDate: TODAY,
  days: 1,
  skeleton: [
    {
      day: 1,
      theme: "测试",
      spots: [{ name: "广州塔", lat: 23.1064, lon: 113.3245, poiKind: "spot" }],
      hotel: { name: "测试酒店", estPrice: "-", lat: 23.1327, lon: 113.3273 },
    },
  ],
  caveats: [],
  updatedTurnId: "t-test",
} as TripPlanSnapshot;

describe("[F-01-10] tripActiveFor", () => {
  it("确认过 + 今天在行程里 + 有坐标 + 高德在 → 行程模式", () => {
    assert.equal(tripActiveFor({ plan, amapFailed: false, today: TODAY }), true);
  });
  it("没有行程 → 装饰概览", () => {
    assert.equal(tripActiveFor({ plan: null, amapFailed: false, today: TODAY }), false);
  });
  it("未确认 → 装饰概览", () => {
    assert.equal(tripActiveFor({ plan: { ...plan, status: "draft" } as TripPlanSnapshot, amapFailed: false, today: TODAY }), false);
  });
  it("今天不在行程里 → 装饰概览", () => {
    assert.equal(tripActiveFor({ plan, amapFailed: false, today: "2027-01-01" }), false);
  });
  it("高德报废 → 装饰概览（回落不是白屏）", () => {
    assert.equal(tripActiveFor({ plan, amapFailed: true, today: TODAY }), false);
  });
  it("没有坐标 → 装饰概览", () => {
    const noCoords = {
      ...plan,
      skeleton: plan.skeleton.map((d) => ({ ...d, spots: d.spots.map(({ lat: _a, lon: _b, ...rest }) => rest), hotel: undefined })),
    } as unknown as TripPlanSnapshot;
    assert.equal(tripActiveFor({ plan: noCoords, amapFailed: false, today: TODAY }), false);
  });
});
