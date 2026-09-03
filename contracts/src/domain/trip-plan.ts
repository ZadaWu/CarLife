/**
 * 多天行程快照——端云契约（施工单 M13-01）。
 *
 * # 与两位近亲的关系，命名因此刻意绕开
 *
 * - `hud.ts` 里已有一个 `TripPlan`：那是 HUD 生活环的**展示**结构（锚位+语义化地点）。
 * - agent-runtime 的 `TripPlanState`：那是图状态里的**草案**（M12-03，跨轮细化用）。
 * 本文件是第三个角色：**确认后落库、并被网关原样返回给座舱的那份快照**。
 * 三者职责不同不合并；本类型是网关 `GET /v1/trip-plan/current` 与
 * `trip_plan_commit` 工具入参的唯一真相源，图状态与它对齐（M13-02）。
 *
 * # 真实性红线随类型走（M12 设计继承）
 *
 * spots/hotel 的 name 必须来自 poi_search；estPrice 恒带「估」字——
 * 后者在 `trip_plan_commit` 的 zod 层强制，这里的注释是语义声明。
 */

import {
  highlightsPage,
  paginateTipItems,
  tipItemsFromKeys,
  type DestinationHighlights,
  type HudSnapshot,
  type PretripItemRef,
  type TipPage,
  type TripNode,
  type WeatherContext,
} from "./hud";
import type { PoiKind } from "./poi-kind";

export type TripPlanStatus = "skeleton" | "refining" | "confirmed" | "cancelled";

/**
 * 「这份行程正在被导航」（M31-01）。
 *
 * # 为什么它挂在快照里而不是另开一路
 *
 * 端上取行程走的是网关 `GET /v1/trip-plan/current`（读 PG）。导航状态不落库
 * 就得为一个字段新建推送通道，不成比例；挂进快照则复用既有的"每轮回复落地即刷"
 * （c256a5d），零新增 plumbing。
 *
 * **重启后续上导航是正确行为，不是 bug**——车还在路上。这一点与 M30 的按轮
 * 暂存区（进程内、轮末即弃）不同：那个的寿命是一轮，这个的寿命是一次驾驶。
 *
 * `startedAt` 不只是留痕，它是**过期判据的唯一材料**：跨天的导航一律作废
 * （见 `tripPlanNavDay`）。没有它，昨天那次「出发」会一直挂在今天的屏幕上。
 */
export interface TripPlanNav {
  /** 导航的是第几天（1 起，与 `TripPlanDaySnapshot.day` 同口径）。 */
  day: number;
  /** 「出发」那一刻，ISO 时间戳。 */
  startedAt: string;
}

export interface TripPlanSpotSnapshot {
  name: string;
  indoor?: boolean;
  note?: string;
  /**
   * 真实坐标（M13-06）：由确认路径的**代码**经 poi_search 后端解析，不让 LLM 抄数字。
   * 缺省 = 没解析到——HUD 不标注、不猜坐标（真实性红线），名字仍进列表。
   */
  lat?: number;
  lon?: number;
  /**
   * 贴纸品类（M13-07）：确认路径的代码按高德 type 字段分类（`classifyAmapPoi`），
   * 与坐标同一次 poi_search 顺手取得。缺省 = 类目没查到——HUD 用通用景点贴纸，
   * **不按名字猜**（与坐标「不标不猜」同一条红线）。
   */
  poiKind?: PoiKind;
  /**
   * 建议游玩时段（M34-01，`HH:MM`，**预计口径**）：tour 分支的模型给出——
   * 时段语义（夜游必须晚上、长隆是全天、下午该有安排）只有模型知道，
   * 端上按 09:00+90min 拍出来的是「珠江夜游 预计 10:50–12:20」这类荒谬时间。
   * 缺省 = 模型没给或校验被丢弃（`sanitizeDayTimes`），HUD 回退端上排时。
   * 展示时恒带「预计」标注（估算口径纪律与 estPrice 同源）。
   */
  estStart?: string;
  estEnd?: string;
}

export interface TripPlanHotelSnapshot {
  name: string;
  /** 完整地址（对话层播报用）。**HUD 映射不得输出它**——HUD 只给语义化名称。 */
  address?: string;
  area?: string;
  rating?: string;
  /** 恒含「估」字（估算声明），commit 时 schema 强制。 */
  estPrice?: string;
  /** 真实坐标（M13-06），语义同 TripPlanSpotSnapshot。 */
  lat?: number;
  lon?: number;
}

