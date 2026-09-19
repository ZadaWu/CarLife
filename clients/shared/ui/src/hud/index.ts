// hud — 浮层信息卡、手势层(长按=按住说话)、底部导航
export * from "./layout";
export { HudStage, HudScene, resolveLayoutMode } from "./HudStage";
export type { HudLayoutMode } from "./HudStage";
export { MapBackdrop } from "./MapBackdrop";
export { LifeRing } from "./LifeRing";
export type { LifeRingProps } from "./LifeRing";
export { PoiNode } from "./PoiNode";
export type { PoiNodeProps } from "./PoiNode";
export { TipsCard, MAX_ITEMS_PER_PAGE } from "./TipsCard";
export type { TipsCardProps, TipItem } from "./TipsCard";
// 目的地推荐卡（M32-03）：与 TipsCard 轮播在同一个窗口里，共用外框与页脚。
export { HighlightsCard, MAX_ROWS_PER_SECTION } from "./HighlightsCard";
export type { HighlightsCardProps } from "./HighlightsCard";
// 行程列表卡与暖暖 alert 判据（M72-04）：右上角每程一行 + 变化点；critical 未确认 → alert。
export {
  TripListCard,
  MAX_DAY_CELLS,
  MAX_ROWS_VISIBLE,
  dayCells,
  entryNeedsAttention,
  tripMetaLabel,
  tripRouteLabel,
} from "./TripListCard";
export type { TripListCardProps, DayCell } from "./TripListCard";
// 两态（M73-01）：未选中用周日历卡，选中用顶部日期条。
export {
  TripCalendarCard,
  MAX_WEEK_BARS,
  LIST_PAGE_SIZE,
  weekBars,
  listDateLabel,
  clampPage,
  pageOf,
  weekRangeLabel,
  tripThumbSprite,
  tripColorIndex,
  TRIP_COLOR_COUNT,
} from "./TripCalendarCard";
export type { TripCalendarCardProps, WeekBar } from "./TripCalendarCard";
export { TripDateBanner, shortDateLabel } from "./TripDateBanner";
export type { TripDateBannerProps } from "./TripDateBanner";
// 行程详情抽屉（M83-03）：按天看沿途服务与时间轴；纯受控，状态在页面层。
export { TripDetailDrawer, drawerSubtitle } from "./TripDetailDrawer";
export type { TripDetailDrawerProps } from "./TripDetailDrawer";
export {
  chargeCellValue,
  chargeStopName,
  chargeStopNames,
  dayArriveHotelTime,
  dayDepartTime,
  dayMetrics,
  dayReturnRow,
  dayServices,
  dayTimeline,
  dayTouched,
  driveLabel,
  editableRows,
  moveInOrder,
  pushMove,
  pushRemove,
  pushReorder,
  returnLegs,
  rowChangeLabel,
  rowChanges,
  stayLabel,
  tripChargeStops,
  undoRemove,
  selectedServicePois,
  serviceOverride,
  servicePoisFor,
  serviceCellTitle,
  PENDING,
  SERVICE_CATEGORY_KEYS,
} from "./trip-detail";
export type {
  DayMetrics,
  EditableRow,
  RowChange,
  SelectedServicePoi,
  ServiceCategoryKey,
  ServiceCell,
  TimelineRow,
} from "./trip-detail";
// 变化摘要弹层与演示条目（M72-04 建于车机；M75-01 上提，两端共用一份，样式在 trip-review.css）。
export { TripReviewSheet, groupChangesByDay, reviewedAtLabel } from "./TripReviewSheet";
export type { TripReviewSheetProps } from "./TripReviewSheet";
export { DEMO_TRIP_ENTRIES } from "./demo-trip-entries";
export { hudAlertFrom } from "./hud-alert";
// 确认弹窗的体检区（M77-04）：摘要条三胶囊 + 「出发前请看」/「验不了」两段；只消费 contracts 解出的 AuditSummary。
export { AuditSection, AuditSummaryBar, AuditLists } from "./AuditSection";
export type { AuditSectionProps } from "./AuditSection";
// 点火播报（M72-05，F-19-07）：critical 未确认 → 一句报告式文本进会话；一份一次、一天一次、可关、行驶中不播。
export { announceNote, createReviewAnnouncer, shouldAnnounce, REVIEW_NOTICE_PREFIX } from "./review-announce";
export type { AnnounceGate, AnnounceStore, ReviewAnnouncer } from "./review-announce";
export { CardPager } from "./CardPager";
export type { CardPagerProps } from "./CardPager";
export { EnergyCapsule } from "./EnergyCapsule";
export type { EnergyCapsuleProps, EnergySummary, LiveEnergy } from "./EnergyCapsule";
export { PortraitTimeline } from "./PortraitTimeline";
export type { PortraitTimelineProps, PortraitTimelineStop } from "./PortraitTimeline";
export { BottomNav, NAV_ITEMS } from "./BottomNav";
export type { BottomNavProps, NavView } from "./BottomNav";
// 新版车机 UI：顶栏（页签上提到屏顶）与出行状态栏（能量胶囊摊开成屏底一条）。手机端仍用 BottomNav / EnergyCapsule。
export { TopBar, TOP_BAR_LINK_LABEL, topBarDateLabel, topBarTimeLabel } from "./TopBar";
export type { TopBarLink, TopBarProps } from "./TopBar";
export { StatusBar } from "./StatusBar";
export { METRIC_EMPTY, METRIC_UNAVAILABLE, durationLabel } from "./metric-text";
export type { StatusBarProps } from "./StatusBar";
export { MicIndicator } from "./MicIndicator";
export type { MicIndicatorProps, ListenState, ListenMode } from "./MicIndicator";
// HUD 精灵注册表（A3 从 clients/cockpit 移入：mobile 与 cockpit 共享同一套美术资产）
export { CABIN_ARRIVAL_SPRITES, SPRITES } from "./sprites";
export type { HudSprites } from "./sprites";
// 网关数据源 / 实时能量 / 精灵语义映射 / 行程地图入参 / 跟车顶栏 / 到站播报 / 演示行程（M65-01 上提，两端共用）
export { createGatewayHudSource, hudSourceFailure, MOCK_HOME } from "./gateway-source";
export type { GatewayHudSource, GatewayHudSourceOptions, HomePlace, HudDataSource, HudSourceFailure } from "./gateway-source";
// 真实地图行程模式的判定：两端共用一份（原来车机内联、手机一份，见 trip-mode.ts 文件头）。
export { tripActiveFor } from "./trip-mode";
export { demoEnergy, startEnergyPolling, toLiveEnergy } from "./energy-source";
export type { EnergyPoller, EnergyPollerOptions } from "./energy-source";
export { KIND_SPRITE, spriteFor } from "./sprite-for";
export { LODGING_LABEL } from "./trip-map-props";
export type { HudNavProps, HudTripMapProps } from "./trip-map-props";
export { NavBar } from "./NavBar";
export { arrivalNote, createArrivalAnnouncer } from "./nav-announce";
// 途中提醒（M77-05，FL-62）：跟车状态机（段 / 差分车速 / 行驶态 / 位置陈旧）与两类提醒的判据、闸与文案。纯函数，时钟入参。
export {
  advanceTracker,
  drivenMinutes,
  isDriving,
  isPositionStale,
  speedJump,
  DEFAULT_TRACKER_CONFIG,
  INITIAL_TRACKER,
} from "./en-route-tracker";
export type { TrackerConfig, TrackerState } from "./en-route-tracker";
export {
  afterGate,
  etaClockOf,
  gateReminder,
  reminderText,
  shouldRemindRest,
  shouldRemindStop,
  DEFAULT_REMINDER_CONFIG,
  INITIAL_MEMO,
} from "./en-route-reminders";
export type { Reminder, ReminderConfig, ReminderDensity, ReminderGate, ReminderMemo, RestReminder, StopReminder } from "./en-route-reminders";
// 控制器（时钟入参）、React hook、提醒卡（M77-06）。
export { createEnRouteController, DEFAULT_COLLAPSE_AFTER_MS } from "./en-route-controller";
export type { EnRouteCard, EnRouteController, EnRouteControllerOptions, EnRouteEvent } from "./en-route-controller";
export { useEnRouteReminders } from "./useEnRouteReminders";
export type { UseEnRouteRemindersOptions, UseEnRouteRemindersResult } from "./useEnRouteReminders";
export { EnRouteReminderCard } from "./EnRouteReminderCard";
export type { EnRouteReminderCardProps } from "./EnRouteReminderCard";
export type { ArrivalAnnouncer, ArrivalProgress } from "./nav-announce";
export { DEMO_TRIP_PLAN, withDemoNav } from "./demo-trip-plan";
