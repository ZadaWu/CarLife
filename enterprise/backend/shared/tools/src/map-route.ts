/**
 * map_route —— 路线规划 / 沿途取样点 / 休息点（§5 工具表，FL-18 F-18-04、F-18-08）。
 *
 * 供应商：高德 Web 服务（v5 驾车路径规划 + v5 周边搜索），客户端由装配层注入。
 *
 * # 三块出参，各有明确的下游
 *
 *   summary       —— 总里程/时长/过路费/红绿灯，方案卡直接用
 *   sampledPoints —— **它的消费者是 `weather`**：两个工具由此能在同一次 fan-out 里
 *                    串起来，模型不需要自己编沿途坐标（编出来的坐标查到的是别处的天气）
 *   restStops     —— 按 `maxLegMinutes` 推出的插点附近的高速服务区（F-18-07 的原料）
 *
 * # 不返回原始 steps —— 这是刻意的
 *
 * 一条 400 公里的路线有几百条转向指令。全塞进上下文，贵，而且规划用不上它们：
 * 出行规划要回答的是"几点到、中间在哪停"，不是"第 173 步该向哪转"。
 * 转向指令属于导航，导航在车机原生 App 里。
 *
 * # 停靠点的质量门槛只到"是高速服务区"这一层
 *
 * FL-18 F-18-08 的风险原文：**地图 API 能告诉你有服务区，未必能告诉你卫生间是否合格**。
 * 所以 `restStops` 带 `qualityNote` 说明筛选依据，**不冒充已核实**——清远那次
 * 就是拿"看起来合理"当成"确认过"。
 *
 * # 算路策略（M66-01）：「省钱」是 `36` 少收费，不是 `35` 不走高速
 *
 * 高德 v5 的策略码：32 默认推荐 / 34 高速优先 / 35 不走高速 / 36 少收费。
 * 出发导航规划把"画像偏省钱"落到 `less_toll → 36`：它的语义才是"少花钱"；
 * `35` 在没有平行省道的路段会给出绕远方案（沪杭段实测两者结果相同，但那是巧合不是规则）。
 * 模型只能选枚举名，数字映射写死在 `AMAP_STRATEGY`——让模型填数字等于把文档抄错的机会交给它。
 *
 * # 休息点候选记进按轮白名单（M66-01）
 *
 * 出发导航规划的汇聚层只认**这一轮 `map_route` 真实返回过的**服务区（ADR-008 在导航上的推论：
 * 模型给的坐标当零信息）。所以 `restStops` 组好之后经注入的记录器落到 runtime 的按轮暂存
 * （形态与 `web-search.ts` 的 `setSearchResultRecorder` 同款）。未注入时行为逐字不变。
 */

import { getAmapClient, type AmapClient, type LngLat } from "./amap";
// 距离口径复用补能工具那一份（同一个 haversine 只维护一处，与 route-audit.ts 的先例一致）。
import { haversineKm } from "./charging";
import { ENV_TTL, envCacheKey, roundCoord, withEnvCache } from "./env-cache";
import { defineExternalTool, ToolError, type ExternalTool, type ToolCallContext } from "./external";
import { recordRouteDuration } from "./route-duration-ledger";

/** 算路策略枚举（模型可见的名字）。数字映射见 `AMAP_STRATEGY`，理由见文件头。 */
export type RouteStrategy = "default" | "highway" | "no_highway" | "less_toll";

/**
 * 车辆能源类型。枚举取值与 `cost_calc` 那份一字不差——两处不一致时模型会两边各填各的。
 *
 * 它在这个工具里只影响**停靠点怎么排序**：纯电与插电把「只有油枪」的服务区排到最后，
 * 并顺带探一次场区里有没有充电桩。算路本身与能源类型无关。
 */
export type RouteEnergy = "bev" | "phev" | "icev";

export const ROUTE_STRATEGIES: readonly RouteStrategy[] = ["default", "highway", "no_highway", "less_toll"];

/** 高德 v5 `strategy` 参数取值（官方文档 2026-09-02）。 */
export const AMAP_STRATEGY: Record<RouteStrategy, number> = {
  default: 32,
  highway: 34,
  no_highway: 35,
  less_toll: 36,
};

