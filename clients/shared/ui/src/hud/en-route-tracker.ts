/**
 * 跟车进度的状态机（施工单 M77-05，FL-62 F-62-02 / F-62-03 / F-62-13）。
 *
 * # 吃既有的 `NavTripProgress`，不另建位置源
 *
 * `AmapTripLayer` 每帧回调 `{ nextStopName, remainingM, remainingSec?, arrivedStopName?, finished }`。
 * 这一层只做三件事：数段（越段那一帧 `arrivedStopName` 给一次）、算车速（相邻帧 `remainingM` 差分的滑动均值）、
 * 判"在开吗 / 位置还新鲜吗"。**没有车速字段就差分**——它只用于"车速剧变"顺延判定，不上屏。
 *
 * # 行驶态是兜底，不是真相
 *
 * `vehicle_signal.rs` 还是空的（FL-06 F-06-01）。这里按"最近 30 s 内距下一站的距离有变化"判在开；
 * 信号落地后换这一个函数的实现，接口不变。信号与位置都没有时**默认按行车态**（AC-06-1 的既有纪律）——
 * 所以 `isDriving` 在从未收到帧时返回 true。
 *
 * # 纯函数：`nowMs` 全部入参
 *
 * 不读墙钟（M64 红线），`node:test` 能把每条边界钉死。
 */

import type { NavTripProgress } from "../map";

export interface TrackerState {
  /** 当前在第几段（0 起）。越过段尾那一帧 +1。 */
  legIndex: number;
  /** 本段开始行驶的时刻；驻车 ≥ `parkedMs` 后滚动重置。 */
  legStartedAt?: number;
  lastFrameAt?: number;
  lastRemainingM?: number;
  /** 最近一次距离有变化的时刻——"在开"的判据。 */
  lastMoveAt?: number;
  /** 最近 5 帧的差分车速（km/h）。 */
  speedSamples: number[];
  speedKmh?: number;
  finished: boolean;
  /** 收到过至少一帧。 */
  seen: boolean;
}

export interface TrackerConfig {
  /** 超过这么久没帧 → 位置陈旧。 */
  staleMs: number;
  /** 超过这么久距离没变 → 不在开。 */
  quietMs: number;
  /** 不在开持续这么久 → 本段计时重置（驻车）。 */
  parkedMs: number;
  /** 差分样本窗口。 */
  speedWindow: number;
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = { staleMs: 20_000, quietMs: 30_000, parkedMs: 120_000, speedWindow: 5 };

export const INITIAL_TRACKER: TrackerState = { legIndex: 0, speedSamples: [], finished: false, seen: false };

export function advanceTracker(
  prev: TrackerState,
  frame: NavTripProgress,
  nowMs: number,
  cfg: TrackerConfig = DEFAULT_TRACKER_CONFIG,
): TrackerState {
  let next: TrackerState = { ...prev, seen: true, lastFrameAt: nowMs, finished: frame.finished };
  if (prev.legStartedAt === undefined) next.legStartedAt = nowMs;

  // 越段：段号 +1、本段计时从现在起、差分窗口清空（上一段的尾巴不该算进新段的车速）。
  if (frame.arrivedStopName) {
    next = { ...next, legIndex: prev.legIndex + 1, legStartedAt: nowMs, speedSamples: [], speedKmh: undefined, lastRemainingM: undefined };
  }

  const moved = prev.lastRemainingM === undefined || prev.lastRemainingM !== frame.remainingM;
  if (moved) next.lastMoveAt = nowMs;

  // 车速：只在距离**变小**的帧做差分；变大（越段重置 / 位置跳变）那一帧丢弃。
  if (
    !frame.arrivedStopName &&
    prev.lastRemainingM !== undefined &&
    prev.lastFrameAt !== undefined &&
    frame.remainingM < prev.lastRemainingM &&
    nowMs > prev.lastFrameAt
  ) {
    const dh = (nowMs - prev.lastFrameAt) / 3_600_000;
    const dkm = (prev.lastRemainingM - frame.remainingM) / 1000;
    const v = dkm / dh;
    if (Number.isFinite(v) && v >= 0 && v < 250) {
      const samples = [...prev.speedSamples, v].slice(-cfg.speedWindow);
      next.speedSamples = samples;
      next.speedKmh = Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 10) / 10;
    }
  }
  next.lastRemainingM = frame.remainingM;

  // 驻车重置：不在开持续 ≥ parkedMs，本段计时滚动到现在（下一段从驶离那一刻算）。
  if (next.lastMoveAt !== undefined && nowMs - next.lastMoveAt >= cfg.parkedMs) {
    next.legStartedAt = nowMs;
  }
  return next;
}

/** 在开吗。从未收到帧时按行车态（保守默认）。 */
export function isDriving(state: TrackerState, nowMs: number, cfg: TrackerConfig = DEFAULT_TRACKER_CONFIG): boolean {
  if (!state.seen) return true;
  if (state.finished) return false;
  if (state.lastMoveAt === undefined) return false;
  return nowMs - state.lastMoveAt < cfg.quietMs;
}

/** 位置陈旧：从未收到帧，或最近一帧太久以前。 */
export function isPositionStale(state: TrackerState, nowMs: number, cfg: TrackerConfig = DEFAULT_TRACKER_CONFIG): boolean {
  if (state.lastFrameAt === undefined) return true;
  return nowMs - state.lastFrameAt >= cfg.staleMs;
}

/** 本段已开多少分钟；没开始过返回 0。 */
export function drivenMinutes(state: TrackerState, nowMs: number): number {
  if (state.legStartedAt === undefined) return 0;
  return Math.max(0, (nowMs - state.legStartedAt) / 60_000);
}

/** 最近两帧差分车速的变化量（km/h）；样本不足返回 0。 */
export function speedJump(state: TrackerState): number {
  const n = state.speedSamples.length;
  if (n < 2) return 0;
  return Math.abs(state.speedSamples[n - 1]! - state.speedSamples[n - 2]!);
}
