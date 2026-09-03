/**
 * ⑤环境缓存详情的**纯函数**（M-mem-cache-detail）：键解析与人话格式化。
 *
 * 单独成文件是为了能在 node:test 里直接跑——渲染层（`env-cache-detail.tsx`）
 * 只管把这些字符串摆到位置上。任何"数字怎么读"的规则都在这里，
 * 别在 JSX 里现拼（拼出来的字面量没人测，写错了只在页面上看得见）。
 */

/** 命名空间 → 人话。表里没有的原样显示——**不猜**，那多半是新接的一类缓存。 */
export const NS_LABEL: Record<string, string> = {
  regeo: "逆地理编码（坐标→行政区）",
  "amap-forecast": "天气预报（高德）",
  "cma-view": "实况与预警（气象局）",
  route: "路线规划",
  charging: "充电站搜索",
  "guide-brief": "景区导览简报",
  "dest-highlights": "目的地推荐",
};

export function nsLabel(ns: string): string {
  return NS_LABEL[ns] ?? ns;
}

const KEY_PREFIX = "carlife:env:";

/** 把键拆成命名空间与各段。`carlife:env:regeo:23.18:113.3` → `{ ns:"regeo", parts:["23.18","113.3"] }`。 */
export function splitKey(key: string): { ns: string; parts: string[] } | undefined {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  const [ns, ...parts] = key.slice(KEY_PREFIX.length).split(":");
  if (!ns) return undefined;
  return { ns, parts };
}

export interface LatLon {
  lat: number;
  lon: number;
}

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** 逆地理键 `regeo:<lat>:<lon>`。坐标是服务端取整到 0.01° 之后的值。 */
export function regeoKeyToPoint(key: string): LatLon | undefined {
  const k = splitKey(key);
  if (!k || k.ns !== "regeo") return undefined;
  const lat = num(k.parts[0]);
  const lon = num(k.parts[1]);
  return lat !== undefined && lon !== undefined ? { lat, lon } : undefined;
}

/** 路线键 `route:<olat>:<olon>:<dlat>:<dlon>:<wp|->:<strategy>`。 */
export function routeKeyToEnds(
  key: string,
): { origin: LatLon; destination: LatLon; waypoints: LatLon[]; strategy: string } | undefined {
  const k = splitKey(key);
  if (!k || k.ns !== "route") return undefined;
  const [a, b, c, d, wp, strategy] = k.parts;
  const olat = num(a);
  const olon = num(b);
  const dlat = num(c);
  const dlon = num(d);
  if (olat === undefined || olon === undefined || dlat === undefined || dlon === undefined) return undefined;
  const waypoints: LatLon[] = [];
  if (wp && wp !== "-") {
    for (const seg of wp.split("|")) {
      const [x, y] = seg.split(",");
      const lat = num(x);
      const lon = num(y);
      if (lat !== undefined && lon !== undefined) waypoints.push({ lat, lon });
    }
  }
  return { origin: { lat: olat, lon: olon }, destination: { lat: dlat, lon: dlon }, waypoints, strategy: strategy ?? "default" };
}

/** 充电站键 `charging:<lat>:<lon>:<radiusM>`。 */
export function chargingKeyToCenter(key: string): { center: LatLon; radiusM: number } | undefined {
  const k = splitKey(key);
  if (!k || k.ns !== "charging") return undefined;
  const lat = num(k.parts[0]);
  const lon = num(k.parts[1]);
  const radiusM = num(k.parts[2]);
  if (lat === undefined || lon === undefined || radiusM === undefined) return undefined;
  return { center: { lat, lon }, radiusM };
}

/** `23.18, 113.3` → `23.18°N, 113.30°E`（南纬西经按符号翻）。 */
export function coordText(p: LatLon): string {
  const lat = `${Math.abs(p.lat).toFixed(2)}°${p.lat >= 0 ? "N" : "S"}`;
  const lon = `${Math.abs(p.lon).toFixed(2)}°${p.lon >= 0 ? "E" : "W"}`;
  return `${lat}, ${lon}`;
}

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * `2026-09-03` → `9月3日 周四`；给了 `today` 时今天/明天/后天另说。
 * 解析按本地日期拆字段，不走 `Date.parse`——后者把无时区的日期当 UTC，东八区会差一天。
 */
export function dateLabel(iso: string, today?: Date): string {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const base = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY[d.getDay()]}`;
  if (!today) return base;
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const diff = Math.round((d.getTime() - t0) / 86_400_000);
  const rel = diff === 0 ? "今天" : diff === 1 ? "明天" : diff === 2 ? "后天" : undefined;
  return rel ? `${rel} · ${base}` : base;
}

/** 白天/夜间天气合成一句：同一种就说一次。 */
export function weatherText(day: string, night: string): string {
  if (!day && !night) return "—";
  if (!night || night === day) return day;
  if (!day) return night;
  return `${day}转${night}`;
}

/** 夜间低温 ~ 白天高温。缺一边就只说有的那边，**不补零**。 */
export function tempRangeText(dayC: number | null | undefined, nightC: number | null | undefined): string {
  const d = dayC ?? undefined;
  const n = nightC ?? undefined;
  if (d === undefined && n === undefined) return "—";
  if (d === undefined) return `夜间 ${n}℃`;
  if (n === undefined) return `白天 ${d}℃`;
  return `${Math.min(d, n)} ~ ${Math.max(d, n)}℃`;
}

/** 高德的 `dayWind` 是方向、`dayPower` 是风力档（"1-3"、"≤3"）。 */
export function windText(direction: string | null | undefined, power: string | null | undefined): string {
  const dir = direction?.trim();
  const pw = power?.trim();
  if (!dir && !pw) return "—";
  const dirText = dir ? (dir.endsWith("风") ? dir : `${dir}风`) : "";
  const pwText = pw ? (pw.endsWith("级") ? pw : `${pw}级`) : "";
  return [dirText, pwText].filter(Boolean).join(" ");
}

/** 米 → 人话。**估算口径的距离由调用方自己加"估算"**，这里只管单位。 */
export function distanceText(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return "—";
  if (m < 1000) return `${Math.round(m)} 米`;
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} 公里`;
}

/** 秒 → `1 小时 5 分` / `25 分钟`。 */
export function durationText(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "—";
  const min = Math.round(s / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

/** 出处的主机名（`https://tw.trip.com/moments/...` → `tw.trip.com`），解析不了就原样。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** ISO 时间 → 本地 `2026/9/2 20:31`。 */
export function timeText(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** 导览三分支的通道 → 人话（与契约 `GuideBranchSource` 对应）。 */
export const BRANCH_SOURCE_LABEL: Record<string, string> = {
  submission: "结构化提交",
  text: "从正文回落解析",
  missing: "缺席（本次没查到）",
};

export const BRANCH_LABEL: Record<string, string> = {
  access: "到达与停车",
  spots: "必玩点",
  comfort: "休憩",
};
