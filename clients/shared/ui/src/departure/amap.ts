/**
 * 出发卡的纯逻辑：今天该导去哪、卡上列哪几站、高德三个入口的 URI（0830 走查重排；
 * M66-03 加途经点与策略；2026-09-02 从 `clients/cockpit/features/cabin/departure.ts`
 * 上提到这里——手机端也要出发卡，URI 的细节（`to` 是 lon,lat、`vianames` 裸 `|` 分隔）
 * 各写一份必然漂，而漂掉的表现是"车机能进导航、手机进去是另一个点"）。
 *
 * 出发动画的时间轴与关键帧**没有**跟着上来：那是车机专属（四段实拍片 + WAAPI），
 * 仍住在 cockpit 的 `departure.ts`。
 */

import {
  tripDayIndex,
  tripPlanNavTarget,
  tripPlanStops,
  type NavRouteStrategy,
  type TripPlanSnapshot,
} from "@carlife/shared";
// ── 出发卡：导航目标与高德 URI ───────────────────────────────

export interface NavTarget {
  lat: number;
  lon: number;
  name: string;
}

/**
 * 今天该去哪：规则本体在 shared 的 `tripPlanNavTarget`（M66-02 上移）——
 * runtime 的出发导航规划按同一条规则定终点，卡上导去哪、方案按哪算，必须是同一个点。
 * 这里保留旧名与旧签名，既有调用方与测试不改。
 */
export function pickNavTarget(plan: TripPlanSnapshot, todayIso: string): NavTarget | undefined {
  return tripPlanNavTarget(plan, todayIso);
}

/** 今日路线的展示名单（出发卡用；上限截断，卡不是时间轴的复读机）。 */
export function todayStopNames(plan: TripPlanSnapshot, todayIso: string, limit = 5): string[] {
  const idx = tripDayIndex(plan, todayIso);
  const stops = tripPlanStops(plan, (idx ?? 0) + 1);
  return stops.slice(0, limit).map((s) => s.name);
}

/**
 * 途经点列表的可视高度：**前三条整高 + 第四条的一半**（走查 2026-09-02 的要求）。
 *
 * 为什么不用 CSS 写死一个 max-height：条目会换行——「长安服务区(沪昆高速上海方向)
 * （约 132 分钟处）— 杭州湾前第一处高速服务区，让同行者下车活动」在车机宽度下是两行，
 * 而「南城服务区（约 482 分钟处）」是一行。按行数写死的高度，遇到短条目露出五条、
 * 遇到长条目连两条都露不全，"3.5 条"这个约定就不成立了。
 *
 * 露出半条是刻意的：它是"下面还有"的唯一视觉线索。滚动条在触屏上默认不常驻，
 * 没有这半条，车主会以为规划就只有三个休息点。
 *
 * 少于四条时返回 undefined（不限高）：本来就装得下，限高只会凭空造出一条滚动边界。
 *
 * **量到 0 也返回 undefined**（2026-09-02 走查面板实测）：那不是"高度是零"，是
 * "此刻没有布局"——隐藏标签页里视口会塌成 1.9px，`--hud-unit` 跟着变成 0，
 * 量到的每条都是 0。把 0 当成有效值写进 `max-height`，列表就**永久塌掉再也回不来**，
 * 而且零报错。宁可这一次不限高（大不了列表长一点），也不能把内容压没。
 */
export function stopsViewportHeight(itemHeights: readonly number[]): number | undefined {
  if (itemHeights.length <= 3) return undefined;
  const [a, b, c, d] = itemHeights;
  const height = a + b + c + d / 2;
  return Number.isFinite(height) && height > 0 ? height : undefined;
}

// ── 高德唤起：三个入口对途经点/策略的支持不一样（M66-03，官方文档 2026-09-02 抓取）──
//
//   iosamap://navi                 单点直达导航；**没有**途经点参数
//   iosamap://path                 路线规划页；vian/vialons/vialats/vianames（四参数个数必须一致，上限未写）；
//                                  m（策略）在 iOS ≥7.7.4 不支持——以用户本地设置为准
//   https://uri.amap.com/navigation  via **只 1 个**、只在 mode=car 生效；policy 0 推荐 / 1 避拥堵 / 2 避收费 / 3 不走高速
//
// 所以：无途经点 → 与 M66 之前逐字相同（navi 一步直达）；有途经点 → iOS 走 path（全部途经点）、
// web 只带第一个 via 并由 `navLaunchDegradation` 说出丢了几个。策略只在 web 入口生效。

