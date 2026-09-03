/**
 * `transit_route` —— 跨城大交通：火车方案（施工单 M12-01）。
 *
 * # 只有火车，没有飞机，这是接口的结构性事实
 *
 * 高德 transit/integrated 的 segment 类型只有 bus/entrance/exit/railway/taxi/walking
 * ——实测沪→乌鲁木齐（现实里没人不坐飞机的线路）只回 41 小时的火车方案。
 * 出参的 `note` 恒定声明这一点，让下游表述层知道"没有航班"是覆盖问题不是查询失败。
 *
 * 火车段是**真数据**：真车次（D941）、真时长、真分席别票价（实测 860/960/970 元）。
 *
 * # strategy 多档合并
 *
 * 单档实测覆盖不全（沪广线未出 G 字头）。这里按多个 strategy 各取一次、按车次序列
 * 去重合并；仍不全就如实返回已有方案——**不补、不猜**（M12-01 关键约束）。
 */

import { getAmapClient, type AmapTransit, type LngLat } from "./amap";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";

/** 依次尝试的 strategy 档位：0 最快捷 / 1 最经济 / 2 最少换乘。 */
const STRATEGIES = [0, 1, 2] as const;

export interface TransitRouteArgs {
  /** 出发城市（中文名）。 */
  fromCity: string;
  /** 到达城市（中文名）。 */
  toCity: string;
}

export interface TrainOption {
  /** 车次序列（中转为多段），如 ["G4822(上海虹桥-西安北)", "D2701(西安北-乌鲁木齐)"]。 */
  trains: string[];
  durationMin: number;
  /** 整套方案票价（元）；接口没给就 null，不算不猜。 */
  costYuan: number | null;
  /** 首段的分席别票价（元），供表述"二等座约 X 元"。 */
  firstLegPrices: number[];
}

export interface TransitRouteResult {
  fromCity: string;
  toCity: string;
  options: TrainOption[];
  /** 恒定声明：本接口只覆盖火车。 */
  note: string;
}

/**
 * 空结果的补充说明。**必须写明"这不是查询失败"**——否则表述层按
 * 「结果里没有的就说没查到」的铁律，会把"同城不需要坐火车"讲成"大交通没查到"，
 * 听起来像系统出了问题，而实际上答案就是"开车过去"。
 */
export const NO_TRAIN_NOTE =
  " 本次未查到火车方案：两地间没有铁路直达（同城或近距离时属正常），" +
  "请按自驾/打车表述，不要说成「查询失败」。";

export const TRANSIT_NOTE =
  "仅含火车方案（真实车次与票价）。航班本接口结构性不覆盖——" +
  "提及飞机时只能给时长与票价的经验估算并明确标注，禁止编造具体航班号。";

export interface TransitBackend {
  geocode(city: string, signal?: AbortSignal): Promise<LngLat>;
  transitIntegrated(
    params: { origin: LngLat; destination: LngLat; city: string; cityd: string; strategy: number },
    signal?: AbortSignal,
  ): Promise<AmapTransit[]>;
}

function createAmapTransitBackend(): TransitBackend {
  return {
    async geocode(city, signal) {
      const amap = getAmapClient();
      if (!amap) throw new ToolError("transit_route", "unconfigured", "高德未接入（缺 AMAP_SERVER_KEY）", false);
      return amap.geocode(city, city, signal);
    },
    transitIntegrated(params, signal) {
      const amap = getAmapClient();
      if (!amap) throw new ToolError("transit_route", "unconfigured", "高德未接入（缺 AMAP_SERVER_KEY）", false);
      return amap.transitIntegrated(params, signal);
    },
  };
}

/** 方案指纹 = 车次序列。同一串车次在不同 strategy 下重复出现是常态。 */
function fingerprint(t: AmapTransit): string {
  return t.trains.map((x) => x.no).join(">");
}

export function createTransitRouteTool(
  backend: TransitBackend,
): ExternalTool<TransitRouteArgs, TransitRouteResult> {
  return defineExternalTool<TransitRouteArgs, TransitRouteResult>({
    name: "transit_route",
    provider: "amap",
    sensitive: false,
    // 三档 strategy 串行，超时给足；重试交给底层 amap 客户端的 infocode 分类。
    timeoutMs: 25_000,
    retries: 1,

    real: async (args, ctx) => {
      const from = args.fromCity.trim();
      const to = args.toCity.trim();
      if (!from || !to) throw new ToolError("transit_route", "invalid", "fromCity/toCity 不能为空", false);

      const [origin, destination] = await Promise.all([
        backend.geocode(from, ctx.signal),
        backend.geocode(to, ctx.signal),
      ]);

      const seen = new Map<string, AmapTransit>();
      /*
       * 记住"有没有哪一档真的问通了"。空结果有两种成因，处置相反：
       * 三档全抛 = 上游坏了，要报错重试；问通了但没有火车 = 这条线本来就没有，
       * 是**答案**。不区分的话，同城短途每次都当故障重试。
       */
      let reachedUpstream = false;
      for (const strategy of STRATEGIES) {
        try {
          const batch = await backend.transitIntegrated(
            { origin, destination, city: from, cityd: to, strategy },
            ctx.signal,
          );
          reachedUpstream = true;
          for (const t of batch) {
            const key = fingerprint(t);
            if (!seen.has(key)) seen.set(key, t);
          }
        } catch {
          // 单档失败不整体失败：三档里拿到多少算多少，拿不到的档不补不猜。
        }
      }

      const options = [...seen.values()]
        .sort((a, b) => a.durationMin - b.durationMin)
        .slice(0, 6)
        .map((t) => ({
          trains: t.trains.map((x) => x.no),
          durationMin: t.durationMin,
          costYuan: t.costYuan,
          firstLegPrices: t.trains[0]?.prices ?? [],
        }));

      if (options.length === 0) {
        /*
         * 上游都没问通才算失败。
         *
         * 问通了却没有火车方案，是同城/近距离的**常态**——上海静安→上海嘉定
         * 就是这样。从前这里一律抛 ToolError，于是每次规划市内两日游，
         * transit 分支都以 `failed` 收场（实测 turn-7481f04c / d65a0a10 各一次），
         * 轨迹上看像是"查询挂了"，而真相是"这段路本来就不该坐火车"。
         */
        if (!reachedUpstream) {
          throw new ToolError("transit_route", "upstream", `${from}→${to} 大交通查询未成功`, true);
        }
        return { fromCity: from, toCity: to, options, note: `${TRANSIT_NOTE}${NO_TRAIN_NOTE}` };
      }
      return { fromCity: from, toCity: to, options, note: TRANSIT_NOTE };
    },

    mock: (args) => ({
      fromCity: args.fromCity,
      toCity: args.toCity,
      options: [
        { trains: ["G99(上海虹桥-广州南)（模拟）"], durationMin: 417, costYuan: 793, firstLegPrices: [793, 1264] },
        { trains: ["D941(上海虹桥-珠海)（模拟）"], durationMin: 658, costYuan: 609, firstLegPrices: [860, 960] },
      ],
      note: TRANSIT_NOTE,
    }),
  });
}

export const transitRouteTool = createTransitRouteTool(createAmapTransitBackend());