/**
 * 换酒店日/到达日的住宿策略（M34-01）。**住宿是锚点不是 POI**：
 * 到达日先到酒店落脚（放行李/取车）再开始行程，每天结束回当晚酒店；
 * 换酒店日由模型二选一并在 note 里写清行李处置（自驾=行李在车、非自驾=寄存）。
 * 只出现在换酒店日与到达日；连住日不填。行李是 note 的一部分，不建数据结构。
 */
export interface TripPlanLodging {
  /** checkin-midday = 上午玩完→退房→新酒店办入住→下午继续；checkin-evening = 白天全程玩、晚上入住。 */
  strategy: "checkin-midday" | "checkin-evening";
  /** 一句话说明（含行李处置），模型写，HUD 原样显示。 */
  note?: string;
}

export interface TripPlanDaySnapshot {
  day: number;
  date?: string;
  theme: string;
  area?: string;
  spots: TripPlanSpotSnapshot[];
  hotel?: TripPlanHotelSnapshot;
  /** 住宿策略（M34-01）：仅换酒店日/到达日；缺省 = 连住或旧快照。 */
  lodging?: TripPlanLodging;
  notes?: string[];
}

export interface TripPlanSnapshot {
  status: TripPlanStatus;
  origin?: string;
  destination: string;
  /** ISO 日期（YYYY-MM-DD）；缺省 = 未定，HUD 按第 1 天展示。 */
  startDate?: string;
  days: number;
  /** 同行（带娃/老人）。 */
  party?: string;
  skeleton: TripPlanDaySnapshot[];
  transit?: { recommended?: "drive" | "train" | "flight"; summary: string };
  /**
   * 自驾补能点（drive 分支 solve() 的结果，M13-02 穿透）。
   * HUD 的 charge 锚位数据源；缺省 = 本次方案没有自驾补能点。
   */
  energyStops?: string[];
  /** 播报与展示时必须带的声明（估算、天气窗口外等）。 */
  caveats: string[];
  /**
   * 行前该带什么（M20-04）：确认路径按这次行程的天气算出来的物品 key。
   *
   * **只存 key，不存名字**——名字由 `PRETRIP_ITEMS` 查表得到。存 label 等于把
   * "图标下的字对不对"的正确性交给上游，M20-01 那次事故正是这么来的。
   *
   * 缺省 = 这次没算出来（天气挂了 / 没有坐标）或**老快照**——
   * 展示层回落基线清单，不是空卡。
   */
  pretripItems?: PretripItemRef[];
  /**
   * 这一程的天气（M20-05）：与 `pretripItems` **同一次调用、同一份天气**算出来的。
   * 分两处算必然出现"图标说晴天、物品带雨伞"。缺省 = 没算出来或老快照，展示层回落基线。
   */
  weather?: WeatherContext;
  /**
   * 目的地推荐（M32-02）：到了那儿吃什么、拍哪儿。
   *
   * **与 `pretripItems` 不同，它不参与确认那一跳**——那次调用要十几秒，
   * 串进确认里就是"说完确认之后卡十几秒才弹窗"。但"不能同步算"不等于"不能落库"：
   * 行程确认/变更后 runtime 在**后台**算一次，算完写回这一行（M32-02 修订，
   * `agent-runtime/src/graph/highlights.ts` 的 `createHighlightsBackfill`）。
   *
   * 所以从库里读出来的快照**带着它**；改了目的地的那一刻它被清掉，等新的算完再出现——
   * 上一程的馆子挂在这一程不是过期，是错。
   *
   * 缺省 = 后台还没算完（确认后的十几秒）/ 这次没算出来 / 修订之前的老行程。
   * 展示层不造推荐页，轮播退回单卡，不是空卡。
   * 老行程的兜底仍是读时补齐（网关 `?refreshPretrip=1` → `/internal/trip/highlights-refresh`），
   * 网关只在库里没有时才发那一跳。
   */
  destinationHighlights?: DestinationHighlights;
  /**
   * 正在导航（M31-01）。缺省 = 没在导航，端上显示行程模式。
   * 只由「出发」处置写入、「结束导航」清除；跨天自动作废（`tripPlanNavDay`）。
   */
  nav?: TripPlanNav;
  updatedTurnId: string;
}

