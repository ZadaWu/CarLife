/**
 * ⑤环境缓存列表行的**人话摘要**（M-mem-cache-detail 走查②）。
 *
 * 列表行此前给的是值的前 200 个字符——那是一段被截断的 JSON，用户的原话：
 * "你看看你现在展示的啥啊，可读性太低了"。列表要回答的是"这一条是什么、里面大概有什么"，
 * 所以按命名空间各压成一行标题 + 一句摘要，在服务端算（这里握着完整值），
 * 控制台只管摆。不认识的命名空间给键名当标题、值的前几个字段当摘要——仍然不是 JSON。
 *
 * 纯函数、不抛：任何一条坏了都只影响它自己那一行。
 */

import { KEY_PREFIX } from "./env-cache";

export interface EnvCacheDescription {
  /** 一行标题：`天气预报 · 云龙区` / `导览简报 · 灵隐寺（杭州）`。 */
  title: string;
  /** 一句摘要，给列表行看的；长度由这里兜住（不靠前端截）。 */
  summary: string;
}

const SUMMARY_MAX = 140;

function clip(s: string): string {
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;
}

function splitKey(key: string): { ns: string; parts: string[] } {
  const rest = key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : key;
  const [ns = "", ...parts] = rest.split(":");
  return { ns, parts };
}

const num = (s: string | undefined): number | undefined => {
  const n = Number(s);
  return s !== undefined && s !== "" && Number.isFinite(n) ? n : undefined;
};

