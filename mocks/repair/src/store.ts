/**
 * 种子数据加载与时段生成（施工单 M41-01）。
 *
 * 与 mock-dealer 的 store.ts 同一条纪律：**不做任何补全与猜测**——
 * 查不到就是查不到，上游据此如实说"没有"，模型编不出种子里没有的维修站。
 *
 * # 种子 VIN 必须与 demo:seed 一致
 *
 * "关联用车数据"的关联键是 VIN（总览决策 4）。种子历史的里程线也必须与
 * `scripts/dev/demo/demo-seed.ts` 的车辆里程衔接（EV 当前 41,280km、ICE
 * 118,640km），4S 记录里程比表显还大会被一眼看穿是假的。
 *
 * # 时段是生成的，不是种子里写死的
 *
 * 写死的日期明天就过期，表现是"一个时段都约不上"，看起来像功能坏了
 * （mock-dealer slots.ts 踩过并写明的坑）。维修站营业窗口固定，直接按
 * 未来 10 天 × 4 个窗口确定性生成——同参数两次调用逐字相同，不用随机数。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

export interface Station {
  stationId: string;
  name: string;
  city: string;
  district: string;
  services: string[];
}

export interface RepairHistoryRecord {
  id: string;
  vin: string;
  at: string;
  odometerKm: number;
  items: string[];
  symptom?: string;
  resolution: string;
  stationId: string;
  stationName: string;
  totalFee: number;
}

export interface QuoteItem {
  name: string;
  partsFee: number;
  laborFee: number;
}

export interface Quote {
  quoteId: string;
  orderId: string;
  vin: string;
  status: "in_progress" | "done";
  items: QuoteItem[];
  partsFee: number;
  laborFee: number;
  total: number;
  currency: "CNY";
  updatedAt: string;
}

export interface SeedOrder {
  orderId: string;
  vin: string;
  stationId: string;
  stationName: string;
  status: "in_progress" | "done";
  startedAt: string;
}

function load<T>(file: string, key: string): T[] {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as Record<string, T[]>;
  const rows = raw[key];
  if (!Array.isArray(rows)) throw new Error(`${file} 里没有 ${key} 数组——种子文件坏了要在启动时炸，不能带病服务`);
  return rows;
}

export const STATIONS: Station[] = load<Station>("stations.json", "stations");
export const HISTORY: RepairHistoryRecord[] = load<RepairHistoryRecord>("repair-history.json", "records");
export const SEED_ORDERS: SeedOrder[] = load<SeedOrder>("quotes.json", "orders");
export const SEED_QUOTES: Quote[] = load<Quote>("quotes.json", "quotes");

export function findStation(stationId: string): Station | undefined {
  return STATIONS.find((s) => s.stationId === stationId);
}

export function searchStations(city?: string): Station[] {
  if (!city) return STATIONS;
  return STATIONS.filter((s) => s.city.includes(city) || city.includes(s.city));
}

export function historyOf(vin: string): RepairHistoryRecord[] {
  return HISTORY.filter((r) => r.vin === vin).sort((a, b) => a.at.localeCompare(b.at));
}

// ── 时段 ────────────────────────────────────────────────────

export interface RepairSlot {
  slotId: string;
  stationId: string;
  startAt: string;
  /** 每窗口可同时接待数（占用在 index.ts 里另记）。 */
  capacity: number;
}

/** 每天四个进厂窗口（北京时间）。维修不是试驾，窗口固定不玩伪随机。 */
const HOURS = [9, 11, 14, 16] as const;
export const DEFAULT_DAYS = 10;

function ymd(d: Date): string {
  // 以北京时间取日历日：服务可能跑在任意时区的机器上。
  const bj = new Date(d.getTime() + 8 * 3600_000);
  return bj.toISOString().slice(0, 10);
}

export function generateRepairSlots(args: { stationId: string; from?: string; to?: string; now?: Date }): RepairSlot[] {
  const now = args.now ?? new Date();
  const first = args.from ?? ymd(new Date(now.getTime() + 24 * 3600_000)); // 明天起：当天进厂来不及排产
  const last = args.to ?? ymd(new Date(now.getTime() + DEFAULT_DAYS * 24 * 3600_000));
  const slots: RepairSlot[] = [];
  for (let t = Date.parse(`${first}T00:00:00+08:00`); ymd(new Date(t)) <= last; t += 24 * 3600_000) {
    const day = ymd(new Date(t));
    for (const h of HOURS) {
      const startAt = `${day}T${String(h).padStart(2, "0")}:00:00+08:00`;
      if (Date.parse(startAt) <= now.getTime()) continue; // 过去的窗口不是可预约时段
      slots.push({ slotId: `${args.stationId}#${startAt}`, stationId: args.stationId, startAt, capacity: 2 });
    }
  }
  return slots;
}

export function parseRepairSlotId(slotId: string): { stationId: string; startAt: string } | undefined {
  const idx = slotId.indexOf("#");
  if (idx <= 0) return undefined;
  const stationId = slotId.slice(0, idx);
  const startAt = slotId.slice(idx + 1);
  if (Number.isNaN(Date.parse(startAt))) return undefined;
  return { stationId, startAt };
}
