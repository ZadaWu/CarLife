/**
 * weather —— 沿途逐段天气（§5 工具表）。
 *
 * 它是**四件套的第一个真实使用者**：超时、重试退避、Mock 三态、来源标注全部经它验证
 * （施工单 M4-03 任务 3）。业务上它是出行规划并行 fan-out 的一路（§11、FL-18 F-18-03）。
 *
 * # 结构：一层基础预报 + 一层详情增强（M10-02）
 *
 * M10-01 时这里是**二选一**：有高德 key 走高德，否则 Open-Meteo。问题是高德的天气
 * 接口只给得出日高低温、中文现象和风力——出行规划真正要回答的"路上会不会淋雨、
 * 后排会不会太闷"，它一个都答不了。所以改成两层：
 *
 *   基础预报  高德（有 key）| Open-Meteo（无 key）—— 日高低温 + 天气现象
 *   详情增强  中国气象局（无 key，大陆可达）—— 体感/湿度/降水实况 + 气象预警 + 把窗口拉到 7 天
 *
 * **增强层挂了不影响主干**：取不到就少那几个字段，并在 `unavailable` 里说明原因，
 * 整次调用照常返回。
 *
 * # 三条不能违反的诚实约定
 *
 * 1. **实况不能安到未来日期上。** CMA 的 `now`（体感/湿度/降水/气压/风）是此刻的观测。
 *    查明天时 `observed` 必须为 `null`——拿今天的体感当后天的体感，是"看起来正常的假数据"。
 * 2. **"该源不提供"要说出来，不能只是字段缺失。** 高德+CMA 这个组合拿不到紫外线、
 *    能见度、降雪量；字段缺失会被上层读成"今天紫外线为 0"，比没有更糟。所以有 `unavailable`。
 * 3. **哪个字段来自谁要能追。** `source.provider` 只能标一次调用一个供应商，
 *    现在一段结果里混了两三个来源，所以另有 `sources` 逐项标注。
 */

import { getAmapClient, type AmapClient, type LngLat } from "./amap";
import { CMA_LIMITS, getCmaClient, type CmaAlarm, type CmaClient, type CmaView } from "./cma";
import { ENV_TTL, envCacheKey, roundCoord, withEnvCache } from "./env-cache";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";

export interface WeatherArgs {
  /** 沿途取样点；出行规划按路线分段取点后传入（`map_route` 的 `sampledPoints` 可直接喂进来） */
  points: Array<{ name: string; lat: number; lon: number }>;
  /** 目标日期（YYYY-MM-DD）；省略取今天 */
  date?: string;
}

/** 实况观测（中国气象局）。**只在查询日期是今天时出现**。 */
export interface WeatherObservation {
  /** 观测站名与它离取样点多远——太远的观测不该被当成"这里的天气" */
  station: string;
  stationDistanceKm: number;
  observedAt: string;
  temperatureC: number | null;
  /** 体感温度：高德整条链路都没有这个数，它是接 CMA 的主要理由之一 */
  feelsLikeC: number | null;
  humidityPct: number | null;
  /** 实况降水（mm）。与下面的 `precipitationMm`（当日预报累计）**不是一回事** */
  precipitationMm: number | null;
  pressureHpa: number | null;
  windDirection: string | null;
  windDirectionDeg: number | null;
  windSpeedMs: number | null;
  windScale: string | null;
}

export interface WeatherSegment {
  name: string;
  date: string;
  tempMinC: number | null;
  tempMaxC: number | null;
  /** 当日**预报**累计降水（mm）。高德不提供 → null；实况降水在 `observed` 里 */
  precipitationMm: number | null;
  /** 原始天气代码，供上层做"是否适合出行"的判断，不在工具里下结论（Open-Meteo 才有） */
  weatherCode: number | null;
  /** 中文天气现象（白天），如「雷阵雨」。高德与 CMA 都有，可直接播报 */
  condition?: string | null;
  /** 风力等级，如「1-3」「5级」 */
  windPower?: string | null;
  /** 该取样点落在哪个城市——天气是城市粒度的，说清楚是哪个城市的预报 */
  city?: string | null;
  /** 紫外线指数（当日最大）。**只有 Open-Meteo 提供**；高德+CMA 组合下为 null */
  uvIndexMax?: number | null;
  /** 能见度（km）。**只有 Open-Meteo 提供**；高德+CMA 组合下为 null */
  visibilityKm?: number | null;
  /** 当日降雪量（cm）。只有 Open-Meteo 提供 */
  snowfallCm?: number | null;
  /** 体感温度（预报值，Open-Meteo）。CMA 的体感是实况，在 `observed` 里 */
  apparentTempMaxC?: number | null;
  /** 相对湿度（预报值，Open-Meteo）。CMA 的湿度是实况，在 `observed` 里 */
  humidityPct?: number | null;
  /** 实况观测（中国气象局）。**仅当查询日期是今天** */
  observed?: WeatherObservation | null;
  /** 当前生效的气象预警。与日期无关——预警说的是"现在" */
  alarms?: WeatherAlarm[];
  /** 这一段的字段分别来自谁，如 ["amap:forecast","cma:observed"] */
  sources?: string[];
  /** 本次组合**结构性拿不到**的字段与原因。空数组表示都拿到了 */
  unavailable?: string[];
}

