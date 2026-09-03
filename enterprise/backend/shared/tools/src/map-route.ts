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
import { ENV_TTL, envCacheKey, roundCoord, withEnvCache } from "./env-cache";
import { defineExternalTool, ToolError, type ExternalTool, type ToolCallContext } from "./external";

/** 算路策略枚举（模型可见的名字）。数字映射见 `AMAP_STRATEGY`，理由见文件头。 */
export type RouteStrategy = "default" | "highway" | "no_highway" | "less_toll";

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
  /** 距该插点的直线米数 */
  detourM: number | null;
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

/** 高德 POI 类型：高速服务区。**不含普通加油站与路边停车区**——后者不满足"能下车走动"。 */
const SERVICE_AREA_TYPECODE = "180300";
const SERVICE_AREA_RADIUS_M = 25_000;

const QUALITY_NOTE =
  "停靠点只按高德 POI 类型「高速服务区」筛选，**未核实卫生间状况与营业时间**。" +
  "服务区是否达到「能下车走动 + 合格卫生间」，出发前仍需确认。";

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
 * 用 step 端点而不是在折线上插值：step 的 `step_distance` 与 `cost.duration` 是高德
 * 直接给的，累加不会引入几何误差；取样点精度到一个 step（通常几百米）足够查天气。
 */
function walk(steps: readonly RouteStep[]): Cursor[] {
  const cursors: Cursor[] = [];
  let km = 0;
  let minute = 0;
  for (const s of steps) {
    km += s.distanceM / 1000;
    minute += s.durationS / 60;
    const last = s.points[s.points.length - 1];
    if (last) cursors.push({ km, minute, at: last });
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
              { at: a.at, types: SERVICE_AREA_TYPECODE, radiusM: SERVICE_AREA_RADIUS_M, limit: 1 },
              ctx.signal,
            )
            // 某一段找不到服务区不该让整条路线失败——**它是一条要说出来的信息**，
            // 由汇聚层决定怎么表述（"第二段 130 分钟内没有服务区"）。
            .catch(() => []),
        ),
      );
      anchors.forEach((a, i) => {
        const poi = found[i]?.[0];
        if (!poi) return;
        restStops.push({
          lat: poi.lat,
          lon: poi.lon,
          name: poi.name,
          type: poi.type,
          atKm: round1(a.km),
          atMinute: Math.round(a.minute),
          detourM: poi.distanceM,
        });
      });
    }

    recordCandidates(ctx, restStops, summary);

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
          },
        ]
      : [];
    // mock 路径同样记录候选：否则 `CARLIFE_TOOLS=mock` 下导航规划的白名单永远为空，
    // 本地走查会看到"0 个休息点通过校验"而根本分不清是模型错还是环境错。
    recordCandidates(ctx, restStops, summary);
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
