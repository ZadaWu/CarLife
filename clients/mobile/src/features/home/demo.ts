/**
 * `?home=demo`：入口页的版式截图入口（与 `?dialog=demo` / `?plan=demo` 同一先例）。
 *
 * 浏览器预览没有 Tauri，车辆 / 能量都会是「暂无 / 读不到」——版式看不出来。
 * 演示数据文案带「（演示）」，与 `?plan=demo` 同一纪律：假数据不能与真实记录混同。
 */

import type { HomeVehicle } from "./model";

export function isHomeDemo(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("home") === "demo";
}

export const DEMO_HOME_VEHICLE: HomeVehicle = {
  model: "特斯拉 Model Y（演示）",
  modelYear: 2024,
  odometerKm: 23_480,
  forecastRemainingKm: 1_380,
  lastConsultAt: Date.parse("2026-09-17T14:41:00+08:00"),
  lastConsultLevel: "medium",
};

export const DEMO_HOME_TRIP_COUNT = 8;

export const DEMO_HOME_REMINDER = {
  title: "有一条提醒（演示）",
  body: "距下次保养约 1,380 km，先看看轮胎和刹车片",
  linkLabel: "查看保养记录 ›",
} as const;