/** 休息点候选的按轮记录器（M66-01）。由 agent-runtime 注入；`ctx` 缺 turnId 时由记录器决定收不收。 */
export interface RestStopCandidateRecorder {
  record(
    ctx: { sessionId?: string; turnId?: string; agent?: string },
    stops: readonly RestStop[],
    summary: RouteSummary,
  ): void;
}

let restStopRecorder: RestStopCandidateRecorder | undefined;

export function setRestStopCandidateRecorder(r: RestStopCandidateRecorder | undefined): void {
  restStopRecorder = r;
}

function recordCandidates(ctx: ToolCallContext, stops: readonly RestStop[], summary: RouteSummary): void {
  // 记录器出错不该让算路失败——白名单为空只是"途经点全部丢弃"这一档降级。
  try {
    restStopRecorder?.record({ sessionId: ctx.sessionId, turnId: ctx.turnId, agent: ctx.agent }, stops, summary);
  } catch {
    /* 见上 */
  }
}

/** 地点：给地名或给坐标都行，至少给一个。地名由高德地理编码解析。 */
export interface PlaceInput {
  name?: string;
  lat?: number;
  lon?: number;
  /** 地名多义时用它收敛（"人民广场"全国有几十个） */
  city?: string;
}

export interface ResolvedPlace extends LngLat {
  name: string;
}

export interface RouteSummary {
  distanceKm: number;
  durationMin: number;
  tollYuan: number;
  trafficLights: number;
}

export interface RouteSamplePoint extends LngLat {
  /** 形如「途经 120km」；真实地名要花一次逆地理，交给 weather 那一侧顺带做 */
  name: string;
  atKm: number;
  atMinute: number;
}

export interface RestStop extends LngLat {
  name: string;
  type: string;
  /** 从起点算起的大致里程 */
  atKm: number;
  /** 从出发算起的大致分钟数 —— 与 maxLegMinutes 对照即可看出分段是否成立 */
  atMinute: number;
  /**
   * 离**路线**的直线米数（下道要绕多远）。
   *
   * 从前记的是"离插点多远"，那不是绕行：同一条高速上 16km 开外的服务区会被记成
   * 绕行 16km，而它其实就在路边。判据换成到路线的最短距离之后这个字段才名副其实。
   */
  detourM: number | null;
  /**
   * 场区 600m 内有没有登记在册的充电桩。**只在 `energy` 为 `bev`/`phev` 时才探**，
   * 没探就不带这个字段——`false` 的意思是"探过，没有"，不是"不知道"。
   */
  charging?: boolean;
}

export interface MapRouteArgs {
  origin: PlaceInput;
  destination: PlaceInput;
  waypoints?: PlaceInput[];
  /**
   * 单段行车时长上限（分钟）。同行者硬约束（F-18-07，周慧珍 90–120 分钟）
   * 落到工具上就是"每隔这么久要有一个可停的地方"。
   */
  maxLegMinutes?: number;
  /** 沿途取样点数量（喂给 weather 用），默认按里程自适应 */
  samplePoints?: number;
  /** 算路策略（M66-01）。不传 = 请求串里没有 strategy 参数，与从前逐字相同。 */
  strategy?: RouteStrategy;
  /**
   * 车辆能源类型。不传 = 按燃油车排序、且不探充电桩，与改动前的行为最接近。
   *
   * 编排层在分支任务里已经把它写进了提示词（"车辆能源类型：纯电（以车辆档案为准）"），
   * 模型照填即可——同 ADR-012：要一个值就向已经知道它的那一方要。
   */
  energy?: RouteEnergy;
}

export interface MapRouteData {
  origin: ResolvedPlace;
  destination: ResolvedPlace;
  summary: RouteSummary;
  sampledPoints: RouteSamplePoint[];
  restStops: RestStop[];
  /** 停靠点筛选依据的诚实标注（F-18-08 风险） */
  qualityNote: string;
  /** 本次路线是否来自⑤缓存（M11-04）。mock 路径恒为 false。 */
  cached?: boolean;
  /** 实际采用的策略（回显，M66-01）：方案卡要能说"按少收费算路"。不传时为 `default`。 */
  strategy: RouteStrategy;
}