export interface WeatherAlarm {
  title: string;
  type: string;
  level: string;
  severity: string;
  effective: string;
}

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/** 高德预报窗口：`casts` 返回今天 + 之后 3 天，共 4 条（实测）。 */
const AMAP_FORECAST_DAYS = 4;
/** 中国气象局 `daily` 返回 7 天（含今天，实测）。 */
const CMA_FORECAST_DAYS = 7;

// ── Open-Meteo：字段取全（M10-02 任务 2 末条）───────────────────

const OM_DAILY = [
  "temperature_2m_min",
  "temperature_2m_max",
  "precipitation_sum",
  "rain_sum",
  "snowfall_sum",
  "weather_code",
  "uv_index_max",
  "apparent_temperature_max",
].join(",");

interface OpenMeteoDaily {
  temperature_2m_min?: number[];
  temperature_2m_max?: number[];
  precipitation_sum?: number[];
  snowfall_sum?: number[];
  weather_code?: number[];
  uv_index_max?: number[];
  apparent_temperature_max?: number[];
}

async function fetchOne(
  p: WeatherArgs["points"][number],
  date: string,
  signal?: AbortSignal,
): Promise<WeatherSegment> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("latitude", String(p.lat));
  url.searchParams.set("longitude", String(p.lon));
  url.searchParams.set("daily", OM_DAILY);
  // 湿度与能见度只有小时粒度；取当日均值/最小值代价高，这里取当前值即可满足
  // "带不带伞、看不看得见"的判断，并在 sources 里标明是 current 而非 daily。
  url.searchParams.set("current", "relative_humidity_2m,visibility");
  url.searchParams.set("start_date", date);
  url.searchParams.set("end_date", date);
  url.searchParams.set("timezone", "Asia/Shanghai");

  const res = await fetch(url, { signal });
  if (!res.ok) {
    // 4xx 多半是参数错，重试没用；5xx 与网络错才值得重试。
    throw new ToolError("weather", "upstream", `HTTP ${res.status}`, res.status >= 500);
  }
  const body = (await res.json()) as {
    daily?: OpenMeteoDaily;
    current?: { relative_humidity_2m?: number; visibility?: number };
  };
  const d = body.daily;
  const c = body.current;
  return {
    name: p.name,
    date,
    tempMinC: d?.temperature_2m_min?.[0] ?? null,
    tempMaxC: d?.temperature_2m_max?.[0] ?? null,
    precipitationMm: d?.precipitation_sum?.[0] ?? null,
    weatherCode: d?.weather_code?.[0] ?? null,
    snowfallCm: d?.snowfall_sum?.[0] ?? null,
    uvIndexMax: d?.uv_index_max?.[0] ?? null,
    apparentTempMaxC: d?.apparent_temperature_max?.[0] ?? null,
    humidityPct: c?.relative_humidity_2m ?? null,
    visibilityKm: typeof c?.visibility === "number" ? c.visibility / 1000 : null,
    sources: ["open-meteo:forecast"],
    unavailable: [],
  };
}

// ── 高德：日高低温 + 中文现象 ─────────────────────────────────

/**
 * 高德路径：坐标 → adcode → 城市预报。
 *
 * **按 adcode 分组是必须的**，不是优化：同一个市的十个取样点拿到的是同一份预报，
 * 分别去查只是把同样的答案买十遍。
 */
