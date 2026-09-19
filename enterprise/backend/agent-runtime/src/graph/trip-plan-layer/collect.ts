/**
 * 1a `planCollect`：编排层自己搜景点，凑出一份**有地理分布**的候选池（施工单 M86-02，ACR-037）。
 *
 * # 为什么搜索从 tour 会话搬到这里
 *
 * 9/13 起 tour 的提示词让模型"按类型分组、一轮搜满 20 条"，片区结构在搜索那一刻就没了，
 * 只能靠模型自己重建——而 9/10 换代后的模型不再做这一步（设计定稿 §1）。
 * 编排层搜，分组就能交给代码（`group.ts`），提示词里的那句希望变成产物。
 *
 * # 按区县分次，不按类型
 *
 * 2026-09-15 实测杭州：`keywords:"景点"` 的 20 条全在上城 / 西湖 / 钱江新城，良渚、千岛湖一个都没有；
 * `keywords:"余杭区 景点"` 才有良渚博物院、梦想小镇、宝寿山。所以：热门一组打底、室内馆一组作雨备池、
 * 再按区县各搜一组。区县从 `city_districts` 来；**先搜热门结果落在过的区县**（那里有名气大的点，
 * 再多找几个同片区的就是一天），再按行政区划顺序补，总数封顶 `PLAN_DISTRICT_SEARCHES_MAX`——
 * 搜索是月配额 5000 次的那一类，每次规划的调用数写死、实际数记进 span。
 *
 * # 名字与坐标只来自工具返回
 *
 * 候选池的每一项都是 `spot_search` 返回里的一条（名字逐字、坐标原样），这里不改写、不补、不猜（ADR-008）。
 * 唯一的排序规则是数据给的：高德评分 `"0.0"`（没人评过的子门 / 打卡点）排到池尾，仍可作备选。
 */

import { PLAN_DISTRICT_LIMIT, PLAN_DISTRICT_SEARCHES_MAX, PLAN_HOT_LIMIT, PLAN_INDOOR_LIMIT } from "./config";
import type { PlanSpot } from "./types";

/** 编排层调工具的最小接口：`index.ts` 缺省包 `invokeTool(..., { agent: "trip" })`，单测注入假实现。 */
export type ToolInvoke = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** 室内馆一组的关键词——每天的 rainBackup 从这一组挑；与 `spot_search` 的 promptGuidelines 同一口径。 */
export const INDOOR_KEYWORDS = "博物馆 展览馆 美术馆 科技馆";
export const HOT_KEYWORDS = "景点";

export interface CollectInput {
  destination: string;
  invoke: ToolInvoke;
}

export interface CollectOutput {
  /** 聚类用的候选池：热门 → 区县 → 室内馆，按名字去重保序，"0.0" 评分沉底。 */
  pool: PlanSpot[];
  /** 室内馆那一组（去重后），每天的雨备从这里挑。 */
  rainPool: PlanSpot[];
  /** 本次实际发出的工具调用数（含 `city_districts` 那一次）。 */
  calls: number;
  /** 失败的调用数——单组失败不拖垮整体，只记账。 */
  failed: number;
  /** 实际搜了几个区县。 */
  districtsSearched: number;
}

interface RawCandidate {
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
  district?: unknown;
  rating?: unknown;
  address?: unknown;
}

function candidatesOf(res: unknown): RawCandidate[] {
  const data = (res as { data?: { candidates?: unknown } } | undefined)?.data;
  const list = data?.candidates;
  return Array.isArray(list) ? (list as RawCandidate[]) : [];
}

