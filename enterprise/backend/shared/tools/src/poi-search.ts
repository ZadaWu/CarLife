/**
 * `poi_search` —— 城市内 POI 文本搜索：酒店与景点（施工单 M12-01）。
 *
 * # 为它服务的问题
 *
 * 「广州 4 天带娃，住哪、玩哪」——此前工具表全是"开车"视角（路线/补能/天气），
 * 实测轮 turn-7a5e50c4 应答只能说"酒店和游玩地点没查到"。本工具补上数据源：
 * 高德 place/text，**名称/位置/评分是真的**。
 *
 * # 结构性没有价格字段
 *
 * 实测（2026-08-11）`business.cost` 酒店类目恒空（含白天鹅宾馆）——高德 App 里的
 * 房价是它的商业化业务，不走开放平台。所以出参**不存在价格字段**：
 * 与 `refuel.fuelLevelUnknown` 同一手法，模型没有地方把房价编进来。
 * 估价是表述层的事（按档次给区间并标注"估算"），不是本工具的事。
 *
 * # city_limit 恒为 true
 *
 * 实测搜「广州 酒店」不限市：排序全是增城的公寓旅店。这里写死，不做成参数——
 * 做成参数就会有人在某个分支里关掉它，然后"推荐的酒店在隔壁市"这种缺陷
 * 要靠用户投诉才能发现。
 */

import { getAmapClient, type AmapTextPoi } from "./amap";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";

/**
 * 高德 POI 类目码。用类目不用关键字，关键字会混进房产中介。
 *
 * parking / charging_station / gas_station 是 M36-01 为景区到达面加的
 * （2026-08-28 实测：`150900` 搜「普陀山停车场」召回真实车场含索道停车场，
 * `011100` 召回梅岑路国网充电站——景区场景的"停哪儿/哪充电"有真数据源）。
 */
const TYPES_BY_CATEGORY = {
  hotel: "100000",
  attraction: "110000",
  parking: "150900",
  charging_station: "011100",
  gas_station: "010100",
} as const;

/** 纯类目搜索在部分城市返回稀疏，keywords 缺省时按类目补中文词（见 real()）。 */
const DEFAULT_KEYWORDS: Record<PoiCategory, string> = {
  hotel: "酒店",
  attraction: "景点",
  parking: "停车场",
  charging_station: "充电站",
  gas_station: "加油站",
};

export type PoiCategory = keyof typeof TYPES_BY_CATEGORY;

export interface PoiSearchArgs {
  /** 目标城市（中文名，如「广州」）。 */
  city: string;
  /** 追加关键词（如「亲子」「珠江新城」）；缺省只按类目搜。 */
  keywords?: string;
  category: PoiCategory;
  /** 返回条数上限，默认 8。 */
  limit?: number;
}

export interface PoiCandidate {
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  /** 高德评分（真实数据）；没有就是 undefined，不猜。 */
  rating?: string;
}

export interface PoiSearchResult {
  city: string;
  category: PoiCategory;
  candidates: PoiCandidate[];
  /** 恒定声明：本工具没有价格数据。表述层引用酒店时必须自带"估算"标注。 */
  priceNotice: string;
}

export const PRICE_NOTICE =
  "本结果不含任何价格数据（高德开放平台不提供房价/票价）。" +
  "向用户提及花费时只能给经验估算区间，并明确说明是估算、以实际平台为准。";

export interface PoiSearchBackend {
  textSearch(
    params: { keywords: string; region: string; types: string; limit: number },
    signal?: AbortSignal,
  ): Promise<AmapTextPoi[]>;
}

function createAmapPoiBackend(): PoiSearchBackend {
  return {
    textSearch(params, signal) {
      const amap = getAmapClient();
      if (!amap) throw new ToolError("poi_search", "unconfigured", "高德未接入（缺 AMAP_SERVER_KEY）", false);
      // city_limit 写死 true：见文件头。
      return amap.textSearch({ ...params, cityLimit: true }, signal);
    },
  };
}

/** Mock 三态的固定数据；每条名字都带「（模拟）」，防止被当真实推荐转述。 */
const MOCK_CANDIDATES: Record<PoiCategory, PoiCandidate[]> = {
  hotel: [
    { id: "mock-h1", name: "白天鹅宾馆（模拟）", address: "沙面南街1号", lat: 23.107, lon: 113.243, rating: "4.7" },
    { id: "mock-h2", name: "广州花园酒店（模拟）", address: "环市东路368号", lat: 23.137, lon: 113.294, rating: "4.6" },
  ],
  attraction: [
    { id: "mock-a1", name: "广州塔（模拟）", address: "阅江西路222号", lat: 23.106, lon: 113.324, rating: "4.8" },
    { id: "mock-a2", name: "长隆野生动物世界（模拟）", address: "番禺区汉溪大道东", lat: 22.997, lon: 113.327, rating: "4.9" },
  ],
  parking: [
    { id: "mock-p1", name: "景区南门停车场（模拟）", address: "景区南入口旁", lat: 23.1, lon: 113.3 },
    { id: "mock-p2", name: "游客中心地面停车场（模拟）", address: "游客中心西侧", lat: 23.102, lon: 113.298 },
  ],
  charging_station: [
    { id: "mock-c1", name: "国网充电站(景区游客中心站)（模拟）", address: "游客中心停车场内", lat: 23.101, lon: 113.299 },
  ],
  gas_station: [
    { id: "mock-g1", name: "中石化景区路加油站（模拟）", address: "景区路与环山路交叉口", lat: 23.09, lon: 113.29 },
  ],
};

export function createPoiSearchTool(
  backend: PoiSearchBackend,
): ExternalTool<PoiSearchArgs, PoiSearchResult> {
  return defineExternalTool<PoiSearchArgs, PoiSearchResult>({
    name: "poi_search",
    provider: "amap",
    // 只读查询 → §8.4 第三行自动放行，不经权限门。
    sensitive: false,
    timeoutMs: 8_000,
    retries: 2,

    real: async (args, ctx) => {
      if (!args.city.trim()) {
        throw new ToolError("poi_search", "invalid", "city 不能为空", false);
      }
      /*
       * region 传什么就传什么——**城市限定失效的纠偏在客户端**（见 amap.ts 的
       * textSearch）。放在那一层是因为不止这一个调用点：给行程点配坐标的
       * `resolveTripPlanCoords` 也走同一个方法，而它踩的是同一个坑。
       */
      const pois = await backend.textSearch(
        {
          // keywords 至少给类目中文，纯 types 搜索在部分城市返回稀疏。
          keywords: args.keywords?.trim() || DEFAULT_KEYWORDS[args.category],
          region: args.city,
          types: TYPES_BY_CATEGORY[args.category],
          limit: Math.min(args.limit ?? 8, 20),
        },
        ctx.signal,
      );

      return {
        city: args.city,
        category: args.category,
        candidates: pois.map((p) => ({
          id: p.id,
          name: p.name,
          address: p.address,
          lat: p.lat,
          lon: p.lon,
          ...(p.rating ? { rating: p.rating } : {}),
        })),
        priceNotice: PRICE_NOTICE,
      };
    },

    mock: (args) => ({
      city: args.city,
      category: args.category,
      candidates: MOCK_CANDIDATES[args.category],
      priceNotice: PRICE_NOTICE,
    }),
  });
}

export const poiSearchTool = createPoiSearchTool(createAmapPoiBackend());
