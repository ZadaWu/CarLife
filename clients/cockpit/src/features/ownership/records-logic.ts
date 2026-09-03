/**
 * 详情页的纯逻辑（施工单 M29-02）。独立成模块的唯一理由：
 * `RecordsScreen.tsx` 带 css 导入，node:test 经 tsx 加载会直接抛
 * ERR_UNKNOWN_FILE_EXTENSION——逻辑放这里，测试就不用碰组件文件。
 */

import { PROFILE_FACT_SOURCE_LABEL, isProfileFactSource } from "@carlife/shared";

import type { VehicleView } from "./types";

/** 空态三支：皆空 / 仅维修空 / 有内容。措辞不同是本页的验收点之一。 */
export type RecordsEmptiness = "both-empty" | "repairs-empty" | "has-content";

export function recordsEmptiness(v: Pick<VehicleView, "maintenance" | "repairs">): RecordsEmptiness {
  if (v.maintenance.length === 0 && v.repairs.length === 0) return "both-empty";
  if (v.repairs.length === 0) return "repairs-empty";
  return "has-content";
}

/** 维修处置行的文案：缺席如实说"未记录处置"，不省略。 */
export function repairResolutionText(r: { resolution?: string }): string {
  return r.resolution?.trim() ? r.resolution : "未记录处置";
}

/**
 * 来源展示（M29-03）：受控词表值翻译成人话（"owner-manual" 直接上屏没人看得懂），
 * 历史自由文本（"门店"/"用户自述"/工单号）原样保留——读侧兼容不迁移（M26-04 纪律）。
 */
export function sourceLabel(source: string): string {
  return isProfileFactSource(source) ? PROFILE_FACT_SOURCE_LABEL[source] : source;
}

/**
 * VIN 格式校验（M29-04）。与网关/`@carlife/memory` 的 `isValidVin` 同一条正则
 * （17 位，不含 I/O/Q）——cockpit 不依赖 memory 包，故本地写一份；改规则两处同改。
 */
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function validateVinInput(vin: string): string | null {
  const v = vin.trim().toUpperCase();
  if (!v) return "请输入 VIN";
  if (v.length !== 17) return `VIN 应为 17 位（当前 ${v.length} 位）`;
  if (!VIN_RE.test(v)) return "VIN 只含数字与字母，且不含 I / O / Q";
  return null;
}

/** 表单校验（与网关规则一致——M14-04"校验规则与端上一致"同款要求）。返回错误文案或 null。 */
export function validateMaintenanceEntry(e: {
  at: number;
  odometerKm: number;
  items: string;
}): string | null {
  if (!Number.isFinite(e.at) || e.at <= 0) return "请选择保养日期";
  if (e.at > Date.now()) return "未来时间不能是保养时间";
  if (!Number.isFinite(e.odometerKm) || e.odometerKm < 0 || e.odometerKm > 2_000_000) {
    return "表显里程要在 0 ~ 2,000,000 km 之间";
  }
  if (!e.items.trim()) return "写一句做了什么保养";
  return null;
}
