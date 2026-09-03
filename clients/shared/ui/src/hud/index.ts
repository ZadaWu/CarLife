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
export { CardPager } from "./CardPager";
export type { CardPagerProps } from "./CardPager";
export { EnergyCapsule } from "./EnergyCapsule";
export type { EnergyCapsuleProps, EnergySummary, LiveEnergy } from "./EnergyCapsule";
export { PortraitTimeline } from "./PortraitTimeline";
export type { PortraitTimelineProps, PortraitTimelineStop } from "./PortraitTimeline";
export { BottomNav } from "./BottomNav";
export type { BottomNavProps, NavView } from "./BottomNav";
export { MicIndicator } from "./MicIndicator";
export type { MicIndicatorProps, ListenState, ListenMode } from "./MicIndicator";
// HUD 精灵注册表（A3 从 clients/cockpit 移入：mobile 与 cockpit 共享同一套美术资产）
export { CABIN_ARRIVAL_SPRITES, SPRITES } from "./sprites";
export type { HudSprites } from "./sprites";
// 网关数据源 / 实时能量 / 精灵语义映射 / 行程地图入参 / 跟车顶栏 / 到站播报 / 演示行程（M65-01 上提，两端共用）
export { createGatewayHudSource, MOCK_HOME } from "./gateway-source";
export type { GatewayHudSource, GatewayHudSourceOptions, HomePlace, HudDataSource } from "./gateway-source";
export { demoEnergy, startEnergyPolling, toLiveEnergy } from "./energy-source";
export type { EnergyPoller, EnergyPollerOptions } from "./energy-source";
export { KIND_SPRITE, spriteFor } from "./sprite-for";
export { LODGING_LABEL } from "./trip-map-props";
export type { HudNavProps, HudTripMapProps } from "./trip-map-props";
export { NavBar } from "./NavBar";
export { arrivalNote, createArrivalAnnouncer } from "./nav-announce";
export type { ArrivalAnnouncer, ArrivalProgress } from "./nav-announce";
export { DEMO_TRIP_PLAN, withDemoNav } from "./demo-trip-plan";
