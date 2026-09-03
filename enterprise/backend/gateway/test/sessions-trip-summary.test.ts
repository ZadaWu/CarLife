/**
 * 会话列表每行带的行程摘要（`/console/sessions` 的 `trip` 字段）。
 * 只有"定了什么、几天、还算不算数"——整份快照在详情页另取，列表不该搬十几 KB 一行。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CommittedTripPlan } from "@carlife/db";

import { tripSummary } from "../src/console/sessions";

const plan = (over: Partial<CommittedTripPlan> = {}): CommittedTripPlan => ({
  planId: "p1",
  userId: "u",
  sessionId: "sess-1#123",
  status: "confirmed",
  committedAt: new Date("2026-09-02T12:38:12.991Z"),
  startDate: "2026-09-03",
  endDate: "2026-09-03",
  plan: {
    status: "confirmed",
    destination: "浙江·嘉兴",
    days: 1,
    startDate: "2026-09-03",
    skeleton: [{ day: 1, theme: "南湖红船", spots: [{ name: "嘉兴南湖旅游区" }] }],
    caveats: [],
    updatedTurnId: "t",
  },
  ...over,
});

describe("tripSummary", () => {
  it("摘要只带列表要看的字段，带各天主题，不带站点明细", () => {
    const s = tripSummary(plan());
    assert.deepEqual(s, {
      planId: "p1",
      status: "confirmed",
      destination: "浙江·嘉兴",
      days: 1,
      startDate: "2026-09-03",
      endDate: "2026-09-03",
      committedAt: "2026-09-02T12:38:12.991Z",
      themes: ["南湖红船"],
    });
    assert.ok(!("skeleton" in s));
  });

  it("没有出发日就没有出发日字段——不拿今天顶替；已取消的照样给（状态如实）", () => {
    const s = tripSummary(plan({ status: "cancelled", startDate: undefined, endDate: undefined }));
    assert.equal(s.status, "cancelled");
    assert.ok(!("startDate" in s));
  });
});