// ── 真实地图停靠点（施工单 M13-06）───────────────────────────────────

/** 一处停靠：HUD 真实地图的标注单元。坐标缺省 = 只进列表不上图。 */
export interface TripPlanStop {
  name: string;
  /** 属于第几天（1 起）。 */
  day: number;
  kind: "spot" | "hotel" | "charging";
  /** 贴纸品类：spot 取快照的 poiKind（缺省=通用景点），hotel/charging 品类即身份。 */
  poiKind?: PoiKind;
  lat?: number;
  lon?: number;
  /** 建议时段（M34-02 透传 M34-01 的快照字段）；缺省 = 模型没给，端上回退排时。 */
  estStart?: string;
  estEnd?: string;
  /**
   * 该停靠覆盖的全部天（M34-02，仅 hotel 用）：连住去重后只有一个 marker，
   * 但标注必须如实——只写首日 `Day 1` 时，"D2 的酒店在哪"没有答案（用户走查原话）。
   * 缺省 = 单日模式或旧调用方。
   */
  days?: number[];
}

/**
 * 某一天（`day` 1 起）或全程（`day` 缺省）的有序停靠点。
 *
 * **单日 = 以酒店为闭环**（用户走查定的场景语义）：先到酒店（首日放行李 /
 * 末日退房寄存），再逐个景点，最后回酒店（取行李/落脚）——路线的"回环"由
 * 地图层画（closeLoop），这里只保证酒店在首位且只出现一次。
 * 当天没有酒店（纯往返日）就只有景点序列。
 *
 * 全程 = 逐天串联景点 + 每晚酒店按天挂尾；**连住同一家酒店只标一次**——
 * 重复标记会把地图糊住，且路线会在酒店上原地打转。
 */
export function tripPlanStops(plan: TripPlanSnapshot, day?: number): TripPlanStop[] {
  const days = [...plan.skeleton].sort((a, b) => a.day - b.day);
  if (day !== undefined) {
    const d = days.find((x) => x.day === day);
    if (!d) return [];
    const stops: TripPlanStop[] = [];
    if (d.hotel) {
      stops.push({ name: d.hotel.name, day: d.day, kind: "hotel", poiKind: "hotel", lat: d.hotel.lat, lon: d.hotel.lon });
    }
    for (const s of d.spots) {
      stops.push({
        name: s.name,
        day: d.day,
        kind: "spot",
        poiKind: s.poiKind ?? "spot",
        lat: s.lat,
        lon: s.lon,
        ...(s.estStart && s.estEnd ? { estStart: s.estStart, estEnd: s.estEnd } : {}),
      });
    }
    return stops;
  }
  const stops: TripPlanStop[] = [];
  // 连住去重保留（重复 marker 会把地图糊住），但标注要如实：先收齐每家酒店覆盖的天。
  const hotelDays = new Map<string, number[]>();
  for (const d of days) {
    if (d.hotel) hotelDays.set(d.hotel.name, [...(hotelDays.get(d.hotel.name) ?? []), d.day]);
  }
  const seenHotels = new Set<string>();
  for (const d of days) {
    for (const s of d.spots) {
      stops.push({
        name: s.name,
        day: d.day,
        kind: "spot",
        poiKind: s.poiKind ?? "spot",
        lat: s.lat,
        lon: s.lon,
        ...(s.estStart && s.estEnd ? { estStart: s.estStart, estEnd: s.estEnd } : {}),
      });
    }
    if (d.hotel && !seenHotels.has(d.hotel.name)) {
      seenHotels.add(d.hotel.name);
      stops.push({
        name: d.hotel.name,
        day: d.day,
        kind: "hotel",
        poiKind: "hotel",
        lat: d.hotel.lat,
        lon: d.hotel.lon,
        days: hotelDays.get(d.hotel.name),
      });
    }
  }
  return stops;
}

/** 导航目标：今天第一站（M66-02 从车机端 `departure.ts` 上移，两端一份规则）。 */
export interface TripPlanNavTarget {
  lat: number;
  lon: number;
  name: string;
}

