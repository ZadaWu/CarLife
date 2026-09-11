/**
 * 途中提醒的 React 一层（M77-06）。控制器是纯的（`en-route-controller.ts`），这里只做三件事：
 * 建控制器、每 5 s 心跳一次、把卡片状态交给 React。定时器只驱动判定，不驱动动画（M64 红线）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { NavTripProgress } from "../map";
import { createEnRouteController, type EnRouteCard, type EnRouteController, type EnRouteControllerOptions } from "./en-route-controller";

export interface UseEnRouteRemindersOptions extends Omit<EnRouteControllerOptions, "onCard"> {
  /** 跟车中才判；不在跟车时控制器归零、卡片清空。 */
  active: boolean;
  /** 换一次导航就重建（与 `HudNavProps.key` 同一口径）。 */
  navKey?: string;
  tickMs?: number;
}

export interface UseEnRouteRemindersResult {
  card: EnRouteCard | undefined;
  onProgress: (frame: NavTripProgress) => void;
  ack: () => void;
  decideRest: (accept: boolean) => void;
  hush: () => void;
  controller: EnRouteController;
}

export function useEnRouteReminders(opts: UseEnRouteRemindersOptions): UseEnRouteRemindersResult {
  const [card, setCard] = useState<EnRouteCard | undefined>(undefined);
  // 回调经 ref 取最新值：调用方十有八九传内联函数，不该因此每帧重建控制器。
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const controller = useMemo(
    () =>
      createEnRouteController({
        legs: opts.legs,
        limitMin: opts.limitMin,
        density: opts.density,
        enabled: opts.enabled,
        cfg: opts.cfg,
        collapseAfterMs: opts.collapseAfterMs,
        now: opts.now,
        speak: opts.speak ? (line, kind) => optsRef.current.speak?.(line, kind) ?? Promise.resolve(false) : undefined,
        isInFlight: () => optsRef.current.isInFlight?.() ?? false,
        onEvent: (e) => optsRef.current.onEvent?.(e),
        onCard: setCard,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 换导航 / 换行程分段 / 换上限才重建
    [opts.navKey, opts.legs, opts.limitMin],
  );
  useEffect(() => {
    controller.setDensity(opts.density ?? "normal");
  }, [controller, opts.density]);
  useEffect(() => {
    controller.setEnabled((opts.enabled ?? true) && opts.active);
    if (!opts.active) controller.reset();
  }, [controller, opts.enabled, opts.active]);
  useEffect(() => {
    if (!opts.active) return;
    const id = setInterval(() => controller.tick(), opts.tickMs ?? 5_000);
    return () => clearInterval(id);
  }, [controller, opts.active, opts.tickMs]);

  const onProgress = useCallback((frame: NavTripProgress) => controller.onProgress(frame), [controller]);
  const ack = useCallback(() => controller.ack(), [controller]);
  const decideRest = useCallback((accept: boolean) => controller.decideRest(accept), [controller]);
  const hush = useCallback(() => controller.hush(), [controller]);
  return { card, onProgress, ack, decideRest, hush, controller };
}
