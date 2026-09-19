// map — 真实地图底图（高德 JS API）。未配置或加载失败时回退程序化底图。
export { configureAmap, isAmapConfigured, loadAmap } from "./amap-loader";
export type { AmapWebConfig, AMapInstance } from "./amap-loader";
export { bindViewportReporter, MAP_VIEWPORT_EVENTS } from "./viewport-report";
export type { ViewportReport, ViewportReportTarget } from "./viewport-report";
export { AmapBackdrop } from "./AmapBackdrop";
export type { AmapBackdropProps } from "./AmapBackdrop";
export { AmapTripLayer } from "./AmapTripLayer";
export type { AmapTripLayerProps, TripMapStop, NavTripProgress } from "./AmapTripLayer";
export { tripMarkerHtml, TRIP_MARKER_GUIDED_CLASS, TRIP_MARKER_GUIDED_LABEL } from "./trip-marker";
export type { TripMarkerOptions, TripMarkerStop } from "./trip-marker";
// 沿途服务点图层（M93-05）：与行程标记物理隔离的一层小标记。
export { serviceMarkerHtml, SERVICE_ICON_PATHS, SERVICE_MARKER_CLASS } from "./service-marker";
export type { ServiceMarkerCategory, ServiceMarkerPoi } from "./service-marker";
export { createSimulatedNavSource, etaToNextStop } from "./nav-position";
export type {
  NavLeg,
  NavPosition,
  NavPositionSource,
  NavEta,
  SimulatedNavOptions,
} from "./nav-position";
