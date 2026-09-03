/**
 * 中国气象局公开接口客户端（施工单 M10-02）。
 *
 * 数据来源：`weather.cma.cn` —— 官方站点的**公开网页接口**（页面自己在调的那几个），
 * 无 key、大陆可达。它补的正是高德给不了的那几项：体感温度、湿度、降水实况、
 * 气压、风向角，外加**气象预警**与 7 天预报窗口。
 *
 * # 三件必须知道的事，否则用错
 *
 * 1. **站点匹配走坐标最近邻，不走 adcode。** 站点表里 97% 的站带 6 位 adcode，
 *    但高德 regeo 给的是**区级** adcode，命中率不可靠：`440304`(深圳福田) 能靠
 *    市级 `440300` 回退命中，而 `110101`(北京东城)→`110100`、`510107`(成都武侯)
 *    →`510100` **都不在表里**（实测）。adcode 只做快路径，主路径是 haversine。
 * 2. **一次 `view` 拿全**：`now` + `daily[7]` + `alarm[]` 同在一个响应里，
 *    不要为三件事发三次请求。
 * 3. **失败不在 HTTP 状态码里**（与高德同病）：正常是 `{code:0,msg:"success"}`，
 *    站点 id 不对时返回的是一个 **HTML 404 页**而不是 JSON。两种形态都要防——
 *    直接 `res.json()` 会抛一个看不出所以然的解析错。
 *
 * # 它给不了什么（**必须显式说出来**）
 *
 * 紫外线指数、能见度、降雪量。`precipitation` 是降水总量、不分雨雪，下雪只体现在
 * `dayText` 的文字里。这三项由调用方标进 `unavailable`——**字段缺失会被上层
 * 读成"今天紫外线为 0"**，那比没有更糟。
 */

import { haversineKm } from "./charging";
import { ToolError } from "./external";

export interface CmaStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** 6 位行政区划码；约 3% 的站点没有 */
  adcode?: string;
}

export interface CmaObservation {
  temperatureC: number | null;
  /** 体感温度——高德整条链路都没有这个数 */
  feelsLikeC: number | null;
  humidityPct: number | null;
  /** 实况降水（mm）。**不是当日预报累计**，两者不能混进同一个字段 */
  precipitationMm: number | null;
  pressureHpa: number | null;
  windDirection: string | null;
  windDirectionDeg: number | null;
  windSpeedMs: number | null;
  windScale: string | null;
}

export interface CmaDaily {
  /** YYYY-MM-DD（原始是 YYYY/MM/DD，这里统一成 ISO 形状） */
  date: string;
  highC: number | null;
  lowC: number | null;
  dayText: string;
  nightText: string;
  dayWindDirection: string;
  dayWindScale: string;
}

export interface CmaAlarm {
  title: string;
  /** 预警种类，如「暴雨」「高温」 */
  type: string;
  /** 信号等级，如「橙色」 */
  level: string;
  severity: string;
  effective: string;
}

export interface CmaView {
  station: CmaStation;
  observation: CmaObservation;
  /** 未来 7 天（含今天） */
  daily: CmaDaily[];
  alarms: CmaAlarm[];
  /** 观测时间，形如 2026/08/10 22:10 */
  lastUpdate: string;
}

export interface CmaClient {
  /** 全国站点表（进程内缓存，见 STATIONS_TTL_MS）。 */
  stations(signal?: AbortSignal): Promise<readonly CmaStation[]>;
  /**
   * 最近站点。**超过 MAX_STATION_KM 返回 undefined**——宁可说"这里没有可用站点"，
   * 也不要把两百公里外的天气说成这里的天气。
   */
  nearestStation(
    at: { lat: number; lon: number },
    signal?: AbortSignal,
  ): Promise<{ station: CmaStation; distanceKm: number } | undefined>;
  /** 实况 + 7 天预报 + 预警，一次拿全。 */
  view(stationId: string, signal?: AbortSignal): Promise<CmaView>;
}

const BASE = "https://weather.cma.cn";

/** 站点表半天不变，没必要每次查天气都拉 2440 行。 */
const STATIONS_TTL_MS = 6 * 3_600_000;

/**
 * 最近站点的距离上限。
 *
 * 100km 是"同一片天气"的粗略尺度：再远，气温和降水就可能完全是另一回事。
 * 国内 2440 个站在有人烟的地方基本都能落进这个半径；落不进的（无人区、海上）
 * 本来就该说"没有观测"。
 */
const MAX_STATION_KM = 100;

/** 站点表的行是**定长数组**，字段靠下标——实测下标含义如下，改版会挪位置。 */
const IDX = { id: 0, name: 1, country: 2, lat: 4, lon: 5, adcode: 17 } as const;

export interface CmaClientOptions {
  fetchImpl?: typeof fetch;
}

