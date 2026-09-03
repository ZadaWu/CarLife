/**
 * 跟车位置源（M31-02）。
 *
 * 这一层的两个错法都不报错：倍速悄悄改了路径（车走了一条没人规划过的线），
 * 以及拿动画常数冒充车程（"预计还有 3 分钟"其实是编的）。都在这里钉住。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createSimulatedNavSource,
  etaToNextStop,
  type NavLeg,
  type NavPosition,
} from "../src/map/nav-position";

/** 一条自西向东的直路，约 1 公里。 */
const STRAIGHT: Array<[number, number]> = [
  [113.26, 23.13],
  [113.265, 23.13],
  [113.27, 23.13],
];

/**
 * 手动时钟：tick 与"现在几点"都攥在测试手里。
 *
 * 两者必须一起假：位移按真实经过时间算（见 `subscribe` 的说明），
 * 只假 tick 不假时钟的话每次推进量是 0，测什么都过不了。
 */
function manualClock(startMs = 1_000_000) {
  const cbs: Array<() => void> = [];
  let t = startMs;
  return {
    now: () => t,
    schedule: (cb: () => void) => {
      cbs.push(cb);
      return () => {
        const i = cbs.indexOf(cb);
        if (i >= 0) cbs.splice(i, 1);
      };
    },
    /** 推进 `ms` 毫秒并触发一次 tick，共 `n` 次。 */
    tick(n = 1, ms = 1000) {
      for (let i = 0; i < n; i += 1) {
        t += ms;
        for (const cb of [...cbs]) cb();
      }
    },
    /** 只推进时间**不**触发 tick——模拟定时器被降频/漏拍。 */
    skip(ms: number) {
      t += ms;
    },
  };
}

function collect(legs: NavLeg[], opts: { speedup?: number; tickMs?: number } = {}) {
  const clock = manualClock();
  const src = createSimulatedNavSource(legs, {
    ...opts,
    schedule: clock.schedule,
    now: clock.now,
  });
  const seen: NavPosition[] = [];
  const stop = src.subscribe((p) => seen.push(p));
  return { clock, seen, stop };
}

