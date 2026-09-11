/**
 * [F-62-02][F-62-03][F-62-13][AC-62-7][AC-62-8] 跟车状态机（M77-05）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { NavTripProgress } from "../src/map";
import {
  advanceTracker,
  drivenMinutes,
  INITIAL_TRACKER,
  isDriving,
  isPositionStale,
  speedJump,
  type TrackerState,
} from "../src/hud/en-route-tracker";

const frame = (remainingM: number, extra: Partial<NavTripProgress> = {}): NavTripProgress => ({
  nextStopName: "云龙湖旅游景区",
  remainingM,
  finished: false,
  ...extra,
});

/** 每秒一帧、匀速 20 m/s（72 km/h）推进 n 帧。 */
function drive(state: TrackerState, from: number, frames: number, t0: number, stepM = 20, stepMs = 1000): { state: TrackerState; now: number } {
  let s = state;
  let now = t0;
  for (let i = 0; i < frames; i += 1) {
    now += stepMs;
    s = advanceTracker(s, frame(from - stepM * (i + 1)), now);
  }
  return { state: s, now };
}

describe("[F-62-02][F-62-03][F-62-13][AC-62-1][AC-62-7] advanceTracker", () => {
  it("首帧起算本段；匀速推进后差分车速 ≈ 72 km/h，样本窗口 5", () => {
    const s0 = advanceTracker(INITIAL_TRACKER, frame(20_000), 1_000);
    assert.equal(s0.legStartedAt, 1_000);
    assert.equal(s0.seen, true);
    const { state } = drive(s0, 20_000, 8, 1_000);
    assert.equal(state.speedSamples.length, 5);
    assert.ok(Math.abs(state.speedKmh! - 72) < 0.5, String(state.speedKmh));
  });

  it("越段：legIndex +1、本段计时重置、差分窗口清空", () => {
    const s0 = advanceTracker(INITIAL_TRACKER, frame(5_000), 1_000);
    const { state: s1, now } = drive(s0, 5_000, 3, 1_000);
    const s2 = advanceTracker(s1, frame(30_000, { arrivedStopName: "云龙湖旅游景区", nextStopName: "户部山" }), now + 1000);
    assert.equal(s2.legIndex, 1);
    assert.equal(s2.legStartedAt, now + 1000);
    assert.deepEqual(s2.speedSamples, []);
    assert.equal(s2.speedKmh, undefined);
  });

  it("remainingM 变大的帧不进差分（位置跳变）；其后恢复正常", () => {
    const s0 = advanceTracker(INITIAL_TRACKER, frame(10_000), 0);
    const s1 = advanceTracker(s0, frame(9_980), 1_000);
    const s2 = advanceTracker(s1, frame(12_000), 2_000); // 跳变
    assert.equal(s2.speedSamples.length, 1, "跳变帧不加样本");
    const s3 = advanceTracker(s2, frame(11_980), 3_000);
    assert.equal(s3.speedSamples.length, 2);
  });

  it("20 s 无帧 → 位置陈旧；从未收到帧也算陈旧", () => {
    assert.equal(isPositionStale(INITIAL_TRACKER, 0), true);
    const s = advanceTracker(INITIAL_TRACKER, frame(10_000), 0);
    assert.equal(isPositionStale(s, 19_999), false);
    assert.equal(isPositionStale(s, 20_000), true);
  });

  it("行驶态：从未收到帧按行车态；30 s 距离不变 → 不在开；finished → 不在开", () => {
    assert.equal(isDriving(INITIAL_TRACKER, 0), true);
    const s = advanceTracker(INITIAL_TRACKER, frame(10_000), 0);
    assert.equal(isDriving(s, 29_000), true);
    const still = advanceTracker(s, frame(10_000), 31_000); // 距离没变
    assert.equal(isDriving(still, 31_000), false);
    const done = advanceTracker(s, frame(0, { finished: true, nextStopName: undefined }), 5_000);
    assert.equal(isDriving(done, 5_000), false);
  });

  it("驻车 120 s → 本段计时滚动重置", () => {
    const s0 = advanceTracker(INITIAL_TRACKER, frame(10_000), 0);
    const parked = advanceTracker(s0, frame(10_000), 120_000);
    assert.equal(parked.legStartedAt, 120_000);
    assert.equal(drivenMinutes(parked, 120_000), 0);
    // 没停够 → 不重置
    const brief = advanceTracker(s0, frame(10_000), 60_000);
    assert.equal(brief.legStartedAt, 0);
    assert.equal(Math.round(drivenMinutes(brief, 60_000)), 1);
  });

  it("speedJump：最近两帧差分之差", () => {
    const s: TrackerState = { ...INITIAL_TRACKER, speedSamples: [70, 72, 30] };
    assert.equal(speedJump(s), 42);
    assert.equal(speedJump({ ...INITIAL_TRACKER, speedSamples: [70] }), 0);
  });
});