function toSpot(c: RawCandidate, indoor: boolean): PlanSpot | undefined {
  if (typeof c.name !== "string" || !c.name.trim()) return undefined;
  if (typeof c.lat !== "number" || typeof c.lon !== "number" || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return undefined;
  return {
    name: c.name,
    lat: c.lat,
    lon: c.lon,
    ...(typeof c.district === "string" && c.district ? { district: c.district } : {}),
    ...(typeof c.rating === "string" && c.rating ? { rating: c.rating } : {}),
    ...(typeof c.address === "string" && c.address ? { address: c.address } : {}),
    indoor,
  };
}

function districtsOf(res: unknown): string[] {
  const data = (res as { data?: { districts?: unknown } } | undefined)?.data;
  const list = Array.isArray(data?.districts) ? (data!.districts as Array<{ name?: unknown }>) : [];
  return list.map((d) => d.name).filter((n): n is string => typeof n === "string" && n.length > 0);
}

/**
 * 区县的搜索顺序：热门结果里出现过的区县（按出现次数，多的在前）→ 行政区划顺序补齐。
 * 只取 `city_districts` 认识的名字：热门结果里的 `district` 若不在区县清单里（跨市的点）不单独搜。
 */
export function rankDistricts(hot: readonly PlanSpot[], districts: readonly string[], max: number): string[] {
  const counts = new Map<string, number>();
  for (const s of hot) if (s.district && districts.includes(s.district)) counts.set(s.district, (counts.get(s.district) ?? 0) + 1);
  const byHot = [...counts.entries()].sort((a, b) => b[1] - a[1] || districts.indexOf(a[0]) - districts.indexOf(b[0])).map(([n]) => n);
  const rest = districts.filter((d) => !counts.has(d));
  return [...byHot, ...rest].slice(0, Math.max(0, max));
}

/**
 * 候选池凑不出来也返回（pool 为空）而不是 undefined：调用方要的是"发了几次、失败几次"——
 * M87-04 冒烟里 Plan 层跳过时 span 只剩 `{"skipped":"no-candidates","calls":0}`，看不出是没搜还是全失败。
 */
export async function planCollect(input: CollectInput): Promise<CollectOutput> {
  const { destination, invoke } = input;
  let calls = 0;
  let failed = 0;

  const search = async (keywords: string, limit: number, indoor: boolean): Promise<PlanSpot[]> => {
    calls += 1;
    try {
      const res = await invoke("spot_search", { city: destination, keywords, limit });
      return candidatesOf(res)
        .map((c) => toSpot(c, indoor))
        .filter((s): s is PlanSpot => s !== undefined);
    } catch {
      failed += 1;
      return [];
    }
  };
  const listDistricts = async (): Promise<string[]> => {
    calls += 1;
    try {
      return districtsOf(await invoke("city_districts", { city: destination }));
    } catch {
      failed += 1;
      return [];
    }
  };

  // 第一波三路并发：热门、室内馆、区县清单。
  const [hot, indoor, districts] = await Promise.all([search(HOT_KEYWORDS, PLAN_HOT_LIMIT, false), search(INDOOR_KEYWORDS, PLAN_INDOOR_LIMIT, true), listDistricts()]);

  // 第二波：按区县各一组。并发发出，闸门在高德客户端里排队（QPS 由它管，这里不再限）。
  const picked = rankDistricts(hot, districts, PLAN_DISTRICT_SEARCHES_MAX);
  const perDistrict = await Promise.all(picked.map((d) => search(`${d} ${HOT_KEYWORDS}`, PLAN_DISTRICT_LIMIT, false)));

  const seen = new Set<string>();
  const pool: PlanSpot[] = [];
  const push = (s: PlanSpot): void => {
    if (seen.has(s.name)) return;
    seen.add(s.name);
    pool.push(s);
  };
  for (const s of hot) push(s);
  for (const list of perDistrict) for (const s of list) push(s);
  for (const s of indoor) push(s);

  // 数据给的唯一排序规则：没人评过的（"0.0"）沉底，其余保持搜索相关度顺序。
  const ranked = [...pool.filter((s) => s.rating !== "0.0"), ...pool.filter((s) => s.rating === "0.0")];
  const rainSeen = new Set<string>();
  const rainPool = indoor.filter((s) => (rainSeen.has(s.name) ? false : (rainSeen.add(s.name), true)));
  return { pool: ranked, rainPool, calls, failed, districtsSearched: picked.length };
}
