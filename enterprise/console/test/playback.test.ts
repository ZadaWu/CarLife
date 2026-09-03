/**
 * 大屏轮次回放引擎。
 *
 * 这里断言的是**时序**：什么时候放下一条、放完之后去哪、用户按了按钮之后
 * 状态该长什么样。回放会出错的地方全在这上面——图长什么样是 `projectRun` 的事，
 * 那边另有测试。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  advance,
  backToLive,
  currentTurn,
  gapBefore,
  HOLD_MS,
  livePlayback,
  MAX_GAP,
  MIN_GAP,
  playTurn,
  replayCurrent,
  replayPlayback,
  stepTurn,
  togglePlay,
  turnsOf,
  type PlaybackTurn,
} from "../src/pages/demo/playback";

const ev = (turnId: string | undefined, at: number, kind = "span") => ({
  kind,
  at,
  turnId,
  data: {},
});

/** 造一轮：n 条事件，间隔 gap 毫秒。 */
function turn(turnId: string, n: number, from = 0, gap = 600): PlaybackTurn {
  const events = Array.from({ length: n }, (_, i) => ev(turnId, from + i * gap));
  return { turnId, events, startedAt: events[0].at, endedAt: events[events.length - 1].at };
}

describe("轮次切分", () => {
  it("按 turnId 归组，按首事件时间排序", () => {
    const turns = turnsOf([ev("t2", 100), ev("t1", 10), ev("t2", 120), ev("t1", 20)]);
    assert.deepEqual(turns.map((t) => t.turnId), ["t1", "t2"]);
    assert.deepEqual(turns[0].events.map((e) => e.at), [10, 20]);
  });

  it("**并行 fan-out 交错到达也要归回同一轮**——按相邻切段会把一轮切成好几段", () => {
    const turns = turnsOf([ev("t1", 1), ev("t2", 2), ev("t1", 3), ev("t2", 4), ev("t1", 5)]);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].events.length, 3);
  });

  it("没有 turnId 的事件整条丢掉——它不属于任何一轮，混进来就是一条没走过的路径", () => {
    const turns = turnsOf([ev(undefined, 1), ev("t1", 2)]);
    assert.deepEqual(turns.map((t) => t.turnId), ["t1"]);
    assert.equal(turns[0].events.length, 1);
  });
});

describe("事件间隔", () => {
  const t = turn("t1", 3, 0, 600);

  it("第一条不等", () => {
    assert.equal(gapBefore(t, 0), 0);
  });

  it("真实间隔压缩后落在 [MIN, MAX] 之间——快慢差别要留住，那正是大屏要讲的事", () => {
    assert.equal(gapBefore(turn("t1", 2, 0, 1_200), 1), 200); // 1200 / 6
    assert.equal(gapBefore(turn("t1", 2, 0, 3_000), 1), 500); // 3000 / 6
  });

  it("**同毫秒到达的一批也要一条条放**，否则等于没回放", () => {
    const burst = turn("t1", 3, 0, 0);
    assert.equal(gapBefore(burst, 1), MIN_GAP);
  });

  it("**真实里等 30 秒的那一步不能让大屏停 30 秒**", () => {
    const slow = turn("t1", 2, 0, 30_000);
    assert.equal(gapBefore(slow, 1), MAX_GAP);
  });
});

