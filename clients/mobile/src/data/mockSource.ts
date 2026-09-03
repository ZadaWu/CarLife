/**
 * HUD 数据源与 mock（施工单 A3，对齐 M1-03）。
 *
 * 真实实现走网关的 REST + SSE（**不用 WebSocket**，§3）。本文件只提供 mock：
 * 手机端首屏必须在网络就绪前就有东西可看——冷启动时网络往往还没好，
 * 空白首屏会被当成"App 坏了"。
 */
import {
  WEATHER_LABELS,
  paginateTipItems,
  type HudSnapshot,
  type WeatherKind,
} from "@carlife/shared";

// 网关数据源与常住地 mock 自 M65-01 起在 @carlife/ui（两端共用一份）；本文件只留手机端自己的 mock 基线。
import type { HudDataSource } from "@carlife/ui";
export { MOCK_HOME } from "@carlife/ui";
export type { HudDataSource } from "@carlife/ui";

const SUNNY_ITEMS = [
  { key: "hat", label: "遮阳帽" },
  { key: "sunscreen", label: "防晒霜" },
  { key: "water", label: "水" },
];

/* 雨天清单受**贴纸**限制：只有遮阳帽 / 防晒霜 / 水三张图（sprites.ts），
   而图标下要显示物品名，名字就必须叫得出图上画的那件东西（M20-01 用户走查）。
   「防水袋」配一支防晒霜是同一类错。真要出雨具，先补雨伞/雨衣贴纸再加条目。 */
const RAINY_ITEMS = [
  { key: "hat", label: "遮阳帽" },
  { key: "water", label: "保温水杯" },
  { key: "sunscreen", label: "防晒霜" },
];

export function makeSnapshot(weather: WeatherKind = "sunny"): HudSnapshot {
  // 演示数据：只有"晴"与"非晴"两套物品；天气名一律查 WEATHER_LABELS（M20-05）。
  const sunny = weather === "sunny";
  return {
    trip: {
      origin: { anchor: "home", name: "家", kind: "home" },
      nodes: [
        { anchor: "park", name: "亲子乐园", kind: "leisure" },
        { anchor: "charge", name: "充电站", kind: "charging" },
        { anchor: "rest", name: "休息区", kind: "rest" },
        { anchor: "wetland", name: "湿地公园", kind: "nature" },
      ],
      activeSegment: 1,
    },
    energy: { distanceKm: 36, batteryPercent: 68, requiredPercent: 21 },
    tips: { headline: "行前温馨提示", pages: paginateTipItems(sunny ? SUNNY_ITEMS : RAINY_ITEMS) },
    weather: { kind: weather, label: WEATHER_LABELS[weather] },
    assistantState: "idle",
    freshness: { stale: false, updatedAt: "刚刚" },
  };
}

export function createMockHudSource(weather: WeatherKind = "sunny"): HudDataSource {
  return {
    subscribe(onSnapshot) {
      onSnapshot(makeSnapshot(weather));
      return () => {};
    },
  };
}
