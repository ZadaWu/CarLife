/**
 * `charging` —— 充电桩查询与按续航插点（§5 工具表 / FL-18 F-18-05）。
 *
 * # 排队信息：宁可说不知道，也不给假数
 *
 * FL-18 未决原文：**充电桩排队信息在真实世界难以获得，模拟数据在演示中容易被识破。
 * 宁可明确说"排队情况无法实时获取，建议出发前确认"，也不要给假的可用数。**
 *
 * 所以返回类型里**根本没有"空闲桩数"这种字段**——和 `calendar` 不返回日程标题是同一手法：
 * 拿不到的东西在类型层面就不存在，模型没法把它编出来。能给的只有 `queueUnknown: true`
 * 与一句给用户看的话。
 *
 * # 插点是确定性算法，不是模型判断
 *
 * "开到哪该充电"由续航、SOC、安全余量算出来，是算术。交给模型会得到一个看起来合理、
 * 但经不起对账的里程数——而这条路线上错一次就是趴在高速上。
 *
 * # 质量门槛（F-18-08）
 *
 * 高德 POI 给不出实时空闲数，但给得出功率、类型与距路线偏移。按这三样筛，
 * 筛掉的理由要说出来（`rejected`），否则用户问"为什么不选那个更近的"答不上来。
 */

import { getAmapClient, type AmapPoi, type LngLat } from "./amap";
import { ENV_TTL, envCacheKey, roundCoord, withEnvCache } from "./env-cache";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";

/** 高德 POI 类型码：充电站。 */
const TYPECODE_CHARGING = "011100";

/** 到达目的地时希望剩余的电量比例——**不是 0**，留给找桩失败与绕路。 */
export const SAFETY_SOC = 0.15;

/** 单次补能到的目标 SOC。快充在 80% 以上明显变慢，充到满不划算。 */
export const TARGET_SOC = 0.8;

export interface ChargingArgs {
  /** 路线取样点，按行进顺序。通常来自 `map_route` 的 polyline 抽样。 */
  route: { name?: string; lat: number; lon: number }[];
  /** 满电续航（km），来自④车辆档案；未知时调用方不该猜。 */
  rangeKm: number;
  /** 出发时电量比例 0~1。 */
  startSoc: number;
  /** 搜索半径（米），默认沿线 5km。 */
  radiusM?: number;
  /** 最低可接受功率（kW）。省略则不按功率筛。 */
  minPowerKw?: number;
}

export interface ChargingStop {
  /** 从起点算起的累计里程（km），插点算法给出的"该充电的位置"。 */
  atKm: number;
  /** 该处附近的候选站，按推荐度排序。空数组表示**这一段没找到合规站点**。 */
  candidates: ChargingStation[];
  /** 到达此处时的预估剩余电量比例。 */
  arriveSoc: number;
}

export interface ChargingStation {
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  /** 距路线取样点的米数。 */
  detourM: number | null;
  /** 功率档位，POI 名称里能解析出来才有；解析不出就是 undefined，**不猜**。 */
  powerKw?: number;
}

export interface ChargingResult {
  stops: ChargingStop[];
  /** 全程是否需要补能。false 时 `stops` 为空。 */
  needsCharging: boolean;
  /** 被质量门槛筛掉的站点与理由（F-18-08）——用户问"为什么不选那个"要答得上。 */
  rejected: { name: string; reason: string }[];
  /**
   * 排队情况恒为不可知。**这个字段是常量 true，不是运行时判断**——
   * 写成可变的，迟早有人在某个分支里把它设成 false 并附上一个编出来的数。
   */
  queueUnknown: true;
  /** 给用户看的那句话，随结果一起交付。 */
  queueNotice: string;
}

export const QUEUE_NOTICE = "排队情况无法实时获取，建议出发前用充电运营商 App 再确认一次";

const EARTH_R = 6_371;

/** 两点间大圆距离（km）。 */
export function haversineKm(a: LngLat, b: LngLat): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