describe("推进", () => {
  const turns = [turn("t1", 3, 0, 600), turn("t2", 2, 10_000, 600)];

  it("live 模式不由本模块推进（画的永远是最新那一轮）", () => {
    const pb = livePlayback(0);
    assert.equal(advance(pb, turns, 10_000), pb);
    assert.equal(currentTurn(pb, turns)?.turnId, "t2");
  });

  it("没到间隔就原样返回**同一个对象**——调用方据此不重渲染", () => {
    const pb = { ...replayPlayback(turns, 0), cursor: 1 };
    assert.equal(advance(pb, turns, 50), pb);
  });

  it("到了间隔放一条，且一次只放一条（积压不许一口气补齐）", () => {
    const pb = { ...replayPlayback(turns, 0), cursor: 1 };
    const next = advance(pb, turns, 10_000);
    assert.equal(next.cursor, 2);
  });

  it("暂停时不推进", () => {
    const pb = { ...replayPlayback(turns, 0), playing: false };
    assert.equal(advance(pb, turns, 10_000), pb);
  });

  it("一轮放完先停留 HOLD_MS，再走下一轮", () => {
    const done = { ...replayPlayback(turns, 0), cursor: 3, lastAt: 0 };
    assert.equal(advance(done, turns, HOLD_MS - 1).turnId, "t1");
    const moved = advance(done, turns, HOLD_MS);
    assert.equal(moved.turnId, "t2");
    assert.equal(moved.cursor, 0);
  });

  it("放到最后一轮：不循环就停下，循环就从第一轮再来", () => {
    const last = { ...replayPlayback(turns, 0), turnId: "t2", cursor: 2, lastAt: 0 };
    assert.equal(advance(last, turns, HOLD_MS).playing, false);
    const looped = advance({ ...last, loop: true }, turns, HOLD_MS);
    assert.equal(looped.turnId, "t1");
    assert.equal(looped.playing, true);
  });

  it("固定某一轮时放完不往下走；开了循环就循环这一轮", () => {
    const pinned = { ...replayPlayback(turns, 0), pinned: true, cursor: 3, lastAt: 0 };
    assert.equal(advance(pinned, turns, HOLD_MS).playing, false);
    const looped = advance({ ...pinned, loop: true }, turns, HOLD_MS);
    assert.equal(looped.turnId, "t1");
    assert.equal(looped.cursor, 0);
  });

  it("**实时会话的插播重播放完回到跟随**——否则大屏停在一张旧图上，看起来像系统很闲", () => {
    const pb = { ...replayCurrent(livePlayback(0), turns, 0), cursor: 2, lastAt: 0 };
    const back = advance(pb, turns, HOLD_MS);
    assert.equal(back.mode, "live");
    assert.equal(back.playing, true);
  });

  it("**正在放的那一轮不见了就从头开始，不静默停住**（实时缓冲会淘汰老轮次）", () => {
    const pb = { ...replayPlayback(turns, 0), turnId: "gone", cursor: 5 };
    const next = advance(pb, turns, 1_000);
    assert.equal(next.turnId, "t1");
    assert.equal(next.cursor, 0);
  });
});

describe("控制条动作", () => {
  const turns = [turn("t1", 3), turn("t2", 2, 10_000), turn("t3", 4, 20_000)];

  it("点某一轮 = 从头放它并固定住", () => {
    const pb = playTurn(livePlayback(0), "t2", 100);
    assert.equal(pb.mode, "replay");
    assert.equal(pb.turnId, "t2");
    assert.equal(pb.cursor, 0);
    assert.equal(pb.pinned, true);
  });

  it("从实时点重播：不固定、放完回实时", () => {
    const pb = replayCurrent(livePlayback(0), turns, 100);
    assert.equal(pb.turnId, "t3"); // 实时跟的是最新一轮
    assert.equal(pb.pinned, false);
    assert.equal(pb.returnToLive, true);
  });

  it("**手动翻轮一律固定住**——翻过去又被自动播走等于这个按钮没用", () => {
    const pb = stepTurn(replayPlayback(turns, 0), turns, 1, 100);
    assert.equal(pb.turnId, "t2");
    assert.equal(pb.pinned, true);
  });

  it("翻到头就停在两端，不绕回去", () => {
    const first = stepTurn(replayPlayback(turns, 0), turns, -1, 100);
    assert.equal(first.turnId, "t1");
    const last = stepTurn({ ...replayPlayback(turns, 0), turnId: "t3" }, turns, 1, 100);
    assert.equal(last.turnId, "t3");
  });

  it("在实时里按暂停 = 冻结在**当前这一轮的完整画面**，不是从头放", () => {
    const pb = togglePlay(livePlayback(0), turns, 100);
    assert.equal(pb.playing, false);
    assert.equal(pb.turnId, "t3");
    assert.equal(pb.cursor, turns[2].events.length);
  });

  it("从「暂停的实时」继续 = 回到跟随，而不是接着放这一轮的余下部分", () => {
    const paused = togglePlay(livePlayback(0), turns, 100);
    assert.equal(togglePlay(paused, turns, 200).mode, "live");
  });

  it("历史回放的暂停/继续只切 playing，不换轮次", () => {
    const pb = { ...replayPlayback(turns, 0), turnId: "t2", cursor: 1 };
    const paused = togglePlay(pb, turns, 100);
    assert.equal(paused.playing, false);
    assert.equal(paused.turnId, "t2");
    assert.equal(togglePlay(paused, turns, 200).cursor, 1);
  });

  it("回到跟随实时会把固定与插播标记一起清掉", () => {
    const pb = backToLive(playTurn(livePlayback(0), "t1", 100), 200);
    assert.equal(pb.mode, "live");
    assert.equal(pb.pinned, false);
    assert.equal(pb.returnToLive, false);
  });

  it("循环开关跨动作保留——它是用户的偏好，不该被翻轮重置", () => {
    const pb = playTurn({ ...livePlayback(0), loop: true }, "t1", 100);
    assert.equal(pb.loop, true);
    assert.equal(backToLive(pb, 200).loop, true);
  });
});
