/**
 * 种子数据加载与查询（施工单 M19-01）。
 *
 * 这里的每个函数都刻意**不做任何补全与猜测**：查不到就是查不到。
 * 上游（`enterprise/backend/shared/tools` 的四个工具）据此如实告诉模型"没有"，
 * 而模型编不出一个种子里没有的门店——这是整个 Sprint 的地基。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

export type StoreType = "experience" | "service";

export interface Store {
  storeId: string;
  name: string;
  type: StoreType;
  city: string;
  district: string;
  address: string;
  lat: number;
  lon: number;
  models: string[];
}

export interface Trim {
  trim: string;
  /** 人民币指导价。**缺省表示本系统没有人民币报价**（如 Cybertruck），不是 0。 */
  priceCny?: number;
  rangeKm: number;
  seats: number;
}

export interface ModelDef {
  model: string;
  trims: Trim[];
}

function load<T>(file: string, key: string): T[] {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as Record<string, unknown>;
  const rows = raw[key];
  if (!Array.isArray(rows) || rows.length === 0) {
    // 空种子起得来但查不到任何东西，而"起来了"与"起来了但是空的"看起来一样。
    throw new Error(`[mock-dealer] ${file} 的 ${key} 为空——种子没加载成功`);
  }
  return rows as T[];
}

export const STORES: Store[] = load<Store>("stores.json", "stores");
export const MODELS: ModelDef[] = load<ModelDef>("models.json", "models");

// ── 任意城市 + 区（M19-07）────────────────────────────────────
//
// 种子只有四个城市十家店，而演示时车主会说任何一个地方。种子外一律零命中的话，
// 助手只能一遍遍说"这个城市没有门店"——**看起来像功能坏了，其实是数据没铺开**。
//
// 所以种子之外**按 (城市, 区) 现合成**门店。三条约束让它不至于变成"编数据"：
//
//  1. **种子优先。** 命中种子就返回种子，合成只在补空缺。
//  2. **确定性。** 同一个 (城市, 区) 永远得到同一个 storeId、同一个店名。
//     不确定的话，车主第一轮看到的店第二轮就查不到了，而现象是"你选的店不存在"。
//  3. **storeId 自带来源。** id 里编进城市与区，`findStore` 因此不需要注册表，
//     **进程重启后旧 id 照样解析得开**。用内存注册表的话，重启后车主手上那个
//     storeId 就成了幽灵——他明明刚看到过这家店。
//
// 它仍然是模拟数据：整个服务的每个响应都带 `provenance: "simulated"`。

/** 合成 id 的前缀。种子 id 不长这样，所以两者永远不会撞。 */
const SYNTH_PREFIX = "gen";

/** 十六进制编码：只含 `[0-9a-f]`，不会和 `slotId` 的 `_` 分隔符打架。 */
const encodePlace = (city: string, district: string): string =>
  Buffer.from(`${city}|${district}`, "utf8").toString("hex");

function decodePlace(hex: string): { city: string; district: string } | undefined {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return undefined;
  const [city, district] = Buffer.from(hex, "hex").toString("utf8").split("|");
  return city ? { city, district: district ?? "" } : undefined;
}

/** 去掉行政区通名，留下可读的核心（`南山区` → `南山`）。 */
const districtCore = (d: string): string => d.replace(/(新区|城区|区|县|市)$/, "") || d;

/**
 * 合成门店的坐标。
 *
 * **它不是真实地理位置**，只是让 `near` 排序有个稳定的值可用。
 * 我们自己的链路从不传 `near`（子图只传 city/district），所以这个近似不影响任何
 * 已接线的行为；写在这里是为了别人拿着 `near` 调时不会收到 `undefined` 而崩。
 */
function synthCoord(key: string): { lat: number; lon: number } {
  const h = Buffer.from(key, "utf8").reduce((a, b) => (a * 31 + b) >>> 0, 7);
  return {
    lat: Math.round((18 + (h % 3500) / 100) * 1e4) / 1e4,
    lon: Math.round((75 + ((h >>> 8) % 5000) / 100) * 1e4) / 1e4,
  };
}

