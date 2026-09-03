/**
 * 记住"屏幕上那块地图上次停在哪"，下次打开回到原处。
 *
 * # 它与定位是两件事
 *
 * 这里存的是**用户自己拖出来的构图**，与他人在哪没有关系；所以它不看定位开关，
 * 关掉定位也不清它。分界写在 `contracts/src/domain/location.ts` 文件头。
 *
 * # 为什么恢复值不参与重渲染，而 focus 参与
 *
 * `<AmapBackdrop>` 的 `center`/`zoom` 一变就**重建地图实例**（它自己的注释解释了
 * 为什么）。用户每拖一下都往下发一次新的 center，地图就会一边被拖一边被重建。
 * 所以：
 *  - **拖动/缩放的落点**只往存储里写（`remember`），不进 React state；
 *  - **主动挪镜头**（点「定位」）走 `focus`，由 `<AmapBackdrop>` 用
 *    `setZoomAndCenter` 平移过去，同样不重建。
 * 唯一会触发一次重建的是启动时读回上次视图——那一次正是我们要的"回到原处"。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { normalizeViewport, sameViewport, type MapViewport } from "@carlife/shared";

import { getLocationPort } from "./port";

/** 主动把镜头挪过去。`nonce` 让"再点一次同一个位置"也能生效。 */
export interface MapFocus {
  lat: number;
  lon: number;
  zoom?: number;
  nonce: number;
}

export interface UseMapViewportResult {
  /** 端上读回来了没有。 */
  ready: boolean;
  /** 上次的视图；`null` = 没存过，调用方回落自己的默认中心（常住地等）。 */
  restored: MapViewport | null;
  /** 地图动完了。去抖落盘，**不触发重渲染**。 */
  remember: (viewport: { lat: number; lon: number; zoom: number }) => void;
  focus: MapFocus | null;
  focusOn: (target: { lat: number; lon: number; zoom?: number }) => void;
}

/** 拖停多久算"停下了"。太短会把一次连续拖动写成十几次盘。 */
const SETTLE_MS = 700;

export function useMapViewport(): UseMapViewportResult {
  const [restored, setRestored] = useState<MapViewport | null>(null);
  const [ready, setReady] = useState(false);
  const [focus, setFocus] = useState<MapFocus | null>(null);

  /** 最近一次**待写**的值与定时器；已写下去的值用于去重。 */
  const pending = useRef<MapViewport | null>(null);
  const saved = useRef<MapViewport | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    const next = pending.current;
    pending.current = null;
    if (!next || sameViewport(next, saved.current)) return;
    saved.current = next;
    void getLocationPort().saveViewport(next).catch(() => {
      // 存不下只丢"下次回到原处"，本次浏览不受影响——不打扰用户。
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void getLocationPort()
      .getViewport()
      .then((v) => {
        if (!alive) return;
        const clean = normalizeViewport(v);
        saved.current = clean;
        setRestored(clean);
        setReady(true);
      })
      .catch(() => {
        if (!alive) return;
        // 读不到 = 没存过。这条路上**不能停在"还没 ready"**：那会让地图
        // 永远等一个不会到的答案，表现是首页一直是程序化底图。
        setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  /*
   * 页面被藏起来/关掉时把待写的值落下去。
   *
   * 车机上"退出"往往就是熄火断电，没有 unload 那一套；`pagehide` 与
   * `visibilitychange` 是这类环境里唯一还算可靠的两个时机。少了它，
   * 用户拖完地图 700ms 内就关掉，这次的构图就丢了。
   */
  useEffect(() => {
    const onHide = () => flush();
    globalThis.addEventListener?.("pagehide", onHide);
    globalThis.document?.addEventListener("visibilitychange", onHide);
    return () => {
      globalThis.removeEventListener?.("pagehide", onHide);
      globalThis.document?.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [flush]);

  const remember = useCallback(
    (viewport: { lat: number; lon: number; zoom: number }) => {
      const clean = normalizeViewport({ ...viewport, at: new Date().toISOString() });
      if (!clean) return;
      pending.current = clean;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SETTLE_MS);
    },
    [flush],
  );

  const focusOn = useCallback(
    (target: { lat: number; lon: number; zoom?: number }) => {
      setFocus((prev) => ({ ...target, nonce: (prev?.nonce ?? 0) + 1 }));
      // 主动挪过去的镜头同样算"用户此刻停在哪"，下次打开要回到这儿。
      remember({ lat: target.lat, lon: target.lon, zoom: target.zoom ?? saved.current?.zoom ?? 15 });
    },
    [remember],
  );

  return { ready, restored, remember, focus, focusOn };
}
