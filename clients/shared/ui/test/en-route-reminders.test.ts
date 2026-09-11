/**
 * [F-62-04][F-62-05][F-62-07][F-62-13][AC-62-1][AC-62-2][AC-62-4][AC-62-6][AC-62-7] 途中提醒判据（M77-05）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { NavTripProgress } from "../src/map";
import { advanceTracker, INITIAL_TRACKER, type TrackerState } from "../src/hud/en-route-tracker";
import {
  afterGate,
  DEFAULT_REMINDER_CONFIG,
  gateReminder,
  INITIAL_MEMO,
  reminderText,
  shouldRemindRest,
  shouldRemindStop,
  type ReminderMemo,
} from "../src/hud/en-route-reminders";

const LEGS = [
  { day: 1, fromStop: "杭州", toStop: "云龙湖旅游景区", driveMinutes: 120, reason: "rest" as const },
  { day: 1, fromStop: "云龙湖旅游景区", toStop: "泌冲充电站", driveMinutes: 60, reason: "charge" as const },
];
const fresh = (remainingM: number, remainingSec?: number, next = "云龙湖旅游景区"): { frame: NavTripProgress; tracker: TrackerState } => {
  const frame: NavTripProgress = { nextStopName: next, remainingM, ...(remainingSec !== undefined ? { remainingSec } : {}), finished: false };
  return { frame, tracker: advanceTracker(INITIAL_TRACKER, frame, 1_000) };
};

describe("[F-62-04][F-62-05][F-62-07][F-62-13][AC-62-1][AC-62-2][AC-62-6][AC-62-7][AC-62-8] shouldRemindStop", () => {
  it("有 ETA 按时间：≤ 600 s 才发；带原因", () => {
    const far = fresh(30_000, 1_200);
    assert.equal(shouldRemindStop(far.frame, far.tracker, { legs: LEGS }, INITIAL_MEMO, 1_000), undefined);
    const near = fresh(15_000, 590);
    const r = shouldRemindStop(near.frame, near.tracker, { legs: LEGS }, INITIAL_MEMO, 1_000);
    assert.ok(r);
    assert.equal(r.kind, "stop");
    assert.equal(r.reason, "rest");
    assert.equal(r.remainingSec, 590);
  });
  it("无 ETA 按距离 ≤ 8 km；legs 缺省仍发，只少原因", () => {
    const near = fresh(7_500);
    const r = shouldRemindStop(near.frame, near.tracker, {}, INITIAL_MEMO, 1_000);
    assert.ok(r);
    assert.equal(r.reason, undefined);
    const far = fresh(8_500);
    assert.equal(shouldRemindStop(far.frame, far.tracker, {}, INITIAL_MEMO, 1_000), undefined);
  });
  it("一站一次；hushed 的那一段不发；finished / 无下一站不发", () => {
    const near = fresh(7_000);
    const memo: ReminderMemo = { ...INITIAL_MEMO, remindedStops: ["云龙湖旅游景区"] };
    assert.equal(shouldRemindStop(near.frame, near.tracker, {}, memo, 1_000), undefined);
    assert.equal(shouldRemindStop(near.frame, near.tracker, {}, { ...INITIAL_MEMO, hushedLeg: 0 }, 1_000), undefined);
    assert.equal(shouldRemindStop({ ...near.frame, finished: true }, near.tracker, {}, INITIAL_MEMO, 1_000), undefined);
  });
  it("位置陈旧不发（停靠提醒依赖位置）", () => {
    const near = fresh(7_000);
    assert.equal(shouldRemindStop(near.frame, near.tracker, {}, INITIAL_MEMO, 1_000 + 25_000), undefined);
  });
  it("越过未提醒不补：到站后下一站换人，旧站名再也不会成为 nextStopName", () => {
    const near = fresh(7_000);
    const after = advanceTracker(near.tracker, { nextStopName: "泌冲充电站", remainingM: 40_000, arrivedStopName: "云龙湖旅游景区", finished: false }, 2_000);
    assert.equal(shouldRemindStop({ nextStopName: "泌冲充电站", remainingM: 40_000, finished: false }, after, { legs: LEGS }, INITIAL_MEMO, 2_000), undefined);
  });
});

describe("[F-62-04][F-62-05][F-62-07][F-62-13][AC-62-1][AC-62-2][AC-62-6][AC-62-7][AC-62-8] shouldRemindRest", () => {
  const cfg = { ...DEFAULT_REMINDER_CONFIG, limitMin: 120 };
  const startedAt = (t: number): TrackerState => ({ ...INITIAL_TRACKER, seen: true, legStartedAt: t, lastFrameAt: t, lastMoveAt: t });
  it("本段 < 90% 不发；≥ 90% 且前方没有来得及的停靠 → 发", () => {
    const t = startedAt(0);
    assert.equal(shouldRemindRest(undefined, t, INITIAL_MEMO, 100 * 60_000, cfg), undefined);
    const r = shouldRemindRest(undefined, t, INITIAL_MEMO, 110 * 60_000, cfg);
    assert.ok(r);
    assert.equal(r.kind, "rest");
    assert.equal(r.drivenMin, 110);
  });
  it("前方计划停靠在剩余额度内能到 → 不催；来不及 → 催并带站名", () => {
    const t = { ...startedAt(0), lastFrameAt: 110 * 60_000 };
    const soon: NavTripProgress = { nextStopName: "徐州东服务区", remainingM: 8_000, remainingSec: 8 * 60, finished: false };
    assert.equal(shouldRemindRest(soon, t, INITIAL_MEMO, 110 * 60_000, cfg), undefined, "8 分钟后到，额度还有 10 分钟");
    const late: NavTripProgress = { ...soon, remainingSec: 20 * 60 };
    const r = shouldRemindRest(late, t, INITIAL_MEMO, 110 * 60_000, cfg);
    assert.equal(r?.nextStopName, "徐州东服务区");
    assert.equal(r?.remainingM, 8_000);
  });
  it("拒绝后本段静默、下一段恢复；hushed 同理", () => {
    const t = startedAt(0);
    assert.equal(shouldRemindRest(undefined, t, { ...INITIAL_MEMO, restDeclinedLeg: 0 }, 115 * 60_000, cfg), undefined);
    assert.ok(shouldRemindRest(undefined, { ...t, legIndex: 1 }, { ...INITIAL_MEMO, restDeclinedLeg: 0 }, 115 * 60_000, cfg));
    assert.equal(shouldRemindRest(undefined, t, { ...INITIAL_MEMO, hushedLeg: 0 }, 115 * 60_000, cfg), undefined);
  });
  it("位置陈旧时照发（只需要时钟），但不带距离", () => {
    const t = startedAt(0); // lastFrameAt=0，到 110 分时早已陈旧
    const r = shouldRemindRest({ nextStopName: "X", remainingM: 5_000, finished: false }, t, INITIAL_MEMO, 110 * 60_000, cfg);
    assert.ok(r);
    assert.equal(r.remainingM, undefined);
  });
});

describe("[F-62-04][F-62-05][F-62-07][F-62-13][AC-62-1][AC-62-2][AC-62-6][AC-62-7][AC-62-8] gateReminder / afterGate", () => {
  const stop = { kind: "stop" as const, stopName: "A", remainingM: 7_000, legIndex: 0 };
  const rest = { kind: "rest" as const, drivenMin: 110, legIndex: 0 };
  it("空闲 → speak；low 档停靠恒 card-only、连续驾驶仍 speak", () => {
    assert.equal(gateReminder(stop, INITIAL_TRACKER, INITIAL_MEMO, 0), "speak");
    assert.equal(gateReminder(stop, INITIAL_TRACKER, INITIAL_MEMO, 0, "low"), "card-only");
    assert.equal(gateReminder(rest, INITIAL_TRACKER, INITIAL_MEMO, 0, "low"), "speak");
  });
  it("在飞 → defer；顺延累计超过提前量一半 → card-only", () => {
    const memo: ReminderMemo = { ...INITIAL_MEMO, inFlight: true };
    assert.equal(gateReminder(stop, INITIAL_TRACKER, memo, 10_000), "defer");
    const deferred = afterGate(memo, stop, "defer", 10_000);
    assert.equal(deferred.deferredSince, 10_000);
    assert.equal(gateReminder(stop, INITIAL_TRACKER, deferred, 10_000 + 299_000), "defer");
    assert.equal(gateReminder(stop, INITIAL_TRACKER, deferred, 10_000 + 300_000), "card-only");
  });
  it("车速剧变 → defer", () => {
    const jumpy: TrackerState = { ...INITIAL_TRACKER, speedSamples: [80, 40] };
    assert.equal(gateReminder(stop, jumpy, INITIAL_MEMO, 0), "defer");
  });
  it("说出去 / 只卡片后：一站一次入 memo、顺延清空", () => {
    const m = afterGate({ ...INITIAL_MEMO, deferredSince: 5 }, stop, "speak", 9);
    assert.deepEqual(m.remindedStops, ["A"]);
    assert.equal(m.deferredSince, undefined);
    const m2 = afterGate(m, rest, "card-only", 10);
    assert.deepEqual(m2.remindedStops, ["A"], "连续驾驶提醒不进一站一次表");
  });
});

describe("[F-62-04][F-62-05][F-62-07][F-62-13][AC-62-1][AC-62-2][AC-62-6][AC-62-7][AC-62-8] reminderText", () => {
  it("停靠：ETA 由调用方传时刻；连续驾驶：上限进依据", () => {
    const t = reminderText({ kind: "stop", stopName: "云龙湖旅游景区", remainingM: 15_000, remainingSec: 590, reason: "rest", legIndex: 0 }, { etaClock: "14:20", constraintLine: "同行者约束：每 2 小时停一次" });
    assert.equal(t.body, "按计划在这歇一下 · 预计 14:20 到");
    const r = reminderText({ kind: "rest", drivenMin: 110, nextStopName: "徐州东服务区", remainingM: 8_000, legIndex: 0 }, { limitMin: 120 });
    assert.match(r.caption!, /每 2 小时 停一次 · 已到 92%/);
  });
});