async function fetchAllViaAmap(
  amap: AmapClient,
  points: WeatherArgs["points"],
  date: string,
  signal?: AbortSignal,
): Promise<WeatherSegment[]> {
  /*
   * ⑤缓存（M11-04）。天气是这条链路上最贵的一跳——实测一次沿途查询 2888ms，
   * 而出行规划会按取样点逐段查。
   *
   * 两级都缓存，TTL 依据不同：
   *  - **逆地理编码**（坐标→adcode）：24 小时。行政区划一天内不会变，
   *    这一跳纯粹是浪费；
   *  - **预报**：30 分钟。高德预报本身按小时/半天更新，30 分钟内重复查
   *    必然拿到同一份。
   *
   * key 只含取整坐标与 adcode，**不含 userId / 会话 id**——
   * 同一个地点的天气对所有人是同一份。
   */
  const regeos = await Promise.all(
    points.map(async (p) => {
      const key = envCacheKey("regeo", [roundCoord(p.lat), roundCoord(p.lon)]);
      const { value } = await withEnvCache(key, 24 * 60 * 60, () =>
        amap.regeo({ lat: p.lat, lon: p.lon } satisfies LngLat, signal),
      );
      return value;
    }),
  );

  const uniqueAdcodes = [...new Set(regeos.map((r) => r.adcode))];
  const forecasts = new Map(
    await Promise.all(
      uniqueAdcodes.map(async (adcode) => {
        const key = envCacheKey("amap-forecast", [adcode]);
        const { value } = await withEnvCache(key, ENV_TTL.weatherForecast, () =>
          amap.forecast(adcode, signal),
        );
        return [adcode, value] as const;
      }),
    ),
  );

  return points.map((p, i) => {
    const regeo = regeos[i];
    const cast = forecasts.get(regeo.adcode)?.casts.find((c) => c.date === date);
    if (!cast) {
      // 走到这里说明高德在窗口内也没给这一天——是数据问题，不是我们的判断问题。
      throw new ToolError(
        "weather",
        "upstream",
        `高德没有返回 ${regeo.city || regeo.adcode} 在 ${date} 的预报`,
        true,
      );
    }
    return {
      name: p.name,
      date,
      tempMinC: cast.nightTempC,
      tempMaxC: cast.dayTempC,
      precipitationMm: null, // 高德不提供降水毫米数
      weatherCode: null, // 高德给的是中文现象，没有数值代码
      condition: cast.dayWeather || null,
      windPower: cast.dayPower || null,
      city: regeo.city || regeo.district || null,
      sources: ["amap:forecast"],
      unavailable: [],
    } satisfies WeatherSegment;
  });
}

// ── 中国气象局：详情增强 ──────────────────────────────────────

/**
 * 给每个取样点找最近站点并取一次 `view`。
 *
 * **按站点去重**：一条 400 公里的路线上多个取样点常常落在同一个站的辖区里，
 * 分别去查是白买。返回 `undefined` 表示该点没有可用站点（超过 100km），
 * 这是一条要说出来的信息，不是失败。
 */
/**
 * 取一个站点的 CMA 视图，带⑤缓存。
 *
 * # TTL 取实况那一档（10 分钟），不取预报那一档
 *
 * `view` 一次返回三样东西：实况、7 天预报、预警。三者的时效差着数量级，
 * 而**混在一起时必须按最快的那个定 TTL**——按预报的 30 分钟缓存，会把
 * "现在几度"答成半小时前的几度，那正是这一跳存在的理由（高德给不了实况）。
 *
 * # 预警会因此最多晚 10 分钟，这是明知的取舍
 *
 * 一条刚发布的暴雨红色预警，最坏情况下 10 分钟内查不到。接受它的理由是：
 * 这条链路服务的是出行规划的问答，不是预警推送；真要做预警推送，那是另一条
 * 主动通知的路径，不该靠"用户恰好又问了一次"来触发。
 * 哪天真接了预警推送，这一条要拆开——预警不能走缓存。
 *
 * # 按站点做键，不按坐标
 *
 * `nearestStation` 已经把一片区域的取样点收敛到同一个站了（那是纯计算，
 * 站点表在进程内缓存，不走网络）。再按坐标做键等于把已经收敛掉的差异
 * 重新引进来，命中率白白掉一截。
 */
function cachedCmaView(
  cma: CmaClient,
  stationId: string,
  signal?: AbortSignal,
): Promise<CmaView> {
  const key = envCacheKey("cma-view", [stationId]);
  return withEnvCache(key, ENV_TTL.weatherObservation, () => cma.view(stationId, signal)).then(
    (r) => r.value,
  );
}