/**
 * 高德「服务区」是一个**中类**，`types=180300` 会把它下面三个子类一起带回来
 * （实测 2026-09-18，京沪高速无锡段）：
 *
 * | typecode | 名称 | 对休息是什么 |
 * |---|---|---|
 * | `180300` | 高速服务区 | 餐饮 + 卫生间 + 便利店，多数带充电桩——要的就是它 |
 * | `180301` | 高速加油站服务区 | **只有油枪**。纯电车停在这里补不了能 |
 * | `180303` | 公路驿站 | 省道 / 城市道路上的停车区，**不在我们这条高速上** |
 *
 * 所以请求照发 `180300`（这是中类码，改不了它捞回全部三类这件事），
 * **筛选在客户端做**。此前没筛：库里最近 60 次调用回了 54 个停靠点，
 * 25 个高速服务区、20 个公路驿站、9 个高速加油站服务区——**过半不是要的那种**，
 * 而给纯电车主推一个只有油枪的服务区，看起来还像是认真查过的。
 */
const SERVICE_AREA_TYPECODE = "180300";
const SERVICE_AREA_RADIUS_M = 25_000;

/** 服务区子类码。`startsWith` 比较，因为高德偶尔在末位再分一级。 */
const TYPECODE_HIGHWAY_SA = "180300";
const TYPECODE_FUEL_SA = "180301";

/**
 * 一个插点取几个候选。
 *
 * 从前是 1——"取最近的那个"。加了子类筛选之后 1 就不够用了：最近的那个可能正是
 * 要筛掉的公路驿站，筛完就成了空手而归，比不筛更糟。多取一些再筛，请求次数不变。
 */
const SERVICE_AREA_CANDIDATES = 10;

/**
 * 候选离路线多远就当它不在这条路上（km）。
 *
 * 25km 的搜索半径是按"服务区本来就隔得远"定的，它同时也会捞到**旁边那条省道上**的
 * 驿站：实测插点处最近的 180303 在 13.1km 外，来回就是 26km。
 * 判据必须是「离**路线**多远」而不是「离**插点**多远」——同一条高速上 16km 开外的
 * 服务区是下一个正常停靠点，垂直方向 13km 的驿站是下道。
 */
const OFF_ROUTE_MAX_KM = 3;

/** 充电桩探测半径（米）：服务区自带的桩就登记在场区内，实测 130~260m。 */
const CHARGER_PROBE_RADIUS_M = 600;

/** 高德 POI 类型：充电站。 */
const CHARGER_TYPECODE = "011100";

const QUALITY_NOTE =
  "停靠点按高德 POI 类型筛到「高速服务区」这一层（已把只有油枪的高速加油站服务区、省道上的公路驿站、**对向那一幅**上的与名字标着在建/暂停的排到最后），" +
  "**未核实卫生间状况与营业时间**。服务区是否达到「能下车走动 + 合格卫生间」，出发前仍需确认。" +
  "`charging` 只说明场区 600m 内有没有登记在册的充电桩，**不代表桩可用、有空位或功率合适**。";

/**
 * 名字里带这些字样的，当**还不能用**处理。
 *
 * 高德把状态直接写进 POI 名字（`朱雀停车区(京昆高速昆明方向)(建设中)`），
 * 结构化字段里没有这一项——`types` 筛不掉它，`typecode` 也一样是 180303。
 * 五条跨省路线上取到的 49 个不同名字里只出现过 `建设中` 一种写法；
 * 其余几个是同族的常见说法，一并收着——它们都不可能出现在一个正常营业的服务区名里，
 * 而**漏掉一个的代价是把车带去一片工地**。
 *
 * 与对向那一幅同样是**降级不剔除**：这一段上只剩它时，说"这里有个服务区，但在建"
 * 比说"这一段没有服务区"更有用——前者车主还能自己判断要不要碰运气。
 */
const CLOSED_MARKERS = /建设中|在建|施工|暂停|停业|已关闭|停用|未开放/;

/**
 * 候选停靠点的优先级：数字越小越靠前，`undefined` = 不要。
 *
 * 纯电与插电把「只有油枪」那一类排到最后——它补不了能，但仍然能下车上厕所，
 * 所以是降级而不是剔除：一路上只剩它的时候，给出来比说"没有服务区"有用。
 */
