/**
 * 提示卡轮播（施工单 M1-03）
 *
 * Brief §3.3：默认每 6 秒平缓自动轮播，用户可左右滑动并**从当前页重新计时**。
 * 页数为 1 时不轮播（也不显示圆点，由 TipsCard 负责）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const CAROUSEL_INTERVAL_MS = 6000;
/** 触发翻页的最小水平位移（设备像素）。 */
export const SWIPE_THRESHOLD_PX = 40;

export interface CarouselApi {
  /** 当前页，1 起。 */
  page: number;
  /** 供容器展开的手势属性（Pointer Events，覆盖鼠标与触屏）。 */
  gestureProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: () => void;
  };
  goTo: (page: number) => void;
}

export function useCarousel(pageCount: number, intervalMs = CAROUSEL_INTERVAL_MS): CarouselApi {
  const [page, setPage] = useState(1);
  // tick 变化即重置计时器——手动滑动后从当前页重新计时
  const [tick, setTick] = useState(0);
  const startX = useRef<number | null>(null);

  useEffect(() => {
    if (page > pageCount) setPage(1);
  }, [pageCount, page]);

  useEffect(() => {
    if (pageCount <= 1) return;
    const id = window.setTimeout(() => {
      setPage((p) => (p >= pageCount ? 1 : p + 1));
    }, intervalMs);
    return () => window.clearTimeout(id);
  }, [page, pageCount, intervalMs, tick]);

  const goTo = useCallback(
    (next: number) => {
      if (pageCount <= 1) return;
      const wrapped = ((next - 1 + pageCount) % pageCount) + 1;
      setPage(wrapped);
      setTick((t) => t + 1); // 重新计时
    },
    [pageCount],
  );

  const gestureProps = useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent) => {
        startX.current = e.clientX;
      },
      onPointerUp: (e: React.PointerEvent) => {
        const x0 = startX.current;
        startX.current = null;
        if (x0 == null) return;
        const dx = e.clientX - x0;
        if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
        setPage((p) => {
          const next = dx < 0 ? p + 1 : p - 1;
          return ((next - 1 + pageCount) % pageCount) + 1;
        });
        setTick((t) => t + 1); // 从当前页重新计时
      },
      onPointerCancel: () => {
        startX.current = null;
      },
    }),
    [pageCount],
  );

  return { page, gestureProps, goTo };
}