async function fetchCmaViews(
  cma: CmaClient,
  points: WeatherArgs["points"],
  signal?: AbortSignal,
): Promise<Array<{ view: CmaView; distanceKm: number } | undefined>> {
  const nearest = await Promise.all(
    points.map((p) => cma.nearestStation({ lat: p.lat, lon: p.lon }, signal).catch(() => undefined)),
  );

  const byStation = new Map<string, Promise<CmaView | undefined>>();
  for (const n of nearest) {
    if (!n || byStation.has(n.station.id)) continue;
    byStation.set(
      n.station.id,
      // 单个站点取不到不该拖垮整条路线——增强层失败只是少几个字段。
      cachedCmaView(cma, n.station.id, signal).catch(() => undefined),
    );
  }
  const resolved = new Map<string, CmaView | undefined>();
  for (const [id, p] of byStation) resolved.set(id, await p);

  return nearest.map((n) => {
    if (!n) return undefined;
    const view = resolved.get(n.station.id);
    return view ? { view, distanceKm: n.distanceKm } : undefined;
  });
}

/** 把 CMA 的实况与预警合并进一段结果。基础字段不覆盖，只补空。 */
function enrichWithCma(
  seg: WeatherSegment,
  hit: { view: CmaView; distanceKm: number } | undefined,
  date: string,
  isToday: boolean,
): WeatherSegment {
  const sources = [...(seg.sources ?? [])];
  const unavailable = [...(seg.unavailable ?? [])];

  if (!hit) {
    unavailable.push(
      `observed/alarms：该取样点 100km 内没有气象局观测站，或该站取数失败`,
      ...CMA_LIMITS.UNAVAILABLE,
    );
    return { ...seg, observed: null, alarms: [], sources, unavailable };
  }

  const { view, distanceKm } = hit;

  // 基础字段**只补空、不覆盖**：高德/Open-Meteo 已经给了的就用它们的，
  // 保持"基础预报由谁出"这件事稳定，否则同一次调用里字段来源会互相打架。
  const cmaDay = view.daily.find((d) => d.date === date);
  const merged: WeatherSegment = { ...seg };
  if (cmaDay) {
    if (merged.tempMaxC === null || merged.tempMaxC === undefined) merged.tempMaxC = cmaDay.highC;
    if (merged.tempMinC === null || merged.tempMinC === undefined) merged.tempMinC = cmaDay.lowC;
    if (!merged.condition) merged.condition = cmaDay.dayText || null;
    if (!merged.windPower) merged.windPower = cmaDay.dayWindScale || null;
    if (!sources.includes("cma:forecast") && !seg.sources?.length) sources.push("cma:forecast");
  }

  // 实况**只在今天**填（文件头约定 1）。
  if (isToday) {
    merged.observed = {
      station: view.station.name,
      stationDistanceKm: distanceKm,
      observedAt: view.lastUpdate,
      ...view.observation,
    };
    sources.push("cma:observed");
  } else {
    merged.observed = null;
    unavailable.push(
      `observed：气象局的体感/湿度/降水/气压/风是**此刻的实况**，不适用于 ${date}`,
    );
  }

  merged.alarms = view.alarms.map(toAlarm);
  sources.push("cma:alarm");

  // 紫外线/能见度/降雪：Open-Meteo 那一路有，高德+CMA 这一路没有。
  if (merged.uvIndexMax === undefined || merged.uvIndexMax === null) {
    merged.uvIndexMax = null;
    unavailable.push(CMA_LIMITS.UNAVAILABLE[0]);
  }
  if (merged.visibilityKm === undefined || merged.visibilityKm === null) {
    merged.visibilityKm = null;
    unavailable.push(CMA_LIMITS.UNAVAILABLE[1]);
  }
  if (merged.snowfallCm === undefined || merged.snowfallCm === null) {
    merged.snowfallCm = null;
    unavailable.push(CMA_LIMITS.UNAVAILABLE[2]);
  }

  return { ...merged, sources, unavailable };
}

function toAlarm(a: CmaAlarm): WeatherAlarm {
  return { title: a.title, type: a.type, level: a.level, severity: a.severity, effective: a.effective };
}