function coord(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** `2026-09-03` → `9/3 周四`；不走 Date.parse（无时区日期会被当 UTC）。 */
function shortDate(iso: string): string {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${d.getMonth() + 1}/${d.getDate()} ${WEEKDAY[d.getDay()]}`;
}

function weather(day: string | undefined, night: string | undefined): string {
  if (!day && !night) return "";
  if (!night || night === day) return day ?? "";
  if (!day) return night;
  return `${day}转${night}`;
}

function temps(a: number | null | undefined, b: number | null | undefined): string {
  const x = a ?? undefined;
  const y = b ?? undefined;
  if (x === undefined && y === undefined) return "";
  if (x === undefined) return `${y}℃`;
  if (y === undefined) return `${x}℃`;
  return `${Math.min(x, y)}~${Math.max(x, y)}℃`;
}

function km(m: number | undefined): string {
  if (m === undefined || !Number.isFinite(m)) return "";
  return m < 1000 ? `${Math.round(m)} 米` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} 公里`;
}

function minutes(s: number | undefined): string {
  if (s === undefined || !Number.isFinite(s)) return "";
  const min = Math.round(s / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}

const names = (xs: unknown, n: number): string =>
  (Array.isArray(xs) ? xs : [])
    .map((x) => (x && typeof x === "object" ? (x as { name?: unknown }).name : undefined))
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .slice(0, n)
    .join("、");

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * 通用兜底：拿值的前几个标量字段拼成 `字段 值 · 字段 值`。**仍不是 JSON**——
 * 没有引号、花括号，只是"这条里有什么"的一眼概览。
 */
function genericSummary(v: unknown): string {
  if (Array.isArray(v)) return `${v.length} 项` + (names(v, 3) ? `：${names(v, 3)}` : "");
  const o = obj(v);
  const bits: string[] = [];
  for (const [k, x] of Object.entries(o)) {
    if (bits.length >= 4) break;
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") bits.push(`${k} ${String(x)}`);
    else if (Array.isArray(x)) bits.push(`${k} ${x.length} 项`);
  }
  return bits.join(" · ");
}

export function describeEnvCacheEntry(key: string, raw: string | null): EnvCacheDescription {
  const { ns, parts } = splitKey(key);
  let v: unknown = raw;
  if (raw !== null) {
    try {
      v = JSON.parse(raw);
    } catch {
      return { title: key, summary: clip(String(raw)) };
    }
  }
  if (raw === null) return { title: key, summary: "（读取时已过期）" };

  try {
    switch (ns) {
      case "regeo": {
        const o = obj(v);
        const lat = num(parts[0]);
        const lon = num(parts[1]);
        const where = [str(o.city), str(o.district)].filter(Boolean).join(" · ");
        return {
          title: `逆地理 · ${where || "未知行政区"}`,
          summary: clip(
            [str(o.formatted), lat !== undefined && lon !== undefined ? `查询坐标 ${coord(lat, lon)}` : ""]
              .filter(Boolean)
              .join(" · "),
          ),
        };
      }
      case "amap-forecast": {
        const o = obj(v);
        const casts = Array.isArray(o.casts) ? (o.casts as Obj[]) : [];
        const days = casts.slice(0, 3).map((c) => {
          const w = weather(str(c.dayWeather), str(c.nightWeather));
          const t = temps(c.dayTempC as number | null, c.nightTempC as number | null);
          return `${shortDate(str(c.date) ?? "")} ${[w, t].filter(Boolean).join(" ")}`.trim();
        });
        return {
          title: `天气预报 · ${str(o.city) ?? `adcode ${parts[0] ?? "?"}`}`,
          summary: clip(days.join("；") || "没有预报数据"),
        };
      }
      case "cma-view": {
        const o = obj(v);
        const st = obj(o.station);
        const ob = obj(o.observation);
        const alarms = Array.isArray(o.alarms) ? (o.alarms as Obj[]) : [];
        const bits = [
          ob.temperatureC != null ? `实况 ${ob.temperatureC}℃` : "",
          ob.humidityPct != null ? `湿度 ${ob.humidityPct}%` : "",
          [str(ob.windDirection), str(ob.windScale)].filter(Boolean).join(""),
          alarms.length ? `预警：${alarms.map((a) => `${str(a.type) ?? ""}${str(a.level) ?? ""}`).join("、")}` : "",
          str(o.lastUpdate) ? `观测 ${str(o.lastUpdate)}` : "",
        ].filter(Boolean);
        return { title: `气象局实况 · ${str(st.name) ?? `站 ${parts[0] ?? "?"}`}`, summary: clip(bits.join(" · ")) };
      }
      case "guide-brief": {
        const o = obj(v);
        const access = obj(o.access);
        const spots = Array.isArray(o.spots) ? o.spots : [];
        const comfort = Array.isArray(o.comfort) ? o.comfort : [];
        const parking = Array.isArray(access.parking) ? access.parking : [];
        const caveats = Array.isArray(o.caveats) ? o.caveats : [];
        const bits = [
          spots.length ? `必玩点 ${spots.length}：${names(spots, 4)}` : "没有必玩点",
          parking.length ? `停车场 ${parking.length}` : "",
          comfort.length ? `休憩 ${comfort.length}` : "",
          caveats.length ? `缺口 ${caveats.length}` : "",
        ].filter(Boolean);
        const city = str(o.city) ?? (parts[0] && parts[0] !== "-" ? parts[0] : undefined);
        return {
          title: `导览简报 · ${str(o.spot) ?? parts[1] ?? "?"}${city ? `（${city}）` : ""}`,
          summary: clip(bits.join(" · ")),
        };
      }
      case "dest-highlights": {
        const o = obj(v);
        const foods = names(o.foods, 3);
        const spots = names(o.spots, 3);
        const date = parts[1] && parts[1] !== "-" ? ` · ${shortDate(parts[1])}出发` : "";
        return {
          title: `目的地推荐 · ${str(o.destination) ?? parts[0] ?? "?"}${date}`,
          summary: clip([foods ? `吃：${foods}` : "", spots ? `逛：${spots}` : ""].filter(Boolean).join(" · ") || "三节都是空的"),
        };
      }
      case "route": {
        const o = obj(v);
        const steps = Array.isArray(o.steps) ? o.steps.length : 0;
        const bits = [
          km(o.distanceM as number | undefined),
          minutes(o.durationS as number | undefined),
          typeof o.tollYuan === "number" && o.tollYuan > 0 ? `过路费 ${o.tollYuan} 元` : "",
          typeof o.trafficLights === "number" ? `红绿灯 ${o.trafficLights}` : "",
          steps ? `${steps} 段` : "",
        ].filter(Boolean);
        const olat = num(parts[0]);
        const olon = num(parts[1]);
        const dlat = num(parts[2]);
        const dlon = num(parts[3]);
        const ends =
          olat !== undefined && olon !== undefined && dlat !== undefined && dlon !== undefined
            ? `${coord(olat, olon)} → ${coord(dlat, dlon)}`
            : "";
        return { title: `路线 · ${ends || "起终点未知"}`, summary: clip(bits.join(" · ")) };
      }
      case "charging": {
        const list = Array.isArray(v) ? v : [];
        const lat = num(parts[0]);
        const lon = num(parts[1]);
        const r = num(parts[2]);
        return {
          title: `充电站 · ${lat !== undefined && lon !== undefined ? coord(lat, lon) : "?"}${r ? ` 半径 ${km(r)}` : ""}`,
          summary: clip(list.length ? `${list.length} 个：${names(list, 3)}` : "范围内没有充电站"),
        };
      }
      default:
        return { title: key, summary: clip(genericSummary(v)) };
    }
  } catch {
    return { title: key, summary: clip(genericSummary(v)) };
  }
}