/**
 * 今天该去哪：今日（未开始按第 1 天）第一个带坐标的落点；
 * 今日全无坐标时退到全程第一个带坐标的。全程都没有 → undefined，
 * 调用方如实说"这份行程还没有可导航的坐标"，不编一个点。
 *
 * 出发卡（车机端）与出发导航规划（runtime `/internal/trip/nav-plan`）都用它——
 * 两处各写一份的话，卡上导去 A、方案却按 B 算休息点，而且零报错。
 */
export function tripPlanNavTarget(plan: TripPlanSnapshot, todayIso: string): TripPlanNavTarget | undefined {
  const idx = tripDayIndex(plan, todayIso);
  const day = (idx ?? 0) + 1;
  const candidates = [...tripPlanStops(plan, day), ...tripPlanStops(plan)];
  const hit = candidates.find((s) => s.lat !== undefined && s.lon !== undefined);
  return hit ? { lat: hit.lat!, lon: hit.lon!, name: hit.name } : undefined;
}

/**
 * 把天列表压成人读的范围标注（M34-02）：连续段并成 `Day 1–2`，
 * 非连续分开列 `Day 1、Day 3`（隔天回住同一家的真实形态，不假装连住）。
 */
export function formatDayRanges(days: readonly number[]): string {
  if (days.length === 0) return "";
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const d of sorted.slice(1)) {
    if (d === prev + 1) {
      prev = d;
      continue;
    }
    parts.push(start === prev ? `Day ${start}` : `Day ${start}–${prev}`);
    start = prev = d;
  }
  parts.push(start === prev ? `Day ${start}` : `Day ${start}–${prev}`);
  return parts.join("、");
}

/** 有没有可上真实地图的点（≥2 才画得出路线；1 个也允许标注）。 */
export function tripPlanHasCoords(plan: TripPlanSnapshot): boolean {
  return tripPlanStops(plan).some((s) => s.lat !== undefined && s.lon !== undefined);
}

// ── tripPlan → HudSnapshot 映射（施工单 M13-04）───────────────────────
//
// 全部确定性规则，放 shared 是因为网关返回的与座舱消费的必须是同一份契约，
// 且这些规则要能脱离 Tauri 单测。设计判据全文见
// 内部文档 映射规则」一节。

/**
 * 生活环锚位的**路径顺序**（clients/shared/ui RING_SEGMENTS：家→park→charge→rest→wetland）。
 * 多日行程按天序占位：第 1 天在 park 位、第 2 天在 charge 位……
 * 琥珀轨迹于是自然把整程串起来（定稿 HUD_light.png 的观感）。
 * 锚位只管**落位**，图标由 kind 决定（HudScreen 侧 KIND_SPRITE）——
 * 否则第 2 天的景点会顶着充电桩图标。
 */
const RING_ORDER = ["park", "charge", "rest", "wetland"] as const;

/** 今天是行程第几天（0 起）；行程已结束返回 null。无 startDate 按第 1 天。 */
export function tripDayIndex(plan: TripPlanSnapshot, todayIso: string): number | null {
  if (!plan.startDate) return 0;
  const start = Date.parse(plan.startDate);
  const today = Date.parse(todayIso);
  if (Number.isNaN(start) || Number.isNaN(today)) return 0;
  const diff = Math.floor((today - start) / 86_400_000);
  if (diff >= plan.days) return null; // 过期：卡片收起（调用方回落默认快照）
  return Math.max(0, Math.min(diff, plan.days - 1)); // 未开始按第 1 天预览
}

/**
 * 导航失效阈值（小时）。超过它的 `nav` 一律当没有。
 *
 * # 为什么按经过时长判，不按"是不是今天"
 *
 * `startedAt` 是 `toISOString()`，即 **UTC**。拿它的日期段与本地今天比，
 * 东八区早上 7 点出发（= UTC 前一天 23 点）会被判成"昨天的导航"当场作废——
 * 一次正常的早班出行，刚说完出发就退出了导航模式。
 *
 * 经过时长没有时区，所以判据用它。12 小时的取舍方向也是明确的：
 * 判松一点最坏是第二天早上屏幕还挂着跟车模式（说一声「结束导航」即可），
 * 判紧一点则是**开着车开着开着导航自己没了**——后者严重得多。
 */