function restStopRank(typecode: string, energy: RouteEnergy | undefined): number {
  const electric = energy === "bev" || energy === "phev";
  if (typecode.startsWith(TYPECODE_HIGHWAY_SA)) return 0;
  if (typecode.startsWith(TYPECODE_FUEL_SA)) return electric ? 2 : 1;
  // 其余（公路驿站等）：经过离路线的筛选之后留下来的确实在这条路上，当兜底。
  return electric ? 1 : 2;
}

/**
 * 候选在路线上的位置 + 它离路线有多远。
 *
 * 位置取自**最近的那个游标**，不是插点——服务区就在它自己所在的公里数上。
 * 从前 `atKm` / `atMinute` 记的是插点的值，于是一个在 169km 处的服务区被报成
 * 153km，而那个数正是编排层拿去对单段上限的。
 */
interface RouteProjection {
  km: number;
  minute: number;
  /** 到路线的**垂直**距离（km）。 */
  offRouteKm: number;
  /** 落在第几段上（用来取朝向）。 */
  index: number;
  /** 垂足本身——判左右要拿它当参照点，取折线端点会带进半段的偏差。 */
  at: LngLat;
}

/**
 * 候选在路线上的垂足：位置、离路线多远、落在哪一段。
 *
 * **比到最近折线点的距离，不比到最近折线点**——高速上的折线点间隔 100~150m，
 * 只比端点的话，一个正压在路上的服务区也会量出几十米的"偏离"，
 * 而那个量级正是两幅路之间的距离：左右就跟着一起判飘了。
 */
function projectOnRoute(cursors: readonly Cursor[], at: LngLat): RouteProjection | undefined {
  if (cursors.length === 0) return undefined;
  if (cursors.length === 1) {
    const only = cursors[0]!;
    return { km: only.km, minute: only.minute, offRouteKm: haversineKm(only.at, at), index: 0, at: only.at };
  }
  const k = Math.cos((at.lat * Math.PI) / 180);
  let best: RouteProjection | undefined;
  for (let i = 0; i + 1 < cursors.length; i += 1) {
    const a = cursors[i]!;
    const b = cursors[i + 1]!;
    const ax = (a.at.lon - at.lon) * k;
    const ay = a.at.lat - at.lat;
    const dx = (b.at.lon - a.at.lon) * k;
    const dy = b.at.lat - a.at.lat;
    const len2 = dx * dx + dy * dy;
    // 垂足落在段外就夹到端点——路线是折线不是直线，段外的垂足不在路上。
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const foot: LngLat = {
      lat: a.at.lat + (b.at.lat - a.at.lat) * t,
      lon: a.at.lon + (b.at.lon - a.at.lon) * t,
    };
    const d = haversineKm(foot, at);
    if (best && d >= best.offRouteKm) continue;
    best = {
      km: a.km + (b.km - a.km) * t,
      minute: a.minute + (b.minute - a.minute) * t,
      offRouteKm: d,
      index: i,
      at: foot,
    };
  }
  return best;
}

/**
 * 判断朝向用的前后跨距（km）。
 *
 * 太短会被折线抖动带偏（高速上的点间隔 100~150m，单点间的方向噪声不小），
 * 太长会在弯道上把朝向抹平。200m 是这条路上稳定的最小跨距。
 */
const HEADING_SPAN_KM = 0.2;

/**
 * 离路线多近就认为左右分不出来（km）。
 *
 * 两幅路的中心线相距只有几十米，而 POI 坐标给的是场区中心不是匝道口。
 * 60m 以内的判定不可信，当同侧处理——宁可放过一个对向的，不要把同向的误杀。
 */
const SIDE_AMBIGUOUS_KM = 0.06;

/**
 * 候选是不是在**对向那一幅**上。
 *
 * 中国是右侧通行，服务区从自己这一幅的**右手边**进——所以"在行进方向左边"
 * 基本等于"在对面，过不去"。判据是叉积的符号：>0 = 左。
 *
 * 真跑实测（2026-09-18，沪蓉/京沪 上海⇄南京，四对双侧服务区）左右与名字里的
 * 方向词**完全对得上**：
 *
 * | 行进 | 右手边（可进） | 左手边（对向） |
 * |---|---|---|
 * | 上海→南京 | 阳澄湖(京沪高速**北京**方向) 165m | 阳澄湖(京沪高速**上海**方向) 88m |
 * | 上海→南京 | 芳茂山(沪蓉高速**成都**方向) 86m | 芳茂山(沪蓉高速**上海**方向) 94m |
 * | 上海→南京 | 仙人山(沪蓉高速**成都**方向) 170m | 仙人山(沪蓉高速**上海**方向) 188m |
 * | 南京→上海 | 窦庄(沪蓉高速**上海**方向) 106m | 窦庄(沪蓉高速**成都**方向) 141m |
 *
 * **判据取几何不取名字**：名字的写法有好几种（带不带 G 编号、单侧服务区根本不写方向），
 * 而我们要的那个事实——"它在不在我这一幅上"——路线折线本身就答得了。
 * 注意左边那几个离路线**更近**，所以按距离挑必然挑错：这正是改动前每次都给出对向那一侧的原因。
 */
