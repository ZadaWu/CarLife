/**
 * `refuel` —— 沿路线查加油站（§5 工具表 / FL-18）。
 *
 * # 它不是 `charging` 的复制品，差别在一件要命的事上
 *
 * `charging` 的核心是**按续航插点**：知道满电续航与出发 SOC，就能算出"开到第几公里必须充"。
 * 那是算术，可单测，错一次就是趴在高速上，所以绝不交给模型。
 *
 * **燃油车这边算不了**——我们没有实时油量。④车辆档案里有 VIN、里程、保养史，
 * 没有油表读数，车机也没往上报。于是"开到哪该加油"这个问题**没有数据源**。
 *
 * 照抄插点算法的诱惑很大：假设一个油箱容量、假设一个百公里油耗、假设出发是满箱，
 * 就能产出一串看起来很专业的公里数。**那是编的**，而且比不给严重得多——
 * 车主会照着它安排，直到某次假设不成立。
 *
 * 所以这个工具只做一件它做得到的事：**沿路线均匀取点，告诉你路过哪儿有加油站**。
 * "要不要加、什么时候加"交还给车主，并且在结果里明说我们不知道。
 *
 * # 和 `charging` 一致的那部分
 *
 * 拿不到的东西**在类型层面就不存在**（`charging` 的 `queueUnknown` 是同一手法）：
 * 这里没有"还能跑多少公里""建议在此加满"这类字段，模型没有地方把它编出来。
 * `fuelLevelUnknown` 是常量 `true` 而不是运行时判断——写成可变的，
 * 迟早有人在某个分支里把它设成 false 并附上一个假的油量。
 */

import { getAmapClient, type AmapPoi, type LngLat } from "./amap";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";
import { haversineKm } from "./charging";

/** 高德 POI 类型码：加油站。 */
const TYPECODE_REFUEL = "010100";

/** 沿线取点间隔的默认值（km）。100km 大约是高速上两三个服务区的跨度。 */
export const DEFAULT_EVERY_KM = 100;

/** 取点数量上限——跨省长途也不该返回几十组候选，那是把筛选工作推给模型。 */
export const MAX_SAMPLE_POINTS = 6;

export interface RefuelArgs {
  /** 路线取样点，按行进顺序。通常来自 `map_route` 的 `sampledPoints`。 */
  route: { name?: string; lat: number; lon: number }[];
  /** 沿线每隔多少公里取一个查询点，默认 100。 */
  everyKm?: number;
  /** 搜索半径（米），默认沿线 5km。 */
  radiusM?: number;
}

export interface FuelStation {
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  /** 距路线取样点的米数。 */
  detourM: number | null;
  /**
   * 品牌，从 POI 名称里认出来才有；认不出就是 undefined，**不猜**。
   * 与 `charging.parsePowerKw` 同一原则：解析不出宁可留空。
   */
  brand?: string;
}

export interface RefuelStop {
  /** 从起点算起的累计里程（km）。**这是"路过这里"，不是"该在这里加油"。** */
  atKm: number;
  /** 该处附近的候选站。空数组表示这一段沿线没搜到。 */
  candidates: FuelStation[];
}

export interface RefuelResult {
  stops: RefuelStop[];
  /**
   * 油量恒为不可知。**常量 true，不是运行时判断**——见文件头。
   */
  fuelLevelUnknown: true;
  /** 随结果一起交付给用户的那句话。 */
  fuelNotice: string;
}

export const FUEL_NOTICE =
  "系统没有这辆车的实时油量，判断不了是否必须加油、也算不出还能跑多远；" +
  "以下只是沿线路过的加油站，请按车上油表自行决定";

/** 从 POI 名称里认品牌。认不出返回 undefined——**不猜**。 */
export function parseBrand(name: string): string | undefined {
  const brands = ["中国石化", "中国石油", "中石化", "中石油", "壳牌", "BP", "道达尔", "埃索"];
  return brands.find((b) => name.includes(b));
}

export interface RefuelBackend {
  around(at: LngLat, radiusM: number, signal?: AbortSignal): Promise<AmapPoi[]>;
}

export function createAmapRefuelBackend(): RefuelBackend {
  return {
    async around(at, radiusM, signal) {
      const client = getAmapClient();
      if (!client) {
        throw new ToolError(
          "refuel",
          "unconfigured",
          "未配置高德服务端 key（AMAP_SERVER_KEY），无法查询加油站",
          false,
        );
      }
      return client.around({ at, types: TYPECODE_REFUEL, radiusM, limit: 10 }, signal);
    },
  };
}

/**
 * 沿线按固定间隔取查询点。
 *
 * 纯算术、可单测、不碰网络。**刻意不含任何油量假设**——
 * 它回答的是"路线上每隔 N 公里在哪儿"，不是"什么时候该加油"。
 */
export function planSamplePoints(totalKm: number, everyKm: number): number[] {
  if (everyKm <= 0) {
    throw new ToolError("refuel", "invalid", "取点间隔必须为正数", false);
  }
  const out: number[] = [];
  for (let km = everyKm; km < totalKm && out.length < MAX_SAMPLE_POINTS; km += everyKm) {
    out.push(Math.round(km));
  }
  return out;
}

export function createRefuelTool(backend: RefuelBackend): ExternalTool<RefuelArgs, RefuelResult> {
  return defineExternalTool<RefuelArgs, RefuelResult>({
    name: "refuel",
    provider: "amap",
    // 只读查询，不产生副作用 → §8.4 第三行自动放行，不经权限门。
    sensitive: false,
    timeoutMs: 8_000,
    retries: 2,

    real: async (args, ctx) => {
      if (args.route.length < 2) {
        throw new ToolError("refuel", "invalid", "路线至少需要两个取样点", false);
      }

      const cum: number[] = [0];
      for (let i = 1; i < args.route.length; i += 1) {
        cum.push(cum[i - 1] + haversineKm(args.route[i - 1], args.route[i]));
      }
      const totalKm = cum[cum.length - 1];

      const planned = planSamplePoints(totalKm, args.everyKm ?? DEFAULT_EVERY_KM);
      const stops: RefuelStop[] = [];

      for (const atKm of planned) {
        let idx = 0;
        for (let i = 1; i < cum.length; i += 1) {
          if (Math.abs(cum[i] - atKm) < Math.abs(cum[idx] - atKm)) idx = i;
        }
        const pois = await backend.around(args.route[idx], args.radiusM ?? 5_000, ctx.signal);
        stops.push({
          atKm,
          candidates: pois.map((poi) => ({
            id: poi.id,
            name: poi.name,
            address: poi.address,
            lat: poi.lat,
            lon: poi.lon,
            detourM: poi.distanceM ?? null,
            brand: parseBrand(poi.name),
          })),
        });
      }

      return { stops, fuelLevelUnknown: true, fuelNotice: FUEL_NOTICE };
    },

    mock: () => ({
      stops: [
        {
          atKm: 100,
          candidates: [
            {
              id: "mock-fuel-1",
              name: "中国石化 沪苏高速服务区加油站",
              address: "（模拟数据）",
              lat: 31.5,
              lon: 121.0,
              detourM: 320,
              brand: "中国石化",
            },
          ],
        },
      ],
      fuelLevelUnknown: true,
      fuelNotice: FUEL_NOTICE,
    }),
  });
}

export const refuelTool = createRefuelTool(createAmapRefuelBackend());
