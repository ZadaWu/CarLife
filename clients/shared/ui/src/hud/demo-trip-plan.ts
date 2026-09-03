/**
 * 「行程演示」固定快照（施工单 M13-06，车机 devbar 与手机 `?plan=demo` 共用；M65-01 上提）。
 *
 * 存在的唯一理由：浏览器环境没有 Tauri invoke，真实数据源接不上——
 * 这是真实地图标注层能在浏览器里被走查的唯一路径。
 * 坐标是广州地标的真实位置（高德拾取），poiKind 按 classifyAmapPoi 对各点
 * 高德类目的实际输出手工固化（沙面岛按街区语义给 old_town）。**整份行程是演示数据**：
 * 名称带「演示」字样进不了正式链路，只在 devbar 手动开启时生效。
 */
import type { TripPlanSnapshot } from "@carlife/shared";

export const DEMO_TRIP_PLAN: TripPlanSnapshot = {
  status: "confirmed",
  destination: "广州（演示）",
  startDate: undefined,
  days: 3,
  skeleton: [
    {
      day: 1,
      theme: "城央地标（演示）",
      // M34 演示形态：时段来自规划层（M34-01），夜景类压轴在下午/傍晚。
      spots: [
        { name: "广州塔", lat: 23.1064, lon: 113.3245, poiKind: "spot", estStart: "09:30", estEnd: "11:30" },
        { name: "海心沙亚运公园", lat: 23.1129, lon: 113.3186, poiKind: "park", estStart: "14:00", estEnd: "16:30" },
      ],
      hotel: { name: "广州正佳广场万豪酒店", estPrice: "约700-1200/晚（估算）", lat: 23.1327, lon: 113.3273 },
      lodging: { strategy: "checkin-midday", note: "到达日先办理入住放下行李，下午再开始行程（演示）" },
    },
    {
      day: 2,
      theme: "老城文化（演示）",
      spots: [
        { name: "陈家祠堂", lat: 23.1259, lon: 113.2467, poiKind: "museum", estStart: "09:00", estEnd: "11:00" },
        { name: "沙面岛", lat: 23.1073, lon: 113.2417, poiKind: "old_town", estStart: "14:00", estEnd: "17:00" },
      ],
      hotel: { name: "广州正佳广场万豪酒店", estPrice: "约700-1200/晚（估算）", lat: 23.1327, lon: 113.3273 },
    },
    {
      day: 3,
      theme: "长隆主题日（演示）",
      spots: [
        { name: "长隆野生动物世界", lat: 22.9997, lon: 113.3189, poiKind: "park", estStart: "09:00", estEnd: "13:00" },
        { name: "长隆欢乐世界", lat: 23.0031, lon: 113.3286, poiKind: "amusement_park", estStart: "13:30", estEnd: "18:00" },
      ],
      hotel: { name: "长隆酒店", estPrice: "约900-1600/晚（估算）", lat: 23.0058, lon: 113.3222 },
      lodging: { strategy: "checkin-evening", note: "白天全程游玩，自驾行李放车上，傍晚入住长隆酒店（演示）" },
    },
  ],
  energyStops: ["泌冲充电站"],
  caveats: ["演示数据：酒店价格为经验估算，须以实际预订平台为准"],
  /*
   * 目的地推荐（M32-03 走查用）。
   *
   * 真实链路要 gateway + runtime + PostgreSQL + 一次十几秒的联网搜索，
   * 浏览器走查里一样都没有——这是推荐卡能被走查的唯一路径。
   *
   * ⚠️ **「沙面岛」那条刻意没有 `sourceUrl`**。出处从 2026-08-28 起**不上卡**了
   * （见 `HighlightsCard.tsx` 文件头），所以这一条在屏幕上看不出差别——
   * 留着它是为了让演示数据仍然覆盖"有出处 / 没出处"两种形状：
   * 哪天有人把出处画回卡上，这份数据当场就能暴露"没出处那条怎么显示"。
   */
  destinationHighlights: {
    destination: "广州（演示）",
    foods: [
      { name: "陶陶居", note: "百年老字号早茶", sourceUrl: "https://example.com/demo/taotaoju", sourceTitle: "演示出处" },
      { name: "点都德", note: "全天供应的点心", sourceUrl: "https://example.com/demo/dimdaddy", sourceTitle: "演示出处" },
      { name: "广州酒家", note: "烧鹅与艇仔粥", sourceUrl: "https://example.com/demo/gzjj", sourceTitle: "演示出处" },
    ],
    spots: [
      { name: "永庆坊", note: "骑楼老街与粤剧馆", sourceUrl: "https://example.com/demo/yongqingfang", sourceTitle: "演示出处" },
      { name: "沙面岛", note: "欧式建筑群" },
      { name: "广州塔", note: "夜景地标", sourceUrl: "https://example.com/demo/canton-tower", sourceTitle: "演示出处" },
    ],
    photoTips: [
      { spot: "永庆坊", tip: "入夜拍月亮桥倒影" },
      { spot: "沙面岛", tip: "清晨顺光拍白墙" },
      { spot: "广州塔", tip: "对岸长曝拍变色" },
    ],
    computedAt: "2026-08-28T02:00:00.000Z",
  },
  updatedTurnId: "demo",
};

/**
 * 跟车演示（M31-03）：给演示行程挂上 `nav`。
 *
 * 与 `DEMO_TRIP_PLAN` 同因——浏览器里没有网关那一路，说「出发」发不出去，
 * 这是跟车模式能被走查的唯一路径。
 *
 * `startedAt` 取**调用时刻**而不是写死的常量：`tripPlanNavDay` 会把超过
 * `NAV_MAX_AGE_H` 的导航判成过期，写死的时间戳一过半天就再也演不出来了
 * （而且症状是"开关点了没反应"，离根因很远）。
 */
export function withDemoNav(plan: TripPlanSnapshot, day = 1): TripPlanSnapshot {
  return { ...plan, nav: { day, startedAt: new Date().toISOString() } };
}
