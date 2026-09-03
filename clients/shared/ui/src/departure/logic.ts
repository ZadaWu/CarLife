/**
 * `@carlife/ui/departure` 子路径入口：出发卡的**纯逻辑**，不带组件、不带 css、不带 png。
 *
 * 两端的 node:test 从这里引（与 `@carlife/ui/session-lifecycle` 同一先例）——
 * 根入口带着 png 资源，node 里一 import 就 `ERR_UNKNOWN_FILE_EXTENSION`。
 * 组件（`DepartureCard`）只从根入口出。
 */

export {
  amapAppNavUri,
  amapNavUri,
  amapWebPolicy,
  navLaunchDegradation,
  pickNavTarget,
  stopsViewportHeight,
  todayStopNames,
  type NavLaunch,
  type NavTarget,
} from "./amap";

export {
  IDLE_NAV_STATE,
  NAV_PLAN_BUDGET_MS,
  applyResponse,
  elapsedSeconds,
  markPlanningVisible,
  navButtonState,
  navHint,
  navLaunchFrom,
  startPlanning,
  tickPlanning,
  type NavButtonMode,
  type NavButtonView,
  type NavPlanPhase,
  type NavPlanState,
} from "./nav-state";

export { useDepartureNav, type DepartureNav } from "./useDepartureNav";
export { currentOriginForNav, normalizeNavPlanResponse, type OpenExternal } from "./origin";
