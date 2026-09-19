/**
 * 分析单位（施工单 M82-01）。
 *
 * 两条断言值得单独说明为什么钉住：
 *  - guard 命中 → `role = 'boundary'`：被拦下来的那个诉求才是这轮真正的信息。
 *  - 缺测的 `ambientTempC` 是 `null` 不是 0：零度与"没记温度"在低温衰减
 *    那条曲线上是完全相反的证据，`?? 0` 会静默造出一批极冷行程。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { FOLLOW_UP_WINDOW_MS, unitizeTrip, unitizeTurn, type TripRow, type TurnMessage } from "../src/unitize";

const T0 = 1_757_000_000_000;

const userMsg = (over: Partial<TurnMessage> = {}): TurnMessage => ({
  id: "m1",
  sessionId: "s1",
  turnId: "t1",
  role: "user",
  source: "voice",
  content: "这车怎么一到冬天就掉电这么快",
  ts: T0,
  cancelled: false,
  asrEngine: "ark",
  ...over,
});

test("guard 判 deny 的一轮：guardHit 为真且角色是 boundary", () => {
  const u = unitizeTurn({
    userMessage: userMsg(),
    trace: [
      { kind: "route", at: T0, data: { agent: "ownership", reason: "用车问题" } },
      { kind: "tool_call", at: T0 + 10, data: { name: "vehicle_status", status: "ok" } },
      { kind: "guard", at: T0 + 20, data: { tool: "tire_pressure_set", decision: "deny", reason: "硬禁范畴" } },
    ],
    userId: "u1",
    vin: "LSVAA1234567890AB",
  });

  assert.equal(u.context.guardHit, true);
  assert.equal(u.role, "boundary");
  // 拦截优先于工具调用：这一轮确实调过工具，但它不是 diagnostics。
  assert.deepEqual(u.context.tools, ["vehicle_status"]);
});

test("guard 全量审计里的 allow 不算命中——否则每一轮都是 boundary", () => {
  const u = unitizeTurn({
    userMessage: userMsg(),
    trace: [
      { kind: "route", at: T0, data: { agent: "ownership" } },
      { kind: "guard", at: T0 + 5, data: { tool: "appointment", decision: "allow", reason: "非敏感动作" } },
    ],
    userId: "u1",
  });
  assert.equal(u.context.guardHit, false);
  assert.equal(u.role, "discovery");
});

test("needs_confirmation 记成 interrupted 而不是 guardHit", () => {
  const u = unitizeTurn({
    userMessage: userMsg(),
    trace: [{ kind: "guard", at: T0, data: { decision: "needs_confirmation" } }],
    userId: "u1",
  });
  assert.equal(u.context.interrupted, true);
  assert.equal(u.context.guardHit, false);
});

test("route 取第一次，工具去重且保首次调用顺序", () => {
  const u = unitizeTurn({
    userMessage: userMsg(),
    trace: [
      { kind: "route", at: T0, data: { agent: "ownership" } },
      { kind: "tool_call", at: T0 + 1, data: { name: "b" } },
      { kind: "tool_call", at: T0 + 2, data: { name: "a" } },
      { kind: "tool_call", at: T0 + 3, data: { name: "b" } },
      { kind: "route", at: T0 + 4, data: { agent: "service" } },
    ],
    userId: "u1",
  });
  assert.equal(u.context.route, "ownership");
  assert.deepEqual(u.context.tools, ["b", "a"]);
});

test("followUp 是启发式：同 route 且在 5 分钟窗内才算", () => {
  const base = { userMessage: userMsg(), trace: [{ kind: "route", at: T0, data: { agent: "ownership" } }], userId: "u1" };

  const inWindow = unitizeTurn({ ...base, nextTurn: { at: T0 + FOLLOW_UP_WINDOW_MS - 1, route: "ownership" } });
  assert.equal(inWindow.context.followUp, true);

  const tooLate = unitizeTurn({ ...base, nextTurn: { at: T0 + FOLLOW_UP_WINDOW_MS + 1, route: "ownership" } });
  assert.equal(tooLate.context.followUp, false);

  const otherRoute = unitizeTurn({ ...base, nextTurn: { at: T0 + 1000, route: "buying" } });
  assert.equal(otherRoute.context.followUp, false);

  // 没有下一轮 = 没有追问，不是"未知"。
  assert.equal(unitizeTurn(base).context.followUp, false);
});

test("话语单元不落原文：rawText 交给取数层脱敏，本层原样带出", () => {
  const u = unitizeTurn({ userMessage: userMsg({ content: "打 13800138000 给我" }), trace: [], userId: "u1" });
  assert.equal(u.rawText, "打 13800138000 给我");
  assert.equal(u.displayLevel, "internal-redacted");
  assert.equal(u.sourceId, "messages");
});

const trip = (over: Partial<TripRow> = {}): TripRow => ({
  id: "trip1",
  userId: "u1",
  vin: "LSVAA1234567890AB",
  startedAt: new Date(T0),
  endedAt: new Date(T0 + 30 * 60 * 1000),
  distanceKm: 18.4,
  roadType: "city",
  ambientTempC: null,
  observedRangeKm: null,
  chargeStartSoc: null,
  chargeEndSoc: null,
  ...over,
});

test("缺测的 ambientTempC 是 null 不是 0", () => {
  const b = unitizeTrip(trip());
  assert.equal(b.features.ambientTempC, null);
  assert.notEqual(b.features.ambientTempC, 0);
  assert.equal(b.features.durationMin, 30);
  assert.equal(b.role, "behavior");
});

test("零度是零度：0 要原样留住", () => {
  assert.equal(unitizeTrip(trip({ ambientTempC: 0 })).features.ambientTempC, 0);
});

test("SOC 两端缺一即 null——单端说明不了充了多少", () => {
  assert.equal(unitizeTrip(trip({ chargeStartSoc: 20 })).features.socDelta, null);
  assert.equal(unitizeTrip(trip({ chargeStartSoc: 20, chargeEndSoc: 80 })).features.socDelta, 60);
});

test("同一条原始记录切两次得到同一个指纹（跨窗重叠靠它挡）", () => {
  assert.equal(unitizeTrip(trip()).fingerprint, unitizeTrip(trip()).fingerprint);
  assert.notEqual(unitizeTrip(trip()).fingerprint, unitizeTrip(trip({ id: "trip2" })).fingerprint);
});
