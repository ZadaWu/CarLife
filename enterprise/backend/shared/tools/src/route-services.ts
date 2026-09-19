/**
 * `route_services` —— 停靠点周边的沿途服务：餐饮 / 公共厕所 / 停车场 / 高速服务区
 * （行程详情「沿途服务」数据源交接，待执行事项 4；FL-18 F-18-04 / F-18-08）。
 *
 * # 它回答的是哪个问题
 *
 * 行程详情抽屉的五格里，餐饮 / 卫生间 / 停车场三格此前恒显「待查」——工具层没有数据源。
 * `probe:route-services` 实测过可得性：沿 352km 真实路线每 40km 取一点，餐饮 8/10 点命中、
 * 公厕 7/10、停车场 8/10，类目码都在。本工具把那次探针的查法做成正式工具。
 *
 * # 四条从探针带来的约束（交接文档原文，逐条落在代码里）
 *
 * 1. **直线半径内不等于可达。** 高速段命中的餐饮多在下道后的镇上。所以本工具**不沿折线取样**——
 *    入参是调用方给的**停靠点**（景点 / 酒店，已解析坐标），围绕它们查；高速段单独按
 *    `service_area`（180301）查，一个服务区同时覆盖用餐、卫生间与停车。
 * 2. **`200300` 是大类**，含无障碍卫生间（200303）与母婴室（200304）。母婴室不是厕所，
 *    计数时剔掉（`NURSERY_ROOM_TYPECODE`）；其余保留并带 typecode，展示层可标类型。
 * 3. **偏远路段返回空是真实结果。** 返回里"查过了没有"（`pois: []`、`queriedPoints > 0`）
 *    与"没查成"（`queriedPoints === 0`）是两种形状，调用方据此区分「0 个」与「待查」。
 * 4. **请求预算。** 高德闸门每把 key 一条车道、350ms 最小间隔、排队封顶 6 秒——
 *    一次并发打几十个请求会有一半撞上排队上限。所以这里**串行**逐点逐类目发，
 *    单点失败只记账不中断（`failedPoints`），调用方在**行程落库后的后台**调它，不在抽屉打开时。
 *
 * # 与 `charging` / `refuel` 的关系
 *
 * 同一个高德 `/v5/place/around`，同一套 ⑤缓存（`ENV_TTL.routeServices`，键含半径与类目码）。
 * 不并进那两个工具：它们是按行进里程插点的"路过哪儿有"，本工具是围绕停靠点的"到了这儿附近有什么"，
 * 取样逻辑相反。
 */

import { getAmapClient, type AmapPoi, type LngLat } from "./amap";
import { ENV_TTL, envCacheKey, roundCoord, withEnvCache } from "./env-cache";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";

export type ServiceCategory = "food" | "restroom" | "parking" | "charging" | "service_area";

/** 高德 POI 类目码。与 `probe:route-services` 用的同一组，改这里要同步改探针。 */
export const SERVICE_TYPECODES: Record<ServiceCategory, string> = {
  food: "050000",
  restroom: "200300",
  parking: "150900",
  // 充电站（M93-04）：`poi-search.ts` 的 `charging_station` 同一个码，M36-01 实测
  // `011100` 能召回梅岑路国网充电站。加它是因为那一格从前读的是 drive 分支求解出来的
  // `energyStops`——车没有实测续航时分支按纪律交空数组，于是"充电站"恒显「无需补能」，
  // 而周边到底有没有桩，根本没人查过。
  charging: "011100",
  service_area: "180301",
};

/**
 * 各类目的默认搜索半径（米）。服务区给到 8km：它们本来就隔得远，3km 等于只在恰好停在门口时才命中；
 * 其余三项按"下车走两步"的尺度取 3km。
 */
export const SERVICE_RADIUS_M: Record<ServiceCategory, number> = {
  food: 3_000,
  restroom: 3_000,
  parking: 3_000,
  charging: 3_000,
  service_area: 8_000,
};

