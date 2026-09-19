/**
 * `city_districts` —— 目的地城市的区县清单（施工单 M86-02，ACR-037）。
 *
 * # 为它服务的问题
 *
 * 多天行程的 Plan 层要把景点按坐标聚成"天×片区"，而聚类的前提是候选池有地理分布。
 * 2026-09-15 实测：`spot_search({city:"杭州", keywords:"景点", limit:20})` 返回的 20 条全在
 * 上城 / 西湖 / 钱江新城——良渚、千岛湖一个都没有；换成 `keywords:"余杭区 景点"` 就有
 * 良渚博物院、梦想小镇、宝寿山。所以要**按区县分次搜**，而区县名单只有高德的行政区划接口有。
 *
 * # 它是编排层的采集步骤，不是模型的工具
 *
 * 空 ACL（与 `plan_audit` 同一取向）：模型手里没有它，编排层 `invokeTool` 直调。
 * 中心坐标只用来排"离市区多远"，**不当作任何景点的坐标**——景点坐标只来自 `spot_search` 的返回（ADR-008）。
 */

import { getAmapClient, type AmapDistrict } from "./amap";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";

export interface CityDistrictsArgs {
  /** 目的地城市（中文名）。 */
  city: string;
}

export type CityDistrict = AmapDistrict;

export interface CityDistrictsResult {
  city: string;
  /** 按高德行政区划接口的顺序（城区在前、远郊在后）；认不出这个名字就是空数组。 */
  districts: CityDistrict[];
}

/** Mock 三态：广州的十一个区县（真实 adcode 与中心，2026-09-15 抄自高德），名字不带「模拟」——它们是行政区划，不是推荐。 */
const MOCK_GUANGZHOU: CityDistrict[] = [
  { adcode: "440103", name: "荔湾区", lat: 23.125981, lon: 113.244261 },
  { adcode: "440104", name: "越秀区", lat: 23.12897, lon: 113.266841 },
  { adcode: "440105", name: "海珠区", lat: 23.083801, lon: 113.317443 },
  { adcode: "440106", name: "天河区", lat: 23.124613, lon: 113.361183 },
  { adcode: "440111", name: "白云区", lat: 23.157032, lon: 113.273472 },
  { adcode: "440112", name: "黄埔区", lat: 23.106404, lon: 113.480541 },
  { adcode: "440113", name: "番禺区", lat: 22.937834, lon: 113.384153 },
  { adcode: "440114", name: "花都区", lat: 23.404165, lon: 113.220463 },
  { adcode: "440115", name: "南沙区", lat: 22.802331, lon: 113.525165 },
  { adcode: "440117", name: "从化区", lat: 23.548852, lon: 113.586845 },
  { adcode: "440118", name: "增城区", lat: 23.290616, lon: 113.810627 },
];

export const cityDistrictsTool: ExternalTool<CityDistrictsArgs, CityDistrictsResult> = defineExternalTool<CityDistrictsArgs, CityDistrictsResult>({
  name: "city_districts",
  provider: "amap",
  sensitive: false,
  timeoutMs: 8_000,
  retries: 1,

  real: async (args, ctx) => {
    const amap = getAmapClient();
    if (!amap) throw new ToolError("city_districts", "unconfigured", "高德未接入（缺 AMAP_SERVER_KEY）", false);
    const city = args.city.trim();
    if (!city) throw new ToolError("city_districts", "invalid", "city 不能为空", false);
    return { city, districts: await amap.listDistricts(city, ctx.signal) };
  },

  mock: (args) => ({ city: args.city, districts: MOCK_GUANGZHOU }),
});