function onOppositeSide(cursors: readonly Cursor[], on: RouteProjection, poi: LngLat): boolean {
  if (on.offRouteKm < SIDE_AMBIGUOUS_KM) return false;
  const here = on.at;
  let a = here;
  for (let i = on.index; i >= 0; i -= 1) {
    a = cursors[i]!.at;
    if (haversineKm(a, here) >= HEADING_SPAN_KM) break;
  }
  let b = here;
  for (let i = on.index + 1; i < cursors.length; i += 1) {
    b = cursors[i]!.at;
    if (haversineKm(b, here) >= HEADING_SPAN_KM) break;
  }
  // 经度按纬度收缩成等距，否则中纬度上横向会被放大 15%，弯道附近够翻符号。
  const k = Math.cos((here.lat * Math.PI) / 180);
  const hx = (b.lon - a.lon) * k;
  const hy = b.lat - a.lat;
  // 取不到朝向（首尾同点）就不判——不知道时不降级。
  if (hx === 0 && hy === 0) return false;
  const vx = (poi.lon - here.lon) * k;
  const vy = poi.lat - here.lat;
  return hx * vy - hy * vx > 0;
}

/** 取样点数量按里程自适应：短途取 3 个，每 100 公里加 1 个，上限 8 个。 */
function defaultSampleCount(distanceKm: number): number {
  return Math.max(3, Math.min(8, 3 + Math.floor(distanceKm / 100)));
}

async function resolvePlace(
  amap: AmapClient,
  p: PlaceInput,
  role: string,
  signal?: AbortSignal,
): Promise<ResolvedPlace> {
  if (typeof p.lat === "number" && typeof p.lon === "number") {
    return { lat: p.lat, lon: p.lon, name: p.name?.trim() || `${role}(${p.lat},${p.lon})` };
  }
  const address = p.name?.trim();
  if (!address) {
    throw new ToolError("map_route", "invalid", `${role}必须给地名或经纬度`, false);
  }
  const hit = await amap.geocode(address, p.city, signal);
  // 用用户说的名字，不用高德的 formatted_address——"深圳北站"比
  // "广东省深圳市龙华区深圳北站(公交站)"更接近用户脑子里的那个地方。
  return { lat: hit.lat, lon: hit.lon, name: address };
}

interface Cursor {
  km: number;
  minute: number;
  at: LngLat;
}

/**
 * 沿路线走一遍，在给定的累计里程处取点。
 *
 * **游标落在折线点上，不是 step 端点上。**
 *
 * 曾经只在每个 step 的终点落一个游标，理由写着"step 通常几百米，精度够查天气"。
 * 那个前提是错的：高德 v5 把一整段高速合成**一条** step——真跑实测
 * 上海→江宁区 321km 共 36 个 step，其中一个从 35.4km 一路盖到 279.7km
 * （244km，41→206 分钟，折线 1701 个点）。于是 41~206 分钟之间任何一个插点
 * 都被 `find(minute >= target)` 吸到 206 分钟那一头。
 *
 * 症状离根因很远，且**全程不报错**：turn-54929566 里 180 分钟上限的休息点插在
 * 第 209 分钟（离终点只剩 40km），天气取样点 4 个全是「途经 280km」；
 * 修复轮把上限收紧到 90 分钟，三个插点仍然落在同一个位置，于是模型两轮都只看到
 * 同一个服务区，如实回报"线路数据里没有更密的服务区"——而车主在高德上看得见 8 个。
 *
 * 所以按折线走：step 自己的 `step_distance` / `cost.duration` 仍是里程与时长的真相源
 * （不拿几何长度当里程，避免折线抽稀带来的误差），几何长度只用来决定**这一步走到哪了**，
 * 每个 step 的末游标恒等于它的累计值，逐 step 不累积漂移。
 */