/**
 * 按续航插点：返回需要补能的累计里程位置。
 *
 * 纯算术、可单测、不碰网络。安全余量与目标 SOC 都是显式常量而不是魔数——
 * 它们决定"会不会趴在路上"，改动必须是有意识的。
 */
export function planChargeStops(
  totalKm: number,
  rangeKm: number,
  startSoc: number,
): { atKm: number; arriveSoc: number }[] {
  if (rangeKm <= 0) throw new ToolError("charging", "invalid", "续航里程必须为正数", false);
  if (startSoc <= 0 || startSoc > 1) {
    throw new ToolError("charging", "invalid", "出发电量比例必须在 (0, 1] 之间", false);
  }

  const stops: { atKm: number; arriveSoc: number }[] = [];
  let soc = startSoc;
  let cursor = 0;
  // 每次最多能开到"降到安全余量"为止
  while (true) {
    const usableSoc = soc - SAFETY_SOC;
    const reachableKm = usableSoc * rangeKm;
    if (cursor + reachableKm >= totalKm) break; // 剩下的路一口气能到
    if (reachableKm <= 0) {
      throw new ToolError(
        "charging",
        "invalid",
        `出发电量 ${(startSoc * 100).toFixed(0)}% 低于安全余量 ${SAFETY_SOC * 100}%，无法规划`,
        false,
      );
    }
    cursor += reachableKm;
    stops.push({ atKm: Math.round(cursor), arriveSoc: SAFETY_SOC });
    soc = TARGET_SOC;
    // 防御：TARGET_SOC 若被改到 <= SAFETY_SOC 会死循环，这里显式挡住
    if (stops.length > 50) {
      throw new ToolError("charging", "invalid", "插点次数异常（>50），检查续航与 SOC 参数", false);
    }
  }
  return stops;
}

/** 从 POI 名称里解析功率档位。解析不出返回 undefined——**不猜**。 */
export function parsePowerKw(name: string): number | undefined {
  const m = name.match(/(\d{2,3})\s*kw/i);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 && v <= 600 ? v : undefined;
}

export interface ChargingBackend {
  /** 沿某点搜充电站。 */
  around(at: LngLat, radiusM: number, signal?: AbortSignal): Promise<AmapPoi[]>;
}

/**
 * 坐标取整（`roundCoord`，2 位小数 ≈ 1.1km）会把附近的搜索并成同一次。
 *
 * 半径比这个尺度大不了多少时，这种并法就不成立了——把一次 500m 半径的搜索
 * 答成 1.1km 外那次的结果，是**给了错的站**，而不是给了旧的站。
 * 所以半径小于这个值时直连，不缓存。
 */
export const MIN_CACHEABLE_RADIUS_M = 2_000;

/** 高德后端：POI 类型码 011100（充电站）。 */
export function createAmapChargingBackend(): ChargingBackend {
  return {
    async around(at, radiusM, signal) {
      const client = getAmapClient();
      if (!client) {
        throw new ToolError(
          "charging",
          "unconfigured",
          "未配置高德服务端 key（AMAP_SERVER_KEY），无法查询充电站",
          false,
        );
      }
      const fetchPois = (): Promise<AmapPoi[]> =>
        client.around({ at, types: TYPECODE_CHARGING, radiusM, limit: 10 }, signal);

      // 半径太小时坐标取整会串味，直连（见 MIN_CACHEABLE_RADIUS_M）
      if (radiusM < MIN_CACHEABLE_RADIUS_M) return fetchPois();

      /*
       * ⑤缓存（M11-04 的 TTL 表这次才真正被用上）。
       *
       * **这一跳缓存起来比天气更安全**：本工具的返回类型里根本没有"空闲桩数"
       * 这种字段（见文件头——排队情况恒为不可知），所以缓存里存的全是站点位置、
       * 名称、功率这类基本不变的东西，不存在"拿旧的实时数冒充现在"的风险。
       *
       * **半径必须进键**：5km 与 20km 搜出来的是两个结果集，只按坐标做键的话，
       * 一次大半径搜索会把后续小半径搜索的答案顶掉——那是错的站，不是旧的站。
       */
      const key = envCacheKey("charging", [roundCoord(at.lat), roundCoord(at.lon), radiusM]);
      const { value } = await withEnvCache(key, ENV_TTL.charging, fetchPois);
      return value;
    },
  };
}