/** 一次唤起：终点 + 可选途经点 + 可选策略。传 `NavTarget` 等于"只有终点"（旧签名兼容）。 */
export interface NavLaunch {
  target: NavTarget;
  waypoints?: NavTarget[];
  strategy?: NavRouteStrategy;
}

function asLaunch(arg: NavTarget | NavLaunch): NavLaunch {
  return "target" in arg ? arg : { target: arg };
}

/** `vianames` 用裸 `|` 分隔（文档示例如此）；名字里的 `|` 会破坏分隔，替换成全角竖线。 */
function viaName(name: string): string {
  return encodeURIComponent(name.replace(/\|/g, "丨"));
}

/** web 入口的 policy：省钱 → 2 避免收费；其它 → 0 推荐（高速优先没有对应值，推荐最接近）。 */
export function amapWebPolicy(strategy: NavRouteStrategy | undefined): 0 | 2 {
  return strategy === "less_toll" ? 2 : 0;
}

/**
 * 高德 **App** 的 scheme（iOS `iosamap://`）。
 *
 * 与 web 入口分工：装了高德 App 的设备上 scheme 一步进导航（不经 Safari 中转页——
 * iOS 上 `uri.amap.com` 的 `callnative` 自动唤起常被浏览器拦，用户还得再点一次）；
 * 没装 App 时 scheme 打不开，调用方回退 `amapNavUri` 的 web 入口。
 * ⚠️ scheme 的参数是 `lat=`/`lon=` 分开传，与 web 入口的 `to=lon,lat` 不同——
 * 两个约定都是高德定的，别互相"顺手统一"。
 *
 * 有途经点时换成 `iosamap://path`（路线规划页，用户多点一次「开始导航」）——
 * 这是文档明示的取舍：`navi` 没有途经点参数。
 */
export function amapAppNavUri(arg: NavTarget | NavLaunch): string {
  const { target: to, waypoints = [] } = asLaunch(arg);
  if (waypoints.length === 0) {
    return (
      "iosamap://navi" +
      `?sourceApplication=carlife&lat=${to.lat}&lon=${to.lon}` +
      `&poiname=${encodeURIComponent(to.name)}&dev=0&style=1`
    );
  }
  return (
    "iosamap://path" +
    `?sourceApplication=carlife&dlat=${to.lat}&dlon=${to.lon}&dname=${encodeURIComponent(to.name)}` +
    "&dev=0&t=0" +
    `&vian=${waypoints.length}` +
    `&vialons=${waypoints.map((w) => w.lon).join("|")}` +
    `&vialats=${waypoints.map((w) => w.lat).join("|")}` +
    `&vianames=${waypoints.map((w) => viaName(w.name)).join("|")}`
  );
}

/**
 * 高德导航 URI（Web 版万能入口）。
 *
 * `uri.amap.com/navigation` 在手机/车机上经 `callnative=1` 唤起高德 App，
 * 在电脑浏览器上退到网页版路径规划——**"电脑上如何模拟"的答案就是它本身**，
 * 不需要两套代码。`from` 不传 = 高德自己取当前位置（方案里的起点只用于算休息点，不用于导航本身）。
 * 坐标系明标 `coordinate=gaode`：行程里的坐标来自高德 POI（GCJ-02），同系。
 *
 * 注意 to 参数是 `lon,lat`（高德约定经度在前），与我们领域模型的 lat/lon 相反——
 * 这正是要用单测钉住的那种细节。途经点 `via` 只带第一个（文档：最多 1 个）。
 * `policy` 默认从 M66 之前写死的 `1`（避免拥堵）改为 `0`（推荐）：高速优先没有对应值，推荐最接近。
 */
export function amapNavUri(arg: NavTarget | NavLaunch): string {
  const { target: to, waypoints = [], strategy } = asLaunch(arg);
  const via = waypoints[0];
  return (
    "https://uri.amap.com/navigation" +
    `?to=${to.lon},${to.lat},${encodeURIComponent(to.name)}` +
    (via ? `&via=${via.lon},${via.lat},${encodeURIComponent(via.name)}` : "") +
    `&mode=car&policy=${amapWebPolicy(strategy)}&coordinate=gaode&src=carlife&callnative=1`
  );
}

/**
 * 这个入口会丢掉方案里的什么——卡上要说出来（"不标不猜"）。undefined = 什么都不丢。
 */
export function navLaunchDegradation(launch: NavLaunch, entry: "app" | "web"): string | undefined {
  const n = launch.waypoints?.length ?? 0;
  if (entry === "web" && n > 1) return `网页版高德只能带第一个途经点（丢弃 ${n - 1} 个）`;
  if (entry === "app" && launch.strategy !== undefined && n > 0) return "高德 App 的算路策略以其本地设置为准";
  return undefined;
}