function walk(steps: readonly RouteStep[]): Cursor[] {
  const cursors: Cursor[] = [];
  let km = 0;
  let minute = 0;
  for (const s of steps) {
    const stepKm = s.distanceM / 1000;
    const stepMin = s.durationS / 60;
    const pts = s.points;
    const km0 = km;
    const min0 = minute;
    km += stepKm;
    minute += stepMin;
    // 没有折线（或只有一个点）就退回老行为：这一步只贡献它的终点。
    if (pts.length <= 1) {
      const last = pts[pts.length - 1];
      if (last) cursors.push({ km, minute, at: last });
      continue;
    }
    const segs: number[] = [];
    let geo = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const d = haversineKm(pts[i - 1]!, pts[i]!);
      segs.push(d);
      geo += d;
    }
    let acc = 0;
    for (let i = 0; i < segs.length; i += 1) {
      acc += segs[i]!;
      // 折线点重合（geo=0）时按点序等分——比全部落在同一处好，且这一步本来就没里程。
      const f = geo > 0 ? acc / geo : (i + 1) / segs.length;
      cursors.push({ km: km0 + stepKm * f, minute: min0 + stepMin * f, at: pts[i + 1]! });
    }
  }
  return cursors;
}

interface RouteStep {
  distanceM: number;
  durationS: number;
  points: LngLat[];
}

/** 在游标序列里找第一个累计里程 ≥ 目标的点。 */
function seek(cursors: Cursor[], targetKm: number): Cursor | undefined {
  return cursors.find((c) => c.km >= targetKm) ?? cursors[cursors.length - 1];
}

export const mapRouteTool: ExternalTool<MapRouteArgs, MapRouteData> = defineExternalTool<
  MapRouteArgs,
  MapRouteData
