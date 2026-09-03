/**
 * 出发导航规划的 React 接线（施工单 M66-04；2026-09-02 上提到 `clients/shared/ui`，两端共用）：
 * 把墙钟与请求生命周期关在这一个文件里。
 *
 * `CabinArrivalDemo.tsx` 里**不出现** `Date.now` / `setInterval`（M64 的"没有第二个时钟"红线由
 * `departure-audio-invariants.test.ts` 守着）。这里的墙钟不驱动动画，只驱动按钮上的秒数——
 * 动画进后台会冻结，用户的等待不会，所以恰恰不能用动画时钟。
 *
 * 迟到结果按序号丢弃（`App.tsx openGuide` 同款）：重播会再点一次，上一轮的回包盖到新一轮上
 * 是最迷惑的一种错。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { NavPlanResponse } from "@carlife/shared";

import {
  IDLE_NAV_STATE,
  applyResponse,
  markPlanningVisible,
  startPlanning,
  tickPlanning,
  type NavPlanState,
} from "./nav-state";

export interface DepartureNav {
  state: NavPlanState;
  /** 在用户手势的同步栈里调：立刻进入 planning 并发出请求（请求由调用方构造，便于注入起点与 vin）。 */
  start: (request: () => Promise<NavPlanResponse>) => void;
  /** 出发卡露面了：计时从这一刻起算（动画放完，或减少动态时立即）。 */
  markVisible: () => void;
  /** 关闭出发流程：作废在途请求、回 idle。 */
  reset: () => void;
}

export function useDepartureNav(): DepartureNav {
  const [state, setState] = useState<NavPlanState>(IDLE_NAV_STATE);
  const seqRef = useRef(0);

  const start = useCallback((request: () => Promise<NavPlanResponse>) => {
    const seq = ++seqRef.current;
    setState(startPlanning(Date.now()));
    void request()
      .catch((): NavPlanResponse => ({ status: "failed", reason: "failed" }))
      .then((r) => {
        if (seq !== seqRef.current) return; // 重播/关闭后迟到的回包作废
        setState((cur) => applyResponse(cur, r, Date.now()));
      });
  }, []);

  const markVisible = useCallback(() => {
    setState((cur) => markPlanningVisible(cur, Date.now()));
  }, []);

  const reset = useCallback(() => {
    seqRef.current += 1;
    setState(IDLE_NAV_STATE);
  }, []);

  // 每秒一拍，只在规划中存在；离开 planning 即清。
  useEffect(() => {
    if (state.phase !== "planning") return;
    const t = setInterval(() => setState((cur) => tickPlanning(cur, Date.now())), 1000);
    return () => clearInterval(t);
  }, [state.phase]);

  return { state, start, markVisible, reset };
}