export function createChargingTool(backend: ChargingBackend): ExternalTool<ChargingArgs, ChargingResult> {
  return defineExternalTool<ChargingArgs, ChargingResult>({
    name: "charging",
    provider: "amap",
    // 只读查询，不产生副作用 → §8.4 第三行自动放行，不经权限门。
    sensitive: false,
    timeoutMs: 8_000,
    retries: 2,

    real: async (args, ctx) => {
      if (args.route.length < 2) {
        throw new ToolError("charging", "invalid", "路线至少需要两个取样点", false);
      }

      // 累计里程表：取样点 i 处的从起点里程
      const cum: number[] = [0];
      for (let i = 1; i < args.route.length; i += 1) {
        cum.push(cum[i - 1] + haversineKm(args.route[i - 1], args.route[i]));
      }
      const totalKm = cum[cum.length - 1];

      const planned = planChargeStops(totalKm, args.rangeKm, args.startSoc);
      if (planned.length === 0) {
        return {
          stops: [],
          needsCharging: false,
          rejected: [],
          queueUnknown: true,
          queueNotice: QUEUE_NOTICE,
        };
      }

      const rejected: { name: string; reason: string }[] = [];
      const stops: ChargingStop[] = [];

      for (const p of planned) {
        // 找到累计里程最接近插点位置的取样点
        let idx = 0;
        for (let i = 1; i < cum.length; i += 1) {
          if (Math.abs(cum[i] - p.atKm) < Math.abs(cum[idx] - p.atKm)) idx = i;
        }
        const at = args.route[idx];
        const pois = await backend.around(at, args.radiusM ?? 5_000, ctx.signal);

        const candidates: ChargingStation[] = [];
        for (const poi of pois) {
          const powerKw = parsePowerKw(poi.name);
          // 质量门槛：功率不达标的筛掉，**但理由要留下**（F-18-08）
          if (args.minPowerKw !== undefined && powerKw !== undefined && powerKw < args.minPowerKw) {
            rejected.push({ name: poi.name, reason: `功率 ${powerKw}kW 低于要求的 ${args.minPowerKw}kW` });
            continue;
          }
          candidates.push({
            id: poi.id,
            name: poi.name,
            address: poi.address,
            lat: poi.lat,
            lon: poi.lon,
            detourM: poi.distanceM,
            powerKw,
          });
        }
        // 近的排前面；距离未知的排后面（不假装它很近）
        candidates.sort((a, b) => (a.detourM ?? Infinity) - (b.detourM ?? Infinity));

        stops.push({ atKm: p.atKm, arriveSoc: p.arriveSoc, candidates });
      }

      return { stops, needsCharging: true, rejected, queueUnknown: true, queueNotice: QUEUE_NOTICE };
    },

    mock: (args) => {
      const planned = planChargeStops(300, args.rangeKm || 400, args.startSoc || 0.9);
      return {
        stops: planned.map((p) => ({
          atKm: p.atKm,
          arriveSoc: p.arriveSoc,
          candidates: [
            {
              id: "mock-cs-1",
              name: "模拟充电站（120kW）",
              address: "模拟地址",
              lat: 0,
              lon: 0,
              detourM: 800,
              powerKw: 120,
            },
          ],
        })),
        needsCharging: planned.length > 0,
        rejected: [],
        queueUnknown: true,
        queueNotice: QUEUE_NOTICE,
      };
    },
  });
}

export const chargingTool = createChargingTool(createAmapChargingBackend());