export function createCmaClient({ fetchImpl }: CmaClientOptions = {}): CmaClient {
  const doFetch = fetchImpl ?? fetch;

  let stationsCache: { at: number; value: readonly CmaStation[] } | undefined;
  let stationsInFlight: Promise<readonly CmaStation[]> | undefined;

  async function getJson(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await doFetch(new URL(path, BASE), {
      signal,
      // 不带 UA 时偶发被挡；这是公开网页接口，按浏览器的样子请求最稳。
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CarLife/1.0)" },
    });
    if (!res.ok) {
      throw new ToolError("cma", "upstream", `HTTP ${res.status}`, res.status >= 500);
    }

    // 站点 id 不对时返回的是 HTML 404 页而不是 JSON（约束 5）。
    // 直接 res.json() 会抛一个"Unexpected token <"，看不出是站点错了。
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ToolError(
        "cma",
        "upstream",
        `${path} 返回的不是 JSON（多半是站点 id 不存在，气象局会返回 HTML 404 页）`,
        false,
      );
    }

    const obj = body as { code?: number; msg?: string; data?: unknown };
    if (obj.code !== 0) {
      throw new ToolError("cma", "upstream", `${path} 失败 code=${obj.code} msg=${obj.msg}`, true);
    }
    return obj as Record<string, unknown>;
  }

  async function loadStations(signal?: AbortSignal): Promise<readonly CmaStation[]> {
    const fresh = stationsCache && Date.now() - stationsCache.at < STATIONS_TTL_MS;
    if (fresh) return stationsCache!.value;
    // 并发调用只拉一次。
    if (stationsInFlight) return stationsInFlight;

    stationsInFlight = (async () => {
      const body = await getJson("/api/map/weather/1", signal);
      const rows = ((body.data as { city?: unknown[] } | undefined)?.city ?? []) as unknown[][];
      const out: CmaStation[] = [];
      for (const row of rows) {
        const id = str(row[IDX.id]);
        const lat = num(row[IDX.lat]);
        const lon = num(row[IDX.lon]);
        if (!id || lat === null || lon === null) continue;
        const adcode = str(row[IDX.adcode]);
        out.push({
          id,
          name: str(row[IDX.name]),
          lat,
          lon,
          adcode: /^\d{6}$/.test(adcode) ? adcode : undefined,
        });
      }
      if (out.length === 0) {
        throw new ToolError("cma", "upstream", "站点表解析出 0 个站点（接口可能改版了）", false);
      }
      stationsCache = { at: Date.now(), value: out };
      return out;
    })().finally(() => {
      stationsInFlight = undefined;
    });

    return stationsInFlight;
  }

  return {
    stations: loadStations,

    async nearestStation(at, signal) {
      const all = await loadStations(signal);
      let best: CmaStation | undefined;
      let bestKm = Infinity;
      for (const s of all) {
        const km = haversineKm(at, s);
        if (km < bestKm) {
          bestKm = km;
          best = s;
        }
      }
      if (!best || bestKm > MAX_STATION_KM) return undefined;
      return { station: best, distanceKm: Math.round(bestKm * 10) / 10 };
    },

    async view(stationId, signal) {
      const body = await getJson(
        `/api/weather/view?stationid=${encodeURIComponent(stationId)}`,
        signal,
      );
      const data = (body.data ?? {}) as Record<string, unknown>;
      const loc = (data.location ?? {}) as Record<string, unknown>;
      const now = (data.now ?? {}) as Record<string, unknown>;

      return {
        station: {
          id: str(loc.id) || stationId,
          name: str(loc.name),
          lat: num(loc.latitude) ?? 0,
          lon: num(loc.longitude) ?? 0,
        },
        observation: {
          temperatureC: num(now.temperature),
          feelsLikeC: num(now.feelst),
          humidityPct: num(now.humidity),
          precipitationMm: num(now.precipitation),
          pressureHpa: num(now.pressure),
          windDirection: str(now.windDirection) || null,
          windDirectionDeg: num(now.windDirectionDegree),
          windSpeedMs: num(now.windSpeed),
          windScale: str(now.windScale) || null,
        },
        daily: ((data.daily ?? []) as Record<string, unknown>[]).map((d) => ({
          date: isoDate(str(d.date)),
          highC: num(d.high),
          lowC: num(d.low),
          dayText: str(d.dayText),
          nightText: str(d.nightText),
          dayWindDirection: str(d.dayWindDirection),
          dayWindScale: str(d.dayWindScale),
        })),
        alarms: ((data.alarm ?? []) as Record<string, unknown>[]).map((a) => ({
          title: str(a.title),
          type: str(a.signaltype),
          level: str(a.signallevel),
          severity: str(a.severity),
          effective: str(a.effective),
        })),
        lastUpdate: str(data.lastUpdate),
      };
    },
  };
}

// ── 注入点（与 setAmapClient / setRagClient 同形态）──────────────

let client: CmaClient | undefined;

/** 装配层注入。传 undefined 表示不启用（`CARLIFE_WEATHER_CMA=off` 或离线）。 */
export function setCmaClient(c: CmaClient | undefined): void {
  client = c;
}

export function getCmaClient(): CmaClient | undefined {
  return client;
}

// ── 小工具 ───────────────────────────────────────────────────

/** CMA 的日期是 `2026/08/10`，统一成 `2026-08-10` 好和入参比较。 */
function isoDate(s: string): string {
  return s.replace(/\//g, "-").slice(0, 10);
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export const CMA_LIMITS = {
  MAX_STATION_KM,
  STATIONS_TTL_MS,
  /** 该数据源结构性拿不到的字段——调用方据此填 `unavailable`，不要各写各的 */
  UNAVAILABLE: [
    "uvIndex：中国气象局公开接口不提供紫外线指数",
    "visibilityKm：中国气象局公开接口不提供能见度",
    "snowfall：precipitation 是降水总量、不分雨雪，无独立降雪量",
  ],
} as const;
