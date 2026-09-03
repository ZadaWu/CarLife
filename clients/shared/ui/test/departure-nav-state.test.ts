/**
 * 出发卡「开始导航」三态状态机（施工单 M66-04；2026-09-02 随状态机从 cockpit 上提到这里，两端共用）。
 *
 * 两个方向都会伤人：判松了是方案没到就放人走（带不上休息点还以为带了），判紧了是 60 s 后按钮还灰着
 * （降级的定义就是"和今天一样能用"）。全部是纯函数，秒数来自状态里的 now，不读时钟。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { NavPlan } from "@carlife/shared";

import {
  IDLE_NAV_STATE,
  NAV_PLAN_BUDGET_MS,
  applyResponse,
  markPlanningVisible,
  navButtonState,
  navHint,
  navLaunchFrom,
  startPlanning,
  tickPlanning,
} from "../src/departure/nav-state";

/** 点击 → 动画放完 → 卡片露面。计时与降级都从最后这一刻起算（走查 2026-09-02）。 */
const visibleAt = (t: number) => markPlanningVisible(startPlanning(t0), t);

const t0 = 1_000_000;
const target = { lat: 30.2419, lon: 120.0987, name: "灵隐寺" };
const PLAN: NavPlan = {
  origin: { lat: 31.23, lon: 121.47, source: "fix" },
  destination: { name: "灵隐寺", lat: 30.2419, lon: 120.0987 },
  strategy: "less_toll",
  strategyReason: "按你平时省钱的偏好",
  summary: { distanceKm: 186.5, durationMin: 209, tollYuan: 0 },
  waypoints: [{ name: "下沙服务区", lat: 30.307762, lon: 120.365516, atMinute: 143 }],
  legMinutes: [143, 66],
  constraints: [],
  caveats: [],
  computedAt: "2026-09-02T08:00:00.000Z",
};

test("[F-18-16][AC-18-11] 规划中：禁用且显示已等秒数（从卡片露面算），59.999 s 仍在规划", () => {
  // 动画放了 18.9 秒才出卡；那段时间车主看的是动画，不算他在等。
  const shown = visibleAt(t0 + 18_917);
  assert.deepEqual(navButtonState(tickPlanning(shown, t0 + 18_917 + 4200), true), {
    label: "正在规划导航 4 s…",
    disabled: true,
    mode: "none",
  });
  const late = tickPlanning(shown, t0 + 18_917 + NAV_PLAN_BUDGET_MS - 1);
  assert.equal(late.phase, "planning");
  assert.equal(navButtonState(late, true).label, "正在规划导航 59 s…");
});

test("动画还在放时不计时也不降级——卡片一露面才开始算", () => {
  const s = startPlanning(t0);
  // 请求早就发出去了，但卡片没露面：屏幕上没有计时，也不该降级。
  const during = tickPlanning(s, t0 + 99_000);
  assert.equal(during.phase, "planning", "看动画的这段时间不算等待");
  assert.equal(navButtonState(during, true).label, "正在规划导航 0 s…");

  // 露面之后才起算，且幂等：重复标记不把起点往后挪。
  const shown = markPlanningVisible(during, t0 + 99_000);
  const again = markPlanningVisible(shown, t0 + 120_000);
  assert.equal(again.visibleAt, t0 + 99_000);
  assert.equal(navButtonState(tickPlanning(again, t0 + 99_000 + 3000), true).label, "正在规划导航 3 s…");

  // 方案早于动画结束就到了：那时按钮已经可点，露面这件事不该把它拨回 planning。
  const ready = applyResponse(startPlanning(t0), { status: "ready", plan: PLAN }, t0 + 8000);
  assert.equal(markPlanningVisible(ready, t0 + 18_917), ready);
});

test("卡片露面后 60 s 未到 → degraded：按钮回到可点的「开始导航」、直连、hint 说超时", () => {
  const s = tickPlanning(visibleAt(t0 + 18_917), t0 + 18_917 + NAV_PLAN_BUDGET_MS);
  assert.equal(s.phase, "degraded");
  assert.deepEqual(navButtonState(s, true), { label: "开始导航", disabled: false, mode: "direct" });
  assert.deepEqual(navLaunchFrom(s, target), { target });
  assert.match(navHint(s, true, "x"), /规划超时/);
  // 迟到的 ready 被忽略：用户已经看见"按默认路线"
  const late = applyResponse(s, { status: "ready", plan: PLAN }, t0 + 18_917 + NAV_PLAN_BUDGET_MS + 500);
  assert.equal(late.phase, "degraded");
  assert.equal(late.plan, undefined);
});

test("[F-18-15][AC-18-11] 方案到了 → ready：可点、mode=plan，唤起带全部途经点与策略", () => {
  const s = applyResponse(startPlanning(t0), { status: "ready", plan: PLAN }, t0 + 12_000);
  assert.equal(s.phase, "ready");
  assert.deepEqual(navButtonState(s, true), { label: "开始导航", disabled: false, mode: "plan" });
  assert.deepEqual(navLaunchFrom(s, target), {
    target: { lat: 30.2419, lon: 120.0987, name: "灵隐寺" },
    waypoints: [{ lat: 30.307762, lon: 120.365516, name: "下沙服务区" }],
    strategy: "less_toll",
  });
  assert.match(navHint(s, true, "x"), /已按乘车人画像规划/);
});

test("服务端 failed → direct、hint 说没规划成；ready 但方案不可用（终点 0,0）→ direct", () => {
  const f = applyResponse(startPlanning(t0), { status: "failed", reason: "no_origin" }, t0 + 300);
  assert.equal(f.phase, "failed");
  assert.equal(f.reason, "no_origin");
  assert.deepEqual(navButtonState(f, true), { label: "开始导航", disabled: false, mode: "direct" });
  assert.deepEqual(navLaunchFrom(f, target), { target });
  assert.match(navHint(f, true, "x"), /没规划成/);
  const bad = applyResponse(startPlanning(t0), { status: "ready", plan: { ...PLAN, destination: { name: "x", lat: 0, lon: 0 } } }, t0 + 300);
  assert.equal(bad.phase, "failed", "不可用的方案当 failed");
  assert.equal(navButtonState(bad, true).mode, "direct");
});

test("没有坐标：恒禁用、mode=none，与 phase 无关；hint 用兜底文案", () => {
  for (const s of [IDLE_NAV_STATE, startPlanning(t0), applyResponse(startPlanning(t0), { status: "ready", plan: PLAN }, t0)]) {
    assert.deepEqual(navButtonState(s, false), { label: "开始导航", disabled: true, mode: "none" });
    assert.equal(navLaunchFrom(s, undefined), undefined);
    assert.equal(navHint(s, false, "兜底"), "兜底");
  }
});

test("非 planning 态不吃回包、不走秒：idle/ready/failed 下 applyResponse 与 tickPlanning 原样返回", () => {
  const ready = applyResponse(startPlanning(t0), { status: "ready", plan: PLAN }, t0);
  assert.equal(applyResponse(ready, { status: "failed" }, t0 + 1), ready);
  assert.equal(tickPlanning(ready, t0 + 99_000), ready);
  assert.equal(applyResponse(IDLE_NAV_STATE, { status: "ready", plan: PLAN }, t0), IDLE_NAV_STATE);
});