/** 纯用 CMA 出基础预报——高德窗口外（第 5~7 天）走这条。 */
function baseFromCma(
  points: WeatherArgs["points"],
  hits: Array<{ view: CmaView; distanceKm: number } | undefined>,
  date: string,
): WeatherSegment[] {
  return points.map((p, i) => {
    const hit = hits[i];
    const day = hit?.view.daily.find((d) => d.date === date);
    return {
      name: p.name,
      date,
      tempMinC: day?.lowC ?? null,
      tempMaxC: day?.highC ?? null,
      precipitationMm: null,
      weatherCode: null,
      condition: day?.dayText || null,
      windPower: day?.dayWindScale || null,
      city: hit?.view.station.name ?? null,
      sources: day ? ["cma:forecast"] : [],
      unavailable: day ? [] : [`该取样点在 ${date} 没有可用预报`],
    } satisfies WeatherSegment;
  });
}

// ── 窗口判定 ─────────────────────────────────────────────────

function daysFromToday(date: string): number {
  const target = Date.parse(`${date}T00:00:00+08:00`);
  const base = Date.parse(`${today()}T00:00:00+08:00`);
  if (!Number.isFinite(target)) {
    throw new ToolError("weather", "invalid", `日期不可读：${date}`, false);
  }
  return Math.round((target - base) / 86_400_000);
}

function today(): string {
  // 与高德/气象局同一时区口径（北京时间），否则跨零点前后会差一天。
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export const weatherTool: ExternalTool<WeatherArgs, WeatherSegment[]> = defineExternalTool({
  name: "weather",
  // 供应商按调用时的装配状态解析。基础预报是谁就标谁；逐字段来源见 `sources`。
  provider: () => (getAmapClient() ? "amap" : "open-meteo"),
  sensitive: false,
  // 增强层多打一跳，超时相应放宽。
  timeoutMs: 8_000,
  retries: 2,

  real: async (args, ctx) => {
    if (args.points.length === 0) {
      throw new ToolError("weather", "invalid", "points 不能为空", false);
    }
    const date = args.date ?? today();
    const amap = getAmapClient();
    const cma = getCmaClient();

    // 没有高德就走 Open-Meteo 那一路（无 key 兜底，字段本来就全）。
    if (!amap) {
      // 沿途多点是**工具内并发**（一个 Agent 自己并行调），不是跨 Agent 协作（§11 注）。
      const base = await Promise.all(args.points.map((p) => fetchOne(p, date, ctx.signal)));
      if (!cma) return base;
      // Open-Meteo 已有紫外线/能见度/降雪，CMA 只补实况与预警。
      const hits = await fetchCmaViews(cma, args.points, ctx.signal).catch(() => []);
      return base.map((seg, i) =>
        enrichWithCma(seg, hits[i], date, daysFromToday(date) === 0),
      );
    }

    const offset = daysFromToday(date);
    const inAmapWindow = offset >= 0 && offset < AMAP_FORECAST_DAYS;
    const inCmaWindow = offset >= 0 && offset < CMA_FORECAST_DAYS;

    if (!inAmapWindow && !(cma && inCmaWindow)) {
      throw new ToolError(
        "weather",
        "invalid",
        `查不到 ${date} 的天气：高德预报覆盖今天起 ${AMAP_FORECAST_DAYS} 天` +
          `（至 ${addDays(today(), AMAP_FORECAST_DAYS - 1)}）` +
          (cma
            ? `，中国气象局覆盖 ${CMA_FORECAST_DAYS} 天（至 ${addDays(today(), CMA_FORECAST_DAYS - 1)}）`
            : "，中国气象局未接入") +
          "。**不要据此推测那天的天气**",
        false,
      );
    }

    const hits = cma
      ? await fetchCmaViews(cma, args.points, ctx.signal).catch(() => [])
      : [];

    // 高德窗口内用高德出基础预报；窗口外（第 5~7 天）改由气象局出。
    const base = inAmapWindow
      ? await fetchAllViaAmap(amap, args.points, date, ctx.signal)
      : baseFromCma(args.points, hits, date);

    if (!cma) return base;
    return base.map((seg, i) => enrichWithCma(seg, hits[i], date, offset === 0));
  },

  // mock 的数据要"看起来像但一眼能认出是假的"：固定值 + 由 source.kind=mock 标注。
  mock: (args) =>
    args.points.map((p) => ({
      name: p.name,
      date: args.date ?? today(),
      tempMinC: 3,
      tempMaxC: 11,
      precipitationMm: 0,
      weatherCode: 1,
      condition: "多云",
      windPower: "1-3",
      city: null,
      uvIndexMax: 3,
      visibilityKm: 20,
      snowfallCm: 0,
      observed: null,
      alarms: [],
      sources: ["mock"],
      unavailable: [],
    })),
});