/**
 * ⑤缓存的命名空间按类目分开（`svc-food` / `svc-restroom` / …），不合在一个 `route-services` 里：
 * 控制台的命名空间胶囊按命名空间计数，合在一起看不出"四类各缓存了多少"
 * （2026-09-16 走查：在 ⑤ 面板找不到沿途服务的餐饮 / 卫生间 / 停车场 / 充电站）。
 * 类目码仍进键——键的各段是（取整坐标、半径、类目码），与探针同一份码表。
 * 控制台 `env-cache-format.ts` 的 `NS_LABEL` 与服务端 `env-cache-summary.ts` 都按这组名字认。
 */
export function serviceCacheNamespace(category: ServiceCategory): string {
  return `svc-${category}`;
}

function categoryOfTypecode(typecode: string): ServiceCategory | undefined {
  return (Object.keys(SERVICE_TYPECODES) as ServiceCategory[]).find((c) => SERVICE_TYPECODES[c] === typecode);
}

/** 母婴室：在 200300 大类里，但不是厕所。 */
export const NURSERY_ROOM_TYPECODE = "200304";

/** 每个取样点每类目最多取多少条（高德 page_size 上限 25）。计数到顶就是"25+"，展示层自己标。 */
export const MAX_PER_POINT = 25;

/** 一次调用最多几个点：一天的停靠点 + 高速取样点都够；再多是调用方切分不当。 */
export const MAX_POINTS = 20;

const DEFAULT_CATEGORIES: readonly ServiceCategory[] = ["food", "restroom", "parking", "charging"];

export interface RouteServicesArgs {
  /** 查询中心：当天的停靠点（已解析坐标），或高速段的取样点。 */
  points: { name?: string; lat: number; lon: number }[];
  /** 要查的类目；缺省餐饮 / 公厕 / 停车场 / 充电站四项。 */
  categories?: ServiceCategory[];
  /** 覆盖四项日常类目的半径（米）；服务区不受它影响。 */
  radiusM?: number;
}

export interface ServicePoi {
  id: string;
  name: string;
  lat: number;
  lon: number;
  typecode: string;
  address?: string;
}

/** 一个类目的结果。`queriedPoints === 0` = 一个点都没查成，与 `pois: []` 的"查过了没有"必须分开读。 */
export interface ServiceCategoryResult {
  /** 按 POI id 去重后的命中。 */
  pois: ServicePoi[];
  /** 成功查询的取样点数。 */
  queriedPoints: number;
  /** 失败（限流 / 超时 / 上游错）的取样点数。 */
  failedPoints: number;
}

export interface RouteServicesResult {
  food?: ServiceCategoryResult;
  restroom?: ServiceCategoryResult;
  parking?: ServiceCategoryResult;
  charging?: ServiceCategoryResult;
  service_area?: ServiceCategoryResult;
  /** 四项日常类目实际用的半径（米）。 */
  radiusM: number;
  /** 口径声明，随结果交付。 */
  notice: string;
}

export const ROUTE_SERVICES_NOTICE =
  "计数是停靠点周边直线半径内的高德 POI 数，不等于可达、未核实营业状态；高速段以服务区为单位另列。";

export interface RouteServicesBackend {
  around(at: LngLat, typecode: string, radiusM: number, signal?: AbortSignal): Promise<AmapPoi[]>;
}

/** 高德后端：走 ⑤缓存（半径与类目码都进键，见 `charging.ts` 对"半径必须进键"的说明）。 */
export function createAmapRouteServicesBackend(): RouteServicesBackend {
  return {
    async around(at, typecode, radiusM, signal) {
      const client = getAmapClient();
      if (!client) {
        throw new ToolError("route_services", "unconfigured", "未配置高德服务端 key（AMAP_SERVER_KEY），无法查询沿途服务", false);
      }
      const category = categoryOfTypecode(typecode);
      const ns = category ? serviceCacheNamespace(category) : "route-services";
      const key = envCacheKey(ns, [roundCoord(at.lat), roundCoord(at.lon), radiusM, typecode]);
      const { value } = await withEnvCache(key, ENV_TTL.routeServices, () =>
        client.around({ at, types: typecode, radiusM, limit: MAX_PER_POINT }, signal),
      );
      return value;
    },
  };
}

function toPoi(p: AmapPoi): ServicePoi {
  return {
    id: p.id,
    name: p.name,
    lat: p.lat,
    lon: p.lon,
    typecode: p.typecode,
    ...(p.address ? { address: p.address } : {}),
  };
}