export const NAV_MAX_AGE_H = 12;

/**
 * 正在导航第几天（1 起）；没在导航返回 undefined。
 *
 * 四种"不算在导航"一并收在这里，调用方只问一次：
 * 没有 nav / 行程不是 confirmed / 超过 `NAV_MAX_AGE_H` / day 落在行程天数之外。
 * 最后一条防的是行程被改短之后 nav 指向一个已经不存在的日子。
 */
export function tripPlanNavDay(plan: TripPlanSnapshot, nowIso: string): number | undefined {
  const nav = plan.nav;
  if (!nav || plan.status !== "confirmed") return undefined;
  if (!Number.isInteger(nav.day) || nav.day < 1 || nav.day > plan.days) return undefined;
  const started = Date.parse(nav.startedAt);
  const now = Date.parse(nowIso);
  // 时间戳解析不了就**不认这次导航**：拿不准的时候停在行程模式，不硬跟车。
  if (Number.isNaN(started) || Number.isNaN(now)) return undefined;
  if (now - started > NAV_MAX_AGE_H * 3_600_000) return undefined;
  return nav.day;
}

/**
 * 把已确认行程映射成 HUD 快照；**不该展示时返回 null**（未确认 / 已取消 / 已结束），
 * 由调用方回落默认快照——"收起"的落法是不渲染行程数据，不是渲染一张空卡。
 *
 * 站点是**整程概览**（用户走查修正，对齐定稿 HUD_light.png）：每天一个代表站点
 * （首个景点，无景点用当天酒店），按天序落在环的路径顺序上——编号即第几天，
 * 琥珀轨迹把 4 天串成一条路线。剩余锚位依次补末日酒店（终点收束光晕）与补能点。
 * 超过 4 天只显示前 4 天——HUD 是概览不是行程单；不足 4 个照常返回，
 * **不用占位假地点凑数**（真实性红线）。当天细节在右侧 tips 卡与对话层。
 *
 * energy/weather/assistantState 原样取 `base`——它们不来自行程。
 * 酒店**只上名字不上地址**（HUD 可视化边界：地点一律语义化名称）。
 */