/** 合成一家店。`type` 决定是体验店还是服务中心。 */
function synthesizeStore(city: string, district: string, type: StoreType): Store {
  const core = district ? districtCore(district) : "";
  const suffix = type === "service" ? "服务中心" : "体验店";
  return {
    storeId: `${SYNTH_PREFIX}-${encodePlace(city, district)}-${type === "service" ? "svc" : "exp"}`,
    name: `${city}${core}${suffix}`,
    type,
    city,
    district: district || "市区",
    // 合成门店没有真实门牌号，**就不要造一个**——写"（模拟地址）"比编一个号码诚实，
    // 也让演示时一眼看得出这家店是补出来的。
    address: `${city}${core}（模拟地址）`,
    ...synthCoord(`${city}|${district}|${type}`),
    // 合成店提供全部车型：车主问哪款都该有得约，这正是本单要解决的事。
    models: MODELS.map((m) => m.model),
  };
}

/**
 * 城市/区名的合法性。
 *
 * **不是为了严谨，是为了拦住上游的解析噪音。** 上游从原话里截地名，截歪了会传来
 * 「有没有」「的试驾」这种东西，而合成是来者不拒的——于是凭空出现一家
 * 「深圳有没有体验店」。宁可这时候零命中，让上游退回去问。
 */
const PLACE_RE = /^[一-龥]{2,6}$/;
const NOT_PLACE = /[的了吗呢啊吧哈嘛有没这那哪要想帮我你他是和跟就能可试驾店门车约看找]/;

export function isPlausiblePlace(name: string): boolean {
  return PLACE_RE.test(name) && !NOT_PLACE.test(name);
}

export function findStore(storeId: string): Store | undefined {
  const seeded = STORES.find((s) => s.storeId === storeId);
  if (seeded) return seeded;

  // 合成 id 就地还原。**不查注册表**——重启后车主手上的 id 必须照样有效。
  const m = new RegExp(`^${SYNTH_PREFIX}-([0-9a-f]+)-(exp|svc)$`).exec(storeId);
  if (!m) return undefined;
  const place = decodePlace(m[1]);
  if (!place) return undefined;
  return synthesizeStore(place.city, place.district, m[2] === "svc" ? "service" : "experience");
}

export function findModel(model: string): ModelDef | undefined {
  // 大小写与空格不敏感（"model y" / "ModelY" 都算）——车型名是人打进来的。
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  return MODELS.find((m) => norm(m.model) === norm(model));
}

/** 两点球面距离（km）。只用于排序，精度够。 */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

export interface StoreQuery {
  model: string;
  city?: string;
  district?: string;
  near?: { lat: number; lon: number };
  type?: StoreType;
}

/**
 * 按车型 + 地点找店。
 *
 * **零命中仍返回空数组**，不是错误。但零命中现在只发生在三种情况：
 * 车型不认识、没给城市、或者给的"城市"根本不像个地名（见 `isPlausiblePlace`）。
 * 只要城市说得出口，就至少有一家店——种子里没有就现合成（M19-07）。
 *
 * `city` / `district` 对种子用包含匹配：用户会说"南山"而不是"南山区"。
 */
export function searchStores(q: StoreQuery): Array<Store & { distanceKm?: number }> {
  const type = q.type ?? "experience";
  const modelDef = findModel(q.model);
  const canonical = modelDef?.model;
  // 车型都不认识就没什么可给的——这一条**不合成**：
  // 合成一家"提供 Model Q 试驾"的店，等于替上游确认了一款不存在的车。
  if (!canonical) return [];

  const pool = STORES.filter((s) => s.type === type && s.models.includes(canonical));
  const byCity = q.city
    ? pool.filter((s) => s.city.includes(q.city!) || q.city!.includes(s.city))
    : pool;
  const seeded = q.district
    ? byCity.filter((s) => s.district.includes(q.district!) || q.district!.includes(s.district))
    : byCity;

  /*
   * 四段，顺序就是判断的优先级：
   *
   *  ① 种子命中 → 用种子。深圳南山永远是那家真种子店。
   *  ② 种子没命中但区名说得通 → 合成这个区的店（「深圳龙华」「北京朝阳」）。
   *  ③ 区名不像地名（上游截歪了）→ **退回城市级的种子**，别合成。
   *     少了这一段，「深圳有没有啊」会凭空得到一家「深圳体验店（模拟地址）」，
   *     而深圳明明有两家真的。
   *  ④ 城市也没有种子 → 合成城市级的一家。
   */
  let rows = seeded;
  if (rows.length === 0 && q.city && isPlausiblePlace(q.city)) {
    if (q.district && isPlausiblePlace(q.district)) rows = [synthesizeStore(q.city, q.district, type)];
    else if (byCity.length > 0) rows = byCity;
    else rows = [synthesizeStore(q.city, "", type)];
  }

  if (q.near) {
    const near = q.near;
    return rows
      .map((s) => ({ ...s, distanceKm: distanceKm(near, s) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }
  return rows;
}