export function createRouteServicesTool(backend: RouteServicesBackend): ExternalTool<RouteServicesArgs, RouteServicesResult> {
  return defineExternalTool<RouteServicesArgs, RouteServicesResult>({
    name: "route_services",
    provider: "amap",
    // 只读查询，不产生副作用。
    sensitive: false,
    // 串行逐点逐类目：20 点 × 4 类目 × 350ms 闸门 ≈ 28s，上限给足；**不重试**——
    // 单点失败已在结果里记账，整体重试只会把成功的那些再打一遍。
    timeoutMs: 90_000,
    retries: 0,

    real: async (args, ctx) => {
      if (args.points.length === 0) {
        throw new ToolError("route_services", "invalid", "至少需要一个停靠点", false);
      }
      if (args.points.length > MAX_POINTS) {
        throw new ToolError("route_services", "invalid", `一次最多 ${MAX_POINTS} 个点，请按天切分`, false);
      }
      const categories = args.categories?.length ? [...new Set(args.categories)] : [...DEFAULT_CATEGORIES];
      const radiusM = args.radiusM ?? SERVICE_RADIUS_M.food;
      const out: RouteServicesResult = { radiusM, notice: ROUTE_SERVICES_NOTICE };

      for (const category of categories) {
        const r = category === "service_area" ? SERVICE_RADIUS_M.service_area : radiusM;
        const seen = new Map<string, ServicePoi>();
        let queriedPoints = 0;
        let failedPoints = 0;
        for (const at of args.points) {
          // 串行：闸门排队封顶 6 秒，并发打会有一半直接撞上上限（约束 4）。
          try {
            const pois = await backend.around(at, SERVICE_TYPECODES[category], r, ctx.signal);
            queriedPoints += 1;
            for (const p of pois) {
              // 母婴室不是厕所（约束 2）。
              if (category === "restroom" && p.typecode === NURSERY_ROOM_TYPECODE) continue;
              if (!seen.has(p.id)) seen.set(p.id, toPoi(p));
            }
          } catch (err) {
            failedPoints += 1;
            // 取消是调用方的意思，别吞成"这个点没查到"。
            if (ctx.signal?.aborted) throw err;
          }
        }
        out[category] = { pois: [...seen.values()], queriedPoints, failedPoints };
      }
      return out;
    },

    mock: (args) => {
      const categories = args.categories?.length ? [...new Set(args.categories)] : [...DEFAULT_CATEGORIES];
      const radiusM = args.radiusM ?? SERVICE_RADIUS_M.food;
      const out: RouteServicesResult = { radiusM, notice: ROUTE_SERVICES_NOTICE };
      const mockPois: Record<ServiceCategory, ServicePoi[]> = {
        food: [
          { id: "mock-food-1", name: "老街面馆（模拟）", lat: 0, lon: 0, typecode: "050100" },
          { id: "mock-food-2", name: "湖畔咖啡（模拟）", lat: 0, lon: 0, typecode: "050500" },
        ],
        restroom: [{ id: "mock-wc-1", name: "游客中心公共厕所（模拟）", lat: 0, lon: 0, typecode: "200300" }],
        parking: [
          { id: "mock-park-1", name: "景区北门停车场（模拟）", lat: 0, lon: 0, typecode: "150900" },
          { id: "mock-park-2", name: "游客中心地面停车场（模拟）", lat: 0, lon: 0, typecode: "150900" },
        ],
        charging: [
          { id: "mock-chg-1", name: "国网充电站·景区北门（模拟）", lat: 0, lon: 0, typecode: "011100" },
          { id: "mock-chg-2", name: "特来电充电站·酒店地库（模拟）", lat: 0, lon: 0, typecode: "011100" },
        ],
        service_area: [{ id: "mock-sa-1", name: "沪苏高速服务区（模拟）", lat: 0, lon: 0, typecode: "180301" }],
      };
      for (const category of categories) {
        out[category] = { pois: mockPois[category], queriedPoints: args.points.length, failedPoints: 0 };
      }
      return out;
    },
  });
}

export const routeServicesTool = createRouteServicesTool(createAmapRouteServicesBackend());
