/**
 * 保养提醒合并确认单测（施工单 M8-04）。零依赖。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isNearDue,
  mergeMaintenanceIntoTrip,
  writeReceipt,
  type CalendarDraftItem,
  type MaintenanceHint,
} from "../src/graph/subgraphs/ownership-maintenance";
import {
  isMaintenanceQuery,
  renderMaintenanceForecastContext,
} from "../src/graph/subgraphs/ownership";

const tripItems: CalendarDraftItem[] = [
  { kind: "trip", title: "出发", start: "2026-08-15T07:00", end: "2026-08-15T08:00" },
  { kind: "trip", title: "充电停靠", start: "2026-08-15T11:00", end: "2026-08-15T11:40" },
];
const when = { start: "2026-09-01T09:00", end: "2026-09-01T10:00" };
const title = () => "保养到期提醒";

describe("临近判定", () => {
  it("剩余里程少 → 临近", () => {
    assert.equal(isNearDue({ remainingKm: 800, degraded: false }), true);
  });

  it("里程还多但天数临近 → 也算临近", () => {
    assert.equal(isNearDue({ remainingKm: 5_000, etaDays: 20, degraded: false }), true);
  });

  it("都不临近 → 不提醒", () => {
    assert.equal(isNearDue({ remainingKm: 5_000, etaDays: 120, degraded: false }), false);
  });

  it("已超期当然算临近", () => {
    assert.equal(isNearDue({ remainingKm: -300, degraded: false }), true);
  });
});

describe("搭便车合并（§5：不单独触发一轮确认）", () => {
  it("有行程写入且保养临近 → 并入同一次确认", () => {
    const d = mergeMaintenanceIntoTrip(tripItems, { remainingKm: 500, degraded: false }, title, when);
    assert.equal(d.maintenanceMerged, true);
    assert.equal(d.items.length, 3);
    assert.equal(d.items[2].kind, "maintenance", "**保养项可视觉区分**，端上据此加标记");
  });

  it("**没有行程写入时不强行创造一次写入**——那就成了主动打扰", () => {
    const d = mergeMaintenanceIntoTrip([], { remainingKm: 500, degraded: false }, title, when);
    assert.equal(d.maintenanceMerged, false);
    assert.match(d.notMergedReason ?? "", /低打扰呈现/);
  });

  it("保养未临近 → 不打扰", () => {
    const d = mergeMaintenanceIntoTrip(tripItems, { remainingKm: 8_000, etaDays: 200, degraded: false }, title, when);
    assert.equal(d.maintenanceMerged, false);
    assert.equal(d.items.length, 2);
  });

  it("降级推算被标注在条目上——用户要知道这是通用周期估的", () => {
    const d = mergeMaintenanceIntoTrip(tripItems, { remainingKm: 500, degraded: true }, title, when);
    assert.match(d.items[2].note ?? "", /通用保养周期/);
  });

  it("无推算结果时不合并，也不报错", () => {
    const d = mergeMaintenanceIntoTrip(tripItems, undefined, title, when);
    assert.equal(d.maintenanceMerged, false);
    assert.equal(d.items.length, 2);
  });
});

describe("保养到期推算的编排接线（M14-02，F-17-01）", () => {
  const profile = {
    odometerKm: 18_000,
    maintenanceIntervalKm: 10_000,
    maintenance: [{ at: Date.UTC(2026, 0, 1), odometerKm: 10_000, items: "常规", source: "4S" }],
  };

  it("保养意图门：问保养的命中，问空调的不命中", () => {
    assert.equal(isMaintenanceQuery("我下次保养大概什么时候"), true);
    assert.equal(isMaintenanceQuery("首保要做什么"), true);
    assert.equal(isMaintenanceQuery("该换机油了吗"), true);
    assert.equal(isMaintenanceQuery("空调怎么开除雾"), false);
  });

  it("**区间 + 依据，不给伪精确日期**（AC-17-1）", () => {
    const ctx = renderMaintenanceForecastContext(profile, 40);
    assert.match(ctx, /约剩 2000 公里/);
    assert.match(ctx, /\d+~\d+ 周/, "时间必须是区间");
    assert.match(ctx, /依据：/);
    assert.match(ctx, /不要编造具体到期日期/);
    // 历史日期（"上次保养在 2026-01-01"）是事实可以出现；
    // 禁的是**推算出的未来到期日**——它只以"N~M 周"的区间形态存在。
    const afterEta = ctx.slice(ctx.indexOf("周后到期"));
    assert.ok(!/到期.{0,6}\d{4}-\d{2}-\d{2}/.test(ctx), "不得出现『到期 + 具体日期』的表述");
    assert.ok(afterEta.length > 0);
  });

  it("日均未知 → 只给里程不给时间（不猜）", () => {
    const ctx = renderMaintenanceForecastContext(profile);
    assert.ok(!/周后到期/.test(ctx));
    assert.match(ctx, /不给到期时间估计/);
  });

  it("已超期直说超期，不给负数区间", () => {
    const ctx = renderMaintenanceForecastContext({ ...profile, odometerKm: 21_000 }, 40);
    assert.match(ctx, /已超期约 1000 公里/);
    assert.ok(!/周后到期/.test(ctx));
  });

  it("降级（无周期记录）→ 明确要求向用户说明是通用参考", () => {
    const ctx = renderMaintenanceForecastContext({ odometerKm: 5_000, maintenance: [] }, 40);
    assert.match(ctx, /通用参考/);
  });
});

describe("写入回执（F-17-03 的风险缓解）", () => {
  it("**说清楚写了几条、哪条是保养**——四条一起确认时用户可能只注意到行程", () => {
    const r = writeReceipt([...tripItems, { kind: "maintenance", title: "保养", start: "", end: "" }]);
    assert.match(r, /已写入 3 条/);
    assert.match(r, /行程 2 条/);
    assert.match(r, /保养提醒 1 条/);
  });

  it("纯行程时不提保养，避免噪声", () => {
    assert.ok(!writeReceipt(tripItems).includes("保养"));
  });
});
