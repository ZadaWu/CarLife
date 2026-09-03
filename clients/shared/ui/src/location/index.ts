// location — 定位授权（模糊 / 精确 / 停用）与地图视图记忆。
//
// 分界见 `contracts/src/domain/location.ts` 文件头：授权管"能不能知道你在哪"，
// 地图视图管"屏幕上次停在哪"，关掉前者不清后者。
export {
  configureLocationPort,
  configureNativeLocator,
  createBrowserLocationPort,
  getLocationPort,
  hasNativeLocationPort,
  publishLocationState,
  subscribeLocationState,
} from "./port";
export type { LocationPort, LocationSnapshot, NativeLocator, RawLocationFix } from "./port";
export { acquireRawFix } from "./acquire";
export type { AcquireOptions } from "./acquire";
export { useLocation } from "./useLocation";
export type { UseLocationResult, UseLocationOptions, LocationStatus } from "./useLocation";
export { useMapViewport } from "./useMapViewport";
export type { UseMapViewportResult, MapFocus } from "./useMapViewport";
export { LocationSettings } from "./LocationSettings";
export type { LocationSettingsProps } from "./LocationSettings";
export { LocateButton } from "./LocateButton";
export type { LocateButtonProps } from "./LocateButton";