export function tripPlanToHud(
  plan: TripPlanSnapshot,
  todayIso: string,
  base: HudSnapshot,
): HudSnapshot | null {
  if (plan.status !== "confirmed") return null;
  const dayIndex = tripDayIndex(plan, todayIso);
  if (dayIndex === null) return null;

  const today =
    plan.skeleton.find((d) => d.day === dayIndex + 1) ?? plan.skeleton[dayIndex] ?? plan.skeleton[0];
  if (!today) return null;

  // 每天一个代表站点，按天序占环位。
  const nodes: TripNode[] = [];
  const dayOf = (i: number) => plan.skeleton.find((d) => d.day === i + 1) ?? plan.skeleton[i];
  for (let i = 0; i < Math.min(plan.days, RING_ORDER.length); i += 1) {
    const d = dayOf(i);
    const repSpot = d?.spots[0];
    const rep = repSpot ?? (d?.hotel ? { name: d.hotel.name } : undefined);
    if (!rep) continue;
    nodes.push({
      anchor: RING_ORDER[nodes.length],
      name: rep.name,
      // 贴纸品类（M13-07）：景点用确认路径按高德 type 分出的 poiKind，
      // 缺省落通用景点贴纸——不按名字猜；代表点是酒店时品类即身份。
      kind: repSpot ? (repSpot.poiKind ?? "spot") : "hotel",
    });
  }
  // 剩余锚位：先补能点、后酒店——**酒店必须排最后**，
  // 终点收束光晕落在数组末位上，落脚处才是终点，不能是充电站。
  // 酒店取**最后一晚**的（回程日常无酒店，「末日的酒店」多数时候是空的）；
  // 已作代表点上环的不重复上。
  const lastHotel = [...plan.skeleton]
    .sort((a, b) => a.day - b.day)
    .reverse()
    .find((d) => d.hotel)?.hotel;
  const wantHotel = lastHotel !== undefined && !nodes.some((n) => n.name === lastHotel.name);
  const energyStop = plan.energyStops?.[0];
  if (energyStop && nodes.length < RING_ORDER.length - (wantHotel ? 1 : 0)) {
    nodes.push({ anchor: RING_ORDER[nodes.length], name: energyStop, kind: "charge" });
  }
  if (wantHotel && nodes.length < RING_ORDER.length) {
    nodes.push({ anchor: RING_ORDER[nodes.length], name: lastHotel.name, kind: "hotel" });
  }
  if (nodes.length === 0) return null; // 整程一个真实地点都没有——没有可上环的数据

  /*
   * 提示卡只放**物品**，且 label 必须就是这张图标画的东西（M20-01 用户走查）。
   *
   * 这里曾经把「先到酒店放行李再出发」挂在水瓶图标上、把当天的天气备注挂在
   * 遮阳帽图标上。图标下的文字一显示出来，卡片就变成了「水瓶 = 放行李」——
   * 而且去重保留的是**先入的**那条，于是真正的「水」「遮阳帽」反被顶掉，
   * 三件物品的名字没有一件对得上图。
   *
   * 行李与天气备注是**行程内容**，归对话层与地图标注（同上一段的取舍）；
   * 它们要重新进这张卡，前提是先有对应的物品贴纸（行李箱 / 雨伞），
   * 而不是借用现有图标的位置。
   */
  /*
   * 分页原样沿用 base：物品清单在有无行程时是同一份，行程只换地图与站点。
   *
   * 这里原来会把整份清单摊平再按图标品类去重（M19-05：同一张图在一张卡上出现
   * 两三次）——那个重复来自上面那些借图标位的行程提示，它们已经不进来了。
   * 而摊平去重有个副作用：`base` 的第 2 页整页被吃掉，行程模式下这张卡永远单页，
   * 页码、圆点、滑动引导跟着一起消失。base 自己的每一页内部本就无重复图标。
   */
  return {
    trip: {
      origin: base.trip.origin,
      nodes,
      // 进度按天：已经过去的天数段更亮——这是行程日历意义上的"已抵达"，
      // 不是定位（HUD 不做导航，Brief §3.1）。
      activeSegment: Math.min(dayIndex, nodes.length),
    },
    energy: base.energy,
    tips: {
      /*
       * 卡片标题固定为「行前温馨提示」（M19-05 用户走查）。
       *
       * 这里原来写的是 `第N天 · 目的地`，于是同一张卡在有无行程时叫两个名字，
       * 而卡片的**职责**并没有变——它自始至终是 Brief §3.3 的物品提醒入口。
       * 行程进行到第几天由地图标记上的 `Day N` 与时刻承担，不必再占标题。
       */
      headline: "行前温馨提示",
      /*
       * 有 `pretripItems` 就用这次行程算出来的（M20-04），否则沿用 base 的基线清单。
       * 老快照没有这个字段——回落是**兼容**，不是降级，所以不加任何标记。
       *
       * 名字在这里查表补上：契约里没有名字，端上也不该自己编一个。
       * 表里没有的 key 直接丢（`tipItemsFromKeys` 负责），一个都不剩时同样回落——
       * 一张空卡比一张旧卡糟。
       */
      pages: withHighlightsPage(pretripPages(plan) ?? base.tips.pages, plan),
    },
    // 行程算出来的天气优先；老快照没有这个字段时回落基线（兼容路径，不加标记）。
    weather: plan.weather ?? base.weather,
    assistantState: base.assistantState,
    freshness: base.freshness,
  };
}

/**
 * 物品页之后**按需追加**一页目的地推荐（M32-02）。
 *
 * 三段全空时一页都不加——`pages` 与没有推荐时**逐字段相等**，
 * 于是 `useCarousel(pages.length)` 自然退回单卡形态，页码与圆点跟着消失。
 * **不给"暂无推荐"留一页占位**：空卡比没有卡糟。
 */
function withHighlightsPage(pages: TipPage[], plan: TripPlanSnapshot): TipPage[] {
  const page = highlightsPage(plan.destinationHighlights);
  return page ? [...pages, page] : pages;
}

/** `pretripItems` → 分页物品；没有可展示的物品时返回 undefined（调用方回落基线）。 */
function pretripPages(plan: TripPlanSnapshot) {
  if (!plan.pretripItems?.length) return undefined;
  const items = tipItemsFromKeys(plan.pretripItems.map((i) => i.key));
  return items.length > 0 ? paginateTipItems(items) : undefined;
}
