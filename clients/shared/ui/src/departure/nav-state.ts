/**
 * 出发卡「开始导航」按钮的三态状态机（施工单 M66-04）。**纯函数**：`node:test` 里没有 DOM，
 * 能钉住的只有这里；组件只渲染它的输出。
 *
 * # 计时从**卡片出现**开始，不从点击开始（走查 2026-09-02 改）
 *
 * 请求仍然在点击那一刻就发出去——18.9 秒的动画是白等的，不能浪费。但那 18.9 秒里
 * 车主看的是动画不是卡片，**他还没有在等**。从点击算的话，卡片一露面就写着
 * 「正在规划导航 19 s…」，像是刚出现就已经拖了很久。
 *
 * 60 秒降级也从同一刻算。两者必须同源：从点击算预算、从卡片算显示，
 * 屏幕上会在「41 s」那一下突然降级，而车主看到的数字与判据对不上。
 *
 * `clickedAt` / `visibleAt` / `now` 都是墙钟毫秒——它们**不驱动动画**
 * （车机的动画由 WAAPI 主时钟驱动，M64 红线），只驱动按钮文案。墙钟只在 `useDepartureNav` 里读，
 * 车机的 `CabinArrivalDemo.tsx` 与本目录的 `DepartureCard.tsx` 里都没有 `Date.now`
 * （cockpit `departure-nav-invariants.test.ts` 守着）。
 *
 * 2026-09-02 从 cockpit `features/cabin/departure-nav-state.ts` 上提：手机端的出发卡用同一台状态机，
 * 只是没有动画——卡片一露面就 `markPlanningVisible`。
 *
 * # 降级不是失败态
 *
 * 60 s 没结果（`degraded`）或服务端 `failed`：按钮回到「开始导航」、可点、URI 与 M66 之前逐字相同
 * （今天第一站单点直达）。降级的定义就是"和今天一样能用"，所以不弹错误、不禁用。
 * 已 degraded 之后迟到的 ready **忽略**：用户已经看见"按默认路线"，再换成方案会让链接在手指下面变。
 */

import { navPlanIsUsable, type NavPlan, type NavPlanResponse } from "@carlife/shared";

import type { NavLaunch, NavTarget } from "./amap";

export type NavPlanPhase = "idle" | "planning" | "ready" | "failed" | "degraded";

export interface NavPlanState {
  phase: NavPlanPhase;
  /** 点击时刻（墙钟 ms）；idle 时为 0。请求从这一刻发出，与动画并行。 */
  clickedAt: number;
  /**
   * 出发卡露面的时刻（墙钟 ms）；动画还在放时为 undefined。
   * 计时与降级都从它算起——见文件头。
   */
  visibleAt?: number;
  /** 最近一次 tick 的墙钟 ms——按钮上的秒数由它算，组件不读时钟。 */
  now: number;
  plan?: NavPlan;
  /** failed 时服务端给的原因（排障用，不上屏）。 */
  reason?: string;
}

/** 端上硬顶：从**卡片露面**起 60 s。网关 60 s、Rust 65 s 更长是刻意的——端上的判据是"用户等了多久"。 */
export const NAV_PLAN_BUDGET_MS = 60_000;

export const IDLE_NAV_STATE: NavPlanState = { phase: "idle", clickedAt: 0, now: 0 };

export function startPlanning(now: number): NavPlanState {
  return { phase: "planning", clickedAt: now, now };
}

/** 服务端回包。已 degraded 的忽略（迟到）；非 planning 态也忽略（idle 时收到的是上一轮的）。 */
export function applyResponse(s: NavPlanState, r: NavPlanResponse, now: number): NavPlanState {
  if (s.phase !== "planning") return s;
  if (r.status === "ready" && navPlanIsUsable(r.plan)) return { ...s, phase: "ready", now, plan: r.plan };
  return { ...s, phase: "failed", now, ...(r.reason ? { reason: r.reason } : {}) };
}

/**
 * 出发卡露面了：计时从这一刻起算（见文件头）。幂等——重播会重新走一遍 planning。
 * 已经不在 planning（方案早于动画结束就到了）时什么都不做：按钮那时已经可点。
 */
export function markPlanningVisible(s: NavPlanState, now: number): NavPlanState {
  if (s.phase !== "planning" || s.visibleAt !== undefined) return s;
  return { ...s, visibleAt: now, now };
}

/**
 * 每秒一拍：只在 planning 时有意义；超预算 → degraded。
 *
 * **卡片还没露面就不降级**（`visibleAt` 未定）：那时车主在看动画，屏幕上没有任何计时，
 * 此刻降级会让卡片一出现就写着"规划超时"，而他一秒都还没等过。
 */
export function tickPlanning(s: NavPlanState, now: number): NavPlanState {
  if (s.phase !== "planning") return s;
  if (s.visibleAt !== undefined && now - s.visibleAt >= NAV_PLAN_BUDGET_MS) {
    return { ...s, phase: "degraded", now };
  }
  return { ...s, now };
}

export type NavButtonMode = "plan" | "direct" | "none";

export interface NavButtonView {
  label: string;
  disabled: boolean;
  mode: NavButtonMode;
}

/** 已等待的整秒数：从卡片露面算起；还没露面时是 0（那时也没人在看）。 */
export function elapsedSeconds(s: NavPlanState): number {
  return Math.max(0, Math.floor((s.now - (s.visibleAt ?? s.now)) / 1000));
}

export function navButtonState(s: NavPlanState, hasTarget: boolean): NavButtonView {
  if (!hasTarget) return { label: "开始导航", disabled: true, mode: "none" };
  switch (s.phase) {
    case "planning":
      return { label: `正在规划导航 ${elapsedSeconds(s)} s…`, disabled: true, mode: "none" };
    case "ready":
      return navPlanIsUsable(s.plan)
        ? { label: "开始导航", disabled: false, mode: "plan" }
        : { label: "开始导航", disabled: false, mode: "direct" };
    case "idle":
    case "failed":
    case "degraded":
    default:
      return { label: "开始导航", disabled: false, mode: "direct" };
  }
}

/** 按钮该用哪一次唤起：方案模式带途经点与策略；直连只有今天第一站。 */
export function navLaunchFrom(s: NavPlanState, target: NavTarget | undefined): NavLaunch | undefined {
  if (!target) return undefined;
  const view = navButtonState(s, true);
  if (view.mode === "plan" && s.plan) {
    return {
      target: { lat: s.plan.destination.lat, lon: s.plan.destination.lon, name: s.plan.destination.name },
      waypoints: s.plan.waypoints.map((w) => ({ lat: w.lat, lon: w.lon, name: w.name })),
      strategy: s.plan.strategy,
    };
  }
  return { target };
}

/** 卡底那一行说明。降级与失败都要说"按默认路线"，规划中说在算。 */
export function navHint(s: NavPlanState, hasTarget: boolean, fallback: string): string {
  if (!hasTarget) return fallback;
  switch (s.phase) {
    case "planning":
      return "正在按乘车人的需要规划休息点与路线，动画放完若还没好会再等一会儿。";
    case "ready":
      return "已按乘车人画像规划：将打开高德地图——车机/手机上直接进导航，电脑上打开网页版路径规划。";
    case "degraded":
      return "规划超时，按默认路线导航（今天第一站直达）。";
    case "failed":
      return "这次没规划成，按默认路线导航（今天第一站直达）。";
    case "idle":
    default:
      return fallback;
  }
}
