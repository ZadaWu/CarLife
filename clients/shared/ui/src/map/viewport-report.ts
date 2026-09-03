/**
 * 把「地图动了」变成一次视图上抛。
 *
 * # 为什么单独抽出来
 *
 * 它是"记住上次地图停在哪"这条线上唯一无法在浏览器走查里稳定复现的一环
 * （无头环境里合成的拖动事件到不了高德的手势层），所以它必须能**脱离 DOM 被单测**。
 * 组件里只剩一行调用。
 *
 * # 为什么同时订这么多事件
 *
 * 高德 JS API 2.0 在不同版本 / 不同渲染路径下，"移动结束"到底发哪个事件并不稳定
 * （`moveend` / `dragend` / 只有连续的 `mapmove`）。只订 `moveend` 的失败方式是
 * **静默的**：地图能拖，拖完什么也没记住，下次打开回到默认位置——而这正是这个
 * 功能要解决的问题本身，出了问题几乎没人会想到是事件名的事。
 *
 * 多订几个不会造成多写：上层 `useMapViewport` 的去抖（700ms）+ 去重
 * （米级以下不算变化）会把一次拖动的上百次回调收成一次落盘。
 */

/** 订阅的事件集合。连续事件与结束事件都要，理由见文件头。 */
export const MAP_VIEWPORT_EVENTS = [
  "mapmove",
  "moveend",
  "dragend",
  "zoomchange",
  "zoomend",
] as const;

export interface ViewportReportTarget {
  on?(event: string, handler: () => void): void;
  off?(event: string, handler: () => void): void;
  getCenter?(): { lat: number; lng: number } | undefined;
  getZoom?(): number | undefined;
}

export interface ViewportReport {
  lat: number;
  lon: number;
  zoom: number;
}

/**
 * 绑定上抛，返回解绑函数。
 *
 * `fallbackZoom` 用在 `getZoom()` 拿不到数的时候——**宁可记住一个略旧的缩放，
 * 也不要把 `undefined` 写进存储**：那份记录之后会被规范化整份丢掉，
 * 表现就是"拖了半天，下次打开还是老地方"。
 */
export function bindViewportReporter(
  map: ViewportReportTarget,
  fallbackZoom: number,
  report: (viewport: ViewportReport) => void,
): () => void {
  const handler = () => {
    const center = map.getCenter?.();
    if (!center || typeof center.lat !== "number" || typeof center.lng !== "number") return;
    const zoom = map.getZoom?.();
    report({
      lat: center.lat,
      lon: center.lng,
      zoom: typeof zoom === "number" && Number.isFinite(zoom) ? zoom : fallbackZoom,
    });
  };
  for (const event of MAP_VIEWPORT_EVENTS) map.on?.(event, handler);
  return () => {
    for (const event of MAP_VIEWPORT_EVENTS) map.off?.(event, handler);
  };
}
