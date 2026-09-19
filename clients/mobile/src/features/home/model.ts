/**
 * 入口页的纯函数（施工单 M103-01）。
 *
 * 组件只负责摆，这里负责"写什么字"——每一条都有单测（`test/home-hub.test.ts`）。
 * 三条纪律与设计系统同源：读不到写「读不到」、没有写「暂无」/「还没有」，**不用 0 顶替**；
 * 不在这里推断风险等级（端上的读形状里没有它，见总览「已定决策」第 4 条）。
 */

import type { LiveEnergy } from "@carlife/shared";

import type { VehicleView } from "../ownership/types";

/** 与 `loadVehicles()` 三态同名，多一个 `loading`（Tauri 里第一拍还没回来）；浏览器预览恒为 `offline`。 */
export type VehicleReadState = "loading" | "ready" | "empty" | "offline";

export interface HomeVehicle {
  model: string;
  modelYear: number;
  odometerKm: number;
  /** 服务端 forecastMaintenance 的剩余里程；负数 = 已超期。缺席 = 档案里没有推算。 */
  forecastRemainingKm?: number;
  /** 最近一条 `source === "问诊"` 的维修记录时间（ms）。缺席 = 还没有问诊记录。 */
  lastConsultAt?: number;
  /** 那条记录的风险等级（留档 resolution 的固定前缀）；没写等级的老记录缺席。 */
  lastConsultLevel?: "low" | "medium" | "high";
}

const LEVEL_LABEL: Record<"low" | "medium" | "high", string> = { low: "低风险", medium: "中风险", high: "高风险" };

/** 留档 resolution 的固定前缀 → 等级。前缀是 `service.ts` `RISK_LABEL` 写的，这里只认这三个字面。 */
export function consultLevelOf(resolution: string | undefined): "low" | "medium" | "high" | undefined {
  if (!resolution) return undefined;
  if (resolution.startsWith("【高风险】")) return "high";
  if (resolution.startsWith("【中风险】")) return "medium";
  if (resolution.startsWith("【低风险】")) return "low";
  return undefined;
}

/** 按本地小时问候：4–10 早上、10–13 上午、13–18 下午、其余晚上。 */
export function greetingFor(hour: number): string {
  if (hour >= 4 && hour < 10) return "早上好";
  if (hour >= 10 && hour < 13) return "上午好";
  if (hour >= 13 && hour < 18) return "下午好";
  return "晚上好";
}

/** 问候行下面那句：车 + 表显里程；三态各说各的，不把"读不到"写成"没有"。 */
export function vehicleLine(state: VehicleReadState, vehicle?: HomeVehicle | null): string {
  if (state === "loading") return "正在读取车辆档案…";
  if (state === "offline") return "暂时读不到车辆档案";
  if (state === "empty" || !vehicle) return "还没有车辆档案";
  return `${vehicle.model} · 表显 ${formatKm(vehicle.odometerKm)} km`;
}

/** 「拍照问诊」卡的状态行：有等级写「上次 · 中风险 · 9/17」，没有写「上次问诊 · 9/17」。 */
export function consultStatus(lastConsultAt: number | undefined, level?: "low" | "medium" | "high", now = Date.now()): string {
  if (lastConsultAt === undefined) return "还没有问诊记录";
  const d = new Date(lastConsultAt);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const when = sameYear ? md : `${d.getFullYear()}/${md}`;
  return level ? `上次 · ${LEVEL_LABEL[level]} · ${when}` : `上次问诊 · ${when}`;
}

/** 「行程规划」卡的状态行：有程数写程数，没有就说没有——不写「0 程」。 */
export function tripsStatus(count: number): { label: string; count?: number } {
  if (count <= 0) return { label: "还没有行程" };
  return { label: "我的行程", count };
}

/** 车况条第一格：能量三支各画各的（与 `EnergyCapsule` 同一判据）。 */
export function energyValue(energy: LiveEnergy | undefined): { caption: string; value: string; unit?: string; muted: boolean } {
  if (!energy || energy.kind === "unavailable") return { caption: "剩余电量", value: "读不到", muted: true };
  if (energy.kind === "fuel") return { caption: "剩余油量", value: String(Math.round(energy.percent)), unit: "%", muted: false };
  return { caption: energy.charging ? "剩余电量 · 充电中" : "剩余电量", value: String(Math.round(energy.percent)), unit: "%", muted: false };
}

/** 车况条第二格：表显里程。 */
export function odometerValue(state: VehicleReadState, vehicle?: HomeVehicle | null): { value: string; unit?: string; muted: boolean } {
  if (state !== "ready" || !vehicle) return { value: "暂无", muted: true };
  return { value: formatKm(vehicle.odometerKm), unit: "km", muted: false };
}

/** 车况条第三格：距下次保养。负数 = 已超期，caption 跟着换。 */
export function serviceValue(
  forecast: { remainingKm: number } | undefined,
): { caption: string; value: string; unit?: string; muted: boolean } {
  if (!forecast) return { caption: "距下次保养", value: "暂无", muted: true };
  const km = Math.abs(Math.round(forecast.remainingKm));
  if (forecast.remainingKm < 0) return { caption: "保养已超期", value: `约 ${formatKm(km)}`, unit: "km", muted: false };
  return { caption: "距下次保养", value: `约 ${formatKm(km)}`, unit: "km", muted: false };
}

/** 提醒卡缺省文案：没有提醒时不空着，也不编一条。 */
export const DEFAULT_REMINDER = { title: "今天车况正常", body: "有事随时拍给我看" } as const;

/** 千分位；不带小数——里程与保养剩余都是整公里。 */
export function formatKm(km: number): string {
  return Math.round(km).toLocaleString("en-US");
}

/** 从档案读形状里取入口页要的几个字段；最近一次问诊 = `source === "问诊"` 的维修记录里最新的那条。 */
export function toHomeVehicle(v: VehicleView): HomeVehicle {
  const consults = v.repairs.filter((r) => r.source === "问诊").sort((a, b) => b.at - a.at);
  const latest = consults[0];
  const level = consultLevelOf(latest?.resolution);
  return {
    model: v.model,
    modelYear: v.modelYear,
    odometerKm: v.odometerKm,
    ...(v.forecast ? { forecastRemainingKm: v.forecast.remainingKm } : {}),
    ...(latest ? { lastConsultAt: latest.at } : {}),
    ...(level ? { lastConsultLevel: level } : {}),
  };
}

/** 暖暖脚下那张卡的保养提醒：有推算才有；负数说超期。没有推算就返回 undefined，让调用方用缺省文案。 */
export function maintenanceReminder(forecastRemainingKm: number | undefined): { title: string; body: string } | undefined {
  if (forecastRemainingKm === undefined) return undefined;
  const km = formatKm(Math.abs(forecastRemainingKm));
  if (forecastRemainingKm < 0) return { title: "有一条提醒", body: `保养已超期约 ${km} km，建议尽快安排` };
  return { title: "有一条提醒", body: `距下次保养约 ${km} km，先看看轮胎和刹车片` };
}
