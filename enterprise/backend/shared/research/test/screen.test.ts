/**
 * 入库前筛选（施工单 M82-01）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { emptyTally, screenUnit, tally, type ScreenContext } from "../src/screen";
import { unitizeTrip, unitizeTurn, type TurnMessage } from "../src/unitize";

const T0 = 1_757_000_000_000;

const ctx = (over: Partial<ScreenContext> = {}): ScreenContext => ({
  excludedUserIds: new Set<string>(),
  knownFingerprints: new Set<string>(),
  ...over,
});

const turn = (over: Partial<TurnMessage> = {}) =>
  unitizeTurn({
    userMessage: {
      id: "m1",
      sessionId: "s1",
      turnId: "t1",
      role: "user",
      source: "voice",
      content: "冬天掉电快",
      ts: T0,
      cancelled: false,
      asrEngine: "ark",
      ...over,
    },
    trace: [],
    userId: "u1",
  });

test("正常一轮留下", () => {
  assert.deepEqual(screenUnit(turn(), ctx()), { keep: true });
});

test("被打断的半句：reason = cancelled", () => {
  assert.deepEqual(screenUnit(turn({ cancelled: true }), ctx()), { keep: false, reason: "cancelled" });
});

test("fake 档是我们自己造的脚本，不是车主说的话", () => {
  assert.deepEqual(screenUnit(turn({ asrEngine: "fake" }), ctx()), { keep: false, reason: "fake-llm" });
});

test("mock 档转的是真人真声，留", () => {
  assert.equal(screenUnit(turn({ asrEngine: "mock" }), ctx()).keep, true);
});

test("空 ASR：只有空白也算空", () => {
  assert.deepEqual(screenUnit(turn({ content: "   \n " }), ctx()), { keep: false, reason: "empty-asr" });
});

test("research_excluded 的账号先于内容判断被剔除", () => {
  const excluded = ctx({ excludedUserIds: new Set(["u1"]) });
  // 这一条同时也是 cancelled，但权利判断更根本，reason 必须是 excluded-user。
  assert.deepEqual(screenUnit(turn({ cancelled: true }), excluded), { keep: false, reason: "excluded-user" });
});

test("同指纹第二次：duplicate", () => {
  const u = turn();
  assert.deepEqual(screenUnit(u, ctx({ knownFingerprints: new Set([u.fingerprint]) })), {
    keep: false,
    reason: "duplicate",
  });
});

test("行为单元不过内容三筛，只过排除名单与去重", () => {
  const b = unitizeTrip({
    id: "trip1",
    userId: "u1",
    vin: null,
    startedAt: new Date(T0),
    endedAt: new Date(T0 + 60000),
    distanceKm: 1,
    roadType: null,
    ambientTempC: null,
    observedRangeKm: null,
    chargeStartSoc: null,
    chargeEndSoc: null,
  });
  assert.equal(screenUnit(b, ctx()).keep, true);
  assert.equal(screenUnit(b, ctx({ excludedUserIds: new Set(["u1"]) })).reason, "excluded-user");
});

test("账目按原因分列——一个窗筛掉 90% 时要看得出是哪一类", () => {
  const t = emptyTally();
  tally(t, screenUnit(turn(), ctx()));
  tally(t, screenUnit(turn({ cancelled: true }), ctx()));
  tally(t, screenUnit(turn({ asrEngine: "fake" }), ctx()));
  assert.equal(t.kept, 1);
  assert.equal(t.dropped.cancelled, 1);
  assert.equal(t.dropped["fake-llm"], 1);
  assert.equal(t.dropped.duplicate, 0);
});