describe("模拟位置源（M31-02）", () => {
  it("**订阅即回一帧**——等第一个 tick 才出现的车标看起来像没反应", () => {
    const { seen } = collect([{ path: STRAIGHT, durationS: 100 }]);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.at, STRAIGHT[0]);
    assert.equal(seen[0]!.legIndex, 0);
    assert.equal(seen[0]!.progressInLeg, 0);
  });

  it("沿路推进，进度单调不回头", () => {
    const { clock, seen } = collect([{ path: STRAIGHT, durationS: 100 }], { tickMs: 1000 });
    clock.tick(5, 1000);
    assert.ok(seen.length >= 6);
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(
        seen[i]!.progressInLeg >= seen[i - 1]!.progressInLeg,
        `第 ${i} 帧退回去了：${seen[i - 1]!.progressInLeg} → ${seen[i]!.progressInLeg}`,
      );
    }
    assert.ok(seen[seen.length - 1]!.progressInLeg > 0);
  });

  /*
   * 真实事故（走查实测）：浏览器把不可见标签页的 setInterval 降到 1Hz，
   * 而当时的实现按"一个 tick = tickMs"累加，于是屏幕上写着「演示车速 ×60」、
   * 实际只跑到 ×12。**角标是一句对用户的声明**，不能因为定时器不准就悄悄失真。
   */
  it("**定时器漏拍时位移要补回来**——不然屏幕上的 ×N 是假的", () => {
    const punctual = collect([{ path: STRAIGHT, durationS: 100 }], { tickMs: 1000, speedup: 1 });
    const throttled = collect([{ path: STRAIGHT, durationS: 100 }], { tickMs: 1000, speedup: 1 });
    punctual.clock.tick(10, 1000); // 准时：10 拍 × 1 秒
    throttled.clock.skip(9000); // 降频：9 秒没人叫醒它……
    throttled.clock.tick(1, 1000); // ……然后补一拍，共 10 秒
    assert.equal(
      throttled.seen[throttled.seen.length - 1]!.progressInLeg,
      punctual.seen[punctual.seen.length - 1]!.progressInLeg,
      "同样过了 10 秒，走过的路必须一样多",
    );
  });

  /*
   * 倍速这条是本文件最要紧的一条。它错了不会报错：车会跑在一条
   * 没人规划过的线上，而屏幕上看起来完全正常。
   */
  it("**倍速只压缩时间，不改变路径**——同一进度落在同一个点上", () => {
    const a = collect([{ path: STRAIGHT, durationS: 100 }], { tickMs: 1000, speedup: 1 });
    const b = collect([{ path: STRAIGHT, durationS: 100 }], { tickMs: 1000, speedup: 10 });
    a.clock.tick(10, 1000); // 10 秒 ×1 = 走了 10%
    b.clock.tick(1, 1000); //   1 秒 ×10 = 也是 10%
    const pa = a.seen[a.seen.length - 1]!;
    const pb = b.seen[b.seen.length - 1]!;
    assert.ok(Math.abs(pa.progressInLeg - pb.progressInLeg) < 1e-9);
    assert.ok(Math.abs(pa.at[0] - pb.at[0]) < 1e-9);
    assert.ok(Math.abs(pa.at[1] - pb.at[1]) < 1e-9);
  });

  it("段序单调：走完第一段才进第二段", () => {
    const second: Array<[number, number]> = [
      [113.27, 23.13],
      [113.28, 23.14],
    ];
    const { clock, seen } = collect(
      [
        { path: STRAIGHT, durationS: 10 },
        { path: second, durationS: 10 },
      ],
      { tickMs: 1000 },
    );
    clock.tick(15, 1000);
    const idx = seen.map((p) => p.legIndex);
    for (let i = 1; i < idx.length; i += 1) {
      assert.ok(idx[i]! >= idx[i - 1]!, "段号退回去了");
    }
    assert.equal(idx[idx.length - 1], 1, "15 秒之后应该在第二段");
  });

  it("**走到终点就停住，不循环**——循环等于每隔一会儿谎报一次位置", () => {
    const { clock, seen } = collect([{ path: STRAIGHT, durationS: 5 }], { tickMs: 1000 });
    clock.tick(20, 1000);
    const last = seen[seen.length - 1]!;
    assert.equal(last.finished, true);
    assert.equal(last.progressInLeg, 1);
    assert.deepEqual(last.at, STRAIGHT[STRAIGHT.length - 1]);
  });

  it("没有可跟的路时不编一个位置，直接置 finished", () => {
    const { seen } = collect([{ path: [[113.26, 23.13]], durationS: 10 }]);
    assert.equal(seen[0]!.finished, true);
  });

  it("退订之后不再推位置", () => {
    const { clock, seen, stop } = collect([{ path: STRAIGHT, durationS: 100 }], { tickMs: 1000 });
    stop();
    const n = seen.length;
    clock.tick(3, 1000);
    assert.equal(seen.length, n);
  });

  it("朝向：自西向东约等于 90 度", () => {
    const { clock, seen } = collect([{ path: STRAIGHT, durationS: 100 }], { tickMs: 1000 });
    clock.tick(1, 1000);
    const h = seen[seen.length - 1]!.headingDeg;
    assert.ok(h !== undefined && Math.abs(h - 90) < 1, `朝向不对：${String(h)}`);
  });
});

describe("到下一站还有多远/多久（M31-02）", () => {
  it("剩余米数随进度下降", () => {
    const legs: NavLeg[] = [{ path: STRAIGHT, durationS: 100 }];
    const start = etaToNextStop(legs, { at: STRAIGHT[0]!, legIndex: 0, progressInLeg: 0, finished: false });
    const half = etaToNextStop(legs, { at: STRAIGHT[1]!, legIndex: 0, progressInLeg: 0.5, finished: false });
    assert.ok(start.remainingM > 900 && start.remainingM < 1100, `约 1 公里：${start.remainingM}`);
    assert.ok(Math.abs(half.remainingM - start.remainingM / 2) < 20);
  });

  /*
   * 与 `scheduleStops` 同一条红线：拿不到真实车程就一个时刻都不给。
   * 这里最容易犯的错是把 FALLBACK_LEG_S（动画节奏用的常数）当车程播出去。
   */
  it("**车程没查到的段不给时间**，只给距离", () => {
    const legs: NavLeg[] = [{ path: STRAIGHT }]; // 没有 durationS = 直线回落
    const eta = etaToNextStop(legs, { at: STRAIGHT[0]!, legIndex: 0, progressInLeg: 0, finished: false });
    assert.equal(eta.remainingSec, undefined);
    assert.ok(eta.remainingM > 0);
  });

  it("有真实车程时才给时间，且随进度下降", () => {
    const legs: NavLeg[] = [{ path: STRAIGHT, durationS: 600 }];
    const eta = etaToNextStop(legs, { at: STRAIGHT[1]!, legIndex: 0, progressInLeg: 0.25, finished: false });
    assert.equal(eta.remainingSec, 450);
  });

  it("段号越界时不抛错，也不给假数字", () => {
    const eta = etaToNextStop([{ path: STRAIGHT, durationS: 10 }], {
      at: STRAIGHT[0]!,
      legIndex: 9,
      progressInLeg: 0,
      finished: false,
    });
    assert.equal(eta.remainingM, 0);
    assert.equal(eta.remainingSec, undefined);
  });
});