>({
  name: "map_route",
  provider: "amap",
  sensitive: false,
  timeoutMs: 8_000,
  retries: 2,

  async real(args, ctx) {
    const amap = getAmapClient();
    if (!amap) {
      // 与 ragflow 同一条原则：未接入要**明说未接入**，不返回一条编的路线。
      throw new ToolError(
        "map_route",
        "unconfigured",
        "地图能力未接入（AMAP_SERVER_KEY 未配置）",
        false,
      );
    }

    const [origin, destination] = await Promise.all([
      resolvePlace(amap, args.origin, "起点", ctx.signal),
      resolvePlace(amap, args.destination, "终点", ctx.signal),
    ]);
    const waypoints = args.waypoints?.length
      ? await Promise.all(
          args.waypoints.map((w, i) => resolvePlace(amap, w, `途经点${i + 1}`, ctx.signal)),
        )
      : undefined;

    /*
     * ⑤缓存（M11-04）。**TTL 只有 3 分钟**——实时路况是这个工具的价值所在，
     * 缓存久了等于给过期路况，而过期路况带着"刚查的"可信度，比不缓存更糟。
     *
     * 3 分钟仍然值得做：实测一轮出行规划里同一条路线被调了两次
     * （579ms + 508ms），那次浪费完全落在这个窗口内。
     *
     * key 只含坐标（取整到 ~1km）与途经点，**不含 userId / 会话 id**——
     * 同一条路对所有人是同一条，带上用户维度既泄露隐私又让命中率归零。
     */
    const strategy: RouteStrategy = args.strategy ?? "default";
    /*
     * 键末尾追加策略（M66-01）：同起终点的高速方案与省道方案是两条不同的路，
     * 不加这一维，3 分钟内后到的那个会拿到先到那个的缓存——探针里 `strategy=36` 只回 1 条候选、
     * `34` 回 3 条，候选集本身就不同。既有键的前五段格式一字不动。
     */
    const routeKey = envCacheKey("route", [
      roundCoord(origin.lat),
      roundCoord(origin.lon),
      roundCoord(destination.lat),
      roundCoord(destination.lon),
      (waypoints ?? []).map((w) => `${roundCoord(w.lat)},${roundCoord(w.lon)}`).join("|") || "-",
      strategy,
    ]);
    const { value: path, cached: routeCached } = await withEnvCache(routeKey, ENV_TTL.route, () =>
      amap.driving(
        {
          origin,
          destination,
          waypoints,
          // `default` 不发参数：与 M66 之前的请求串逐字相同，既有调用方（trip/drive）不受影响。
          ...(strategy === "default" ? {} : { strategy: AMAP_STRATEGY[strategy] }),
        },
        ctx.signal,
      ),
    );

    const distanceKm = path.distanceM / 1000;
    const durationMin = path.durationS / 60;
    const summary: RouteSummary = {
      distanceKm: round1(distanceKm),
      durationMin: Math.round(durationMin),
      tollYuan: path.tollYuan,
      trafficLights: path.trafficLights,
    };

    const cursors = walk(path.steps);

    // ── 沿途取样点：等距取，首尾用起终点本身 ────────────────────
    const n = Math.max(2, args.samplePoints ?? defaultSampleCount(distanceKm));
    const sampledPoints: RouteSamplePoint[] = [];
    for (let i = 0; i < n; i += 1) {
      const targetKm = (distanceKm * i) / (n - 1);
      if (i === 0) {
        sampledPoints.push({ ...origin, name: origin.name, atKm: 0, atMinute: 0 });
        continue;
      }
      if (i === n - 1) {
        sampledPoints.push({
          ...destination,
          name: destination.name,
          atKm: summary.distanceKm,
          atMinute: summary.durationMin,
        });
        continue;
      }
      const c = seek(cursors, targetKm);
      if (!c) continue;
      sampledPoints.push({
        ...c.at,
        name: `途经 ${Math.round(c.km)}km`,
        atKm: round1(c.km),
        atMinute: Math.round(c.minute),
      });
    }

    // ── 休息点：按 maxLegMinutes 定插点，再在插点附近找服务区 ────
    const restStops: RestStop[] = [];
    const legCap = args.maxLegMinutes;
    if (legCap && legCap > 0 && durationMin > legCap) {
      const legs = Math.ceil(durationMin / legCap);
      const anchors: Cursor[] = [];
      for (let i = 1; i < legs; i += 1) {
        const targetMin = (durationMin * i) / legs;
        const c = cursors.find((x) => x.minute >= targetMin);
        if (c) anchors.push(c);
      }
      const found = await Promise.all(
        anchors.map((a) =>
          amap
            .around(
              {
                at: a.at,
                types: SERVICE_AREA_TYPECODE,
                radiusM: SERVICE_AREA_RADIUS_M,
                limit: SERVICE_AREA_CANDIDATES,
              },
              ctx.signal,
            )
            // 某一段找不到服务区不该让整条路线失败——**它是一条要说出来的信息**，
            // 由汇聚层决定怎么表述（"第二段 130 分钟内没有服务区"）。
            .catch(() => []),
        ),
      );
      /** 同一个服务区不重复占两个插点——占了也只是同一个地方写两遍。 */
      const taken = new Set<string>();
      anchors.forEach((a, i) => {
        const picked = (found[i] ?? [])
          .flatMap((poi) => {
            const on = projectOnRoute(cursors, poi);
            // 离路线太远 = 要下道绕过去，不是"路边的服务区"。
            if (!on || on.offRouteKm > OFF_ROUTE_MAX_KM) return [];
            if (taken.has(poi.id || poi.name)) return [];
            return [
              {
                poi,
                on,
                closed: CLOSED_MARKERS.test(poi.name),
                opposite: onOppositeSide(cursors, on, poi),
                rank: restStopRank(poi.typecode, args.energy),
              },
            ];
          })
          /*
           * 排序四级：**能不能用** > 能不能进 > 是哪一类 > 离插点多近。
           *
           * 前两级都是"到了那儿有没有用"，压过类型：右手边一个只有油枪的服务区
           * 能停下来上厕所，对面一个带充电桩的正经服务区过不去，一片工地则谁都用不上。
           * 两者都**降级不剔除**——单侧服务区在高德里常常只登记一条，
           * 硬剔会把真实存在的停靠点一起丢掉。
           */
          .sort(
            (x, y) =>
              Number(x.closed) - Number(y.closed) ||
              Number(x.opposite) - Number(y.opposite) ||
              x.rank - y.rank ||
              Math.abs(x.on.minute - a.minute) - Math.abs(y.on.minute - a.minute),
          )[0];
        if (!picked) return;
        taken.add(picked.poi.id || picked.poi.name);
        restStops.push({
          lat: picked.poi.lat,
          lon: picked.poi.lon,
          name: picked.poi.name,
          type: picked.poi.type,
          atKm: round1(picked.on.km),
          atMinute: Math.round(picked.on.minute),
          detourM: Math.round(picked.on.offRouteKm * 1000),
        });
      });

      /*
       * 纯电 / 插电：选定之后再探一次场区里有没有充电桩（M105，车主提的那条）。
       *
       * 服务区自带的桩就登记在场区内（实测堰桥服务区 130~260m 有三个，含一个蔚来换电站），
       * 所以一次 600m 的周边搜就够。**只对选中的那几个探**，一条路线最多多几次请求；
       * 燃油车一次都不多打。探失败按"没探到"处理，不写 `charging`——
       * 编不出来的信息宁可缺字段，也不要一个看起来确定的 false。
       */
      if (args.energy === "bev" || args.energy === "phev") {
        const chargers = await Promise.all(
          restStops.map((s) =>
            amap
              .around(
                { at: s, types: CHARGER_TYPECODE, radiusM: CHARGER_PROBE_RADIUS_M, limit: 1 },
                ctx.signal,
              )
              .then((pois) => pois.length > 0)
              .catch(() => undefined),
          ),
        );
        restStops.forEach((s, i) => {
          if (chargers[i] !== undefined) s.charging = chargers[i];
        });
      }
    }

    recordCandidates(ctx, restStops, summary);
    // 这条路实际算出来多少分钟（ACR-047 第二道）：提交时按它核对各段之和，见 route-duration-ledger.ts。
    recordRouteDuration(ctx, { from: origin.name, to: destination.name, durationMin: summary.durationMin });

    // `cached` 进结果：回放页四问④要能区分"刚查的"与"缓存的"——
    // 两者的新鲜度不同，而它们长得一模一样。
    return {
      origin,
      destination,
      summary,
      sampledPoints,
      restStops,
      qualityNote: QUALITY_NOTE,
      cached: routeCached,
      strategy,
    };
  },

  /**
   * mock：一条固定的深圳→广州，数字取整得一眼假（136km / 150 分钟）。
   * 四件套会把 `source.kind` 标成 mock，但内容本身也不该看起来像真实规划结果。
   */
  mock(args, ctx) {
    const origin: ResolvedPlace = { lat: 22.55, lon: 114.05, name: args.origin.name ?? "起点" };
    const destination: ResolvedPlace = {
      lat: 23.13,
      lon: 113.26,
      name: args.destination.name ?? "终点",
    };
    const summary: RouteSummary = { distanceKm: 136, durationMin: 150, tollYuan: 68, trafficLights: 10 };
    const electric = args.energy === "bev" || args.energy === "phev";
    const restStops: RestStop[] = args.maxLegMinutes
      ? [
          {
            lat: 22.94,
            lon: 113.7,
            name: "（模拟）厚街服务区",
            type: "道路附属设施;服务区;高速服务区",
            atKm: 68,
            atMinute: 75,
            detourM: 1200,
            // 真路径只在纯电/插电时探桩，mock 照同一条规则——否则本地走查看不出这个字段何时缺席。
            ...(electric ? { charging: true } : {}),
          },
        ]
      : [];
    // mock 路径同样记录候选：否则 `CARLIFE_TOOLS=mock` 下导航规划的白名单永远为空，
    // 本地走查会看到"0 个休息点通过校验"而根本分不清是模型错还是环境错。
    recordCandidates(ctx, restStops, summary);
    recordRouteDuration(ctx, { from: origin.name, to: destination.name, durationMin: summary.durationMin });
    return {
      origin,
      destination,
      summary,
      sampledPoints: [
        { ...origin, atKm: 0, atMinute: 0 },
        { lat: 22.9, lon: 113.6, name: "途经 68km", atKm: 68, atMinute: 75 },
        { ...destination, atKm: 136, atMinute: 150 },
      ],
      restStops,
      qualityNote: QUALITY_NOTE,
      strategy: args.strategy ?? "default",
    };
  },
});

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
