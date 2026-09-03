/**
 * ⑤环境缓存（施工单 M11-04，§7⑤）。
 *
 * # 它是缓存，不是记忆
 *
 * §7 把⑤单列一类，但明确说了"严格说非记忆，不参与 re-rank"。
 * 所以它**不进 Mem0、不参与衰减**——放错地方的后果不是慢，
 * 是天气预报会跟着记忆一起被"访问强化"，越查越不容易过期。
 *
 * # 为什么不加在四件套的公共层
 *
 * 公共层会诱导"给所有工具一个统一 TTL"，而各工具的数据变化速度差着数量级：
 * 天气预报按小时更新，实时路况按分钟变。一个统一 TTL 必然要么让天气白查、
 * 要么让路线给出过期路况——**后者比不缓存更糟**，因为它带着"刚查的"的可信度。
 *
 * 所以缓存由各工具**显式接入**，TTL 各自定，且每个 TTL 都要在调用处写明依据。
 *
 * # 缓存不可用时直连，不失败
 *
 * Redis 挂了只是慢，不该让出行规划整个失败。但降级要**计数上报**——
 * 静默降级的话，"缓存一直没生效"这件事没有任何人会发现。
 */

import { describeEnvCacheEntry } from "./env-cache-summary";

export interface EnvCacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /**
   * 后端里现存多少条（可选）。
   *
   * `CacheStats.keys` 是**本进程写过几次**的内存计数器，进程一重启就归零，
   * 而缓存还在——开发下 `tsx watch` 每次热重载都清零，控制台上那张卡于是
   * 长期显示 0，看起来像"缓存里什么都没有"（实测那会儿 Redis 里有 75 条）。
   * 这个方法回答的是另一个问题：**此刻库里有多少**。
   *
   * 后端给不出就不实现——调用方按 `undefined` 处理，**不许拿 0 顶替**。
   */
  size?(): Promise<number>;
  /**
   * 分页列出库里现存的条目（控制台的⑤浏览用）。
   *
   * 后端给不出就不实现——调用方按 `undefined` 处理，**不许拿空列表顶替**：
   * 空列表会被读成"缓存里什么都没有"，而那正是这一类此前在页面上被误解的方式。
   */
  list?(opts: EnvCacheListOptions): Promise<EnvCacheListing>;
  /**
   * 取一条的**完整值**与剩余 TTL（控制台点开条目看详情用，M-mem-cache-detail）。
   *
   * 与 `get` 分开：`get` 是读穿路径用的，只要值；这里要连 TTL 一起拿，
   * 而且**不许续期**——看一眼不该让这条多活一秒。后端给不出就不实现，
   * 调用方按 `undefined` 处理。
   */
  entry?(key: string): Promise<{ value: string; ttlSeconds: number } | null>;
}

export interface EnvCacheListOptions {
  offset: number;
  limit: number;
  /** 只看某个命名空间（`regeo` / `amap-forecast` / `route` …）。不给即全部。 */
  namespace?: string;
}

export interface EnvCacheEntry {
  key: string;
  namespace: string;
  /**
   * 剩余存活秒数。
   *
   * `-1` = 这个键**没有 TTL**。⑤的每一条都该有，出现 -1 就是有人绕过
   * `withEnvCache` 直接写了 Redis——那种键永远不过期，会一直拿过期数据回答。
   * 页面据此点名，不要静默当成"很久以后过期"。
   */
  ttlSeconds: number;
  sizeBytes: number;
  /** 值的截断预览。**不是完整值**——一条路线规划的 JSON 有几十 KB。排障用；列表行不再显示它。 */
  preview: string;
  /** 人话标题与摘要（`describeEnvCacheEntry`）：列表行显示的是这两样，不是 JSON。 */
  title: string;
  summary: string;
}

export interface EnvCacheListing {
  entries: EnvCacheEntry[];
  /** 匹配（含命名空间过滤）的总条数——分页器要靠它算总页数。 */
  total: number;
  /** 未过滤时库里的总条数。 */
  totalAll: number;
  /**
   * 扫描是否撞到上限。
   *
   * **撞了就必须说**：截断之后的 `total` 不是"全部有多少"，
   * 而静默截断读起来和"全都在这儿了"一模一样。
   */
  truncated: boolean;
  /** 各命名空间的条数分布（过滤前）。给页面做筛选项，也回答"缓存里都是些什么"。 */
  namespaces: Array<{ namespace: string; count: number }>;
}

/** 预览截断长度。够看清"存的是不是我想的那种东西"，又不至于把一整份路线塞进页面。 */
export const PREVIEW_CHARS = 200;

/**
 * 一次列举最多扫多少个键。
 *
 * 上限存在的理由是别让一次页面请求扫穿一台生产 Redis；
 * 撞上限时 `truncated` 为真，由调用方明说，不静默。
 */
export const SCAN_CAP = 5000;

/**
 * 从键上取命名空间：`carlife:env:<namespace>:<parts...>`。
 *
 * 拿不到（键不符合本模块的构造规则）时归到 `其他`——那种键是别处直接写进来的，
 * 归成一个已知命名空间会把它藏起来。
 */
export function namespaceOf(key: string): string {
  if (!key.startsWith(KEY_PREFIX)) return "其他";
  const rest = key.slice(KEY_PREFIX.length);
  const i = rest.indexOf(":");
  return i > 0 ? rest.slice(0, i) : "其他";
}

/**
 * 把一批键切成一页并配上分布统计（纯函数，供单测）。
 *
 * **排序是必须的，不是整洁**：Redis 的 SCAN 不保证跨调用的顺序稳定，
 * 不排序的话第 2 页可能重复第 1 页的条目、也可能整条跳过——
 * 而分页器看起来一切正常。
 */
export function paginateKeys(
  allKeys: readonly string[],
  opts: EnvCacheListOptions,
): { page: string[]; total: number; totalAll: number; namespaces: EnvCacheListing["namespaces"] } {
  const counts = new Map<string, number>();
  for (const k of allKeys) {
    const ns = namespaceOf(k);
    counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }
  const namespaces = [...counts.entries()]
    .map(([namespace, count]) => ({ namespace, count }))
    .sort((a, b) => b.count - a.count || a.namespace.localeCompare(b.namespace));

  const filtered = opts.namespace
    ? allKeys.filter((k) => namespaceOf(k) === opts.namespace)
    : [...allKeys];
  filtered.sort();

  const offset = Math.max(0, opts.offset);
  return {
    page: filtered.slice(offset, offset + Math.max(1, opts.limit)),
    total: filtered.length,
    totalAll: allKeys.length,
    namespaces,
  };
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** 后端不可用而直连的次数。**不静默**——它是"缓存没生效"的唯一信号。 */
  degraded: number;
  keys: number;
}

const stats: CacheStats = { hits: 0, misses: 0, degraded: 0, keys: 0 };
let backend: EnvCacheBackend | undefined;

/** 装配层注入。未注入即不缓存——不是报错。 */
export function setEnvCache(b: EnvCacheBackend | undefined): void {
  backend = b;
}
export function getEnvCacheStats(): CacheStats {
  return { ...stats };
}

/**
 * 列出库里现存的⑤条目（控制台用）。
 *
 * 未接入后端、或后端列不了，一律返回 `undefined`——**不是空列表**。
 * 调用方据此说"数不到"，而不是说"缓存是空的"（见 `EnvCacheBackend.list` 的注释）。
 */
export async function listEnvCache(opts: EnvCacheListOptions): Promise<EnvCacheListing | undefined> {
  if (!backend?.list) return undefined;
  return backend.list(opts);
}
/** 单条详情（控制台弹窗用）。`value` 是解析后的 JSON；解析不了就原样给字符串。 */
export interface EnvCacheDetail {
  key: string;
  namespace: string;
  ttlSeconds: number;
  sizeBytes: number;
  value: unknown;
}

/**
 * 取一条的完整值（控制台点开条目看详情，M-mem-cache-detail）。
 *
 * 三种"没有"照旧分开：未接入 / 后端不支持 → `undefined`；键不存在或已过期 → `null`。
 * 列表那边的 `preview` 只有 200 字符，一份导览简报有十几 KB——详情必须另取，
 * 而不是把列表的预览放长：列表一页 20 条，每条都带全值等于每翻一页搬 200 KB。
 */
export async function getEnvCacheEntry(key: string): Promise<EnvCacheDetail | null | undefined> {
  if (!backend?.entry) return undefined;
  const hit = await backend.entry(key);
  if (!hit) return null;
  let value: unknown = hit.value;
  try {
    value = JSON.parse(hit.value);
  } catch {
    /* 不是 JSON 的键是别处直接写的，原样给出——与 `-1` TTL 同一类"要点名"的异常 */
  }
  return {
    key,
    namespace: namespaceOf(key),
    ttlSeconds: hit.ttlSeconds,
    sizeBytes: Buffer.byteLength(hit.value, "utf8"),
    value,
  };
}

/** 逆地理条目反查出来的一个点：坐标来自键，行政区来自值。 */
export interface RegeoPoint {
  lat: number;
  lon: number;
  district: string;
  formatted: string;
}

/** `carlife:env:regeo:<lat>:<lon>` → 坐标。键不合规则时给 `undefined`。 */
export function regeoKeyToPoint(key: string): { lat: number; lon: number } | undefined {
  const rest = key.startsWith(`${KEY_PREFIX}regeo:`) ? key.slice(`${KEY_PREFIX}regeo:`.length) : "";
  const [a, b] = rest.split(":");
  const lat = Number(a);
  const lon = Number(b);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  return { lat, lon };
}

/** 反查时最多读多少条逆地理条目。控制台点一次弹窗读几百个小键可以接受，读穿一台库不行。 */
export const REGEO_LOOKUP_CAP = 500;

/**
 * 找出**解析到某个 adcode** 的全部逆地理点（天气详情在地图上定位用）。
 *
 * 天气预报按 adcode 存、值里没有坐标——它本身无处可画。但它之所以被查，
 * 是因为先有一次逆地理把某个坐标解析到了这个 adcode，而那条逆地理
 * 「键带坐标、值带 adcode」，两边一拼就是"这份预报是为哪些地方查的"。
 * 反查不到是正常的（逆地理 24 小时过期，预报只有 10 分钟，通常前者活得更久，但不保证），
 * 那就只给文字不给图——**不拿城市中心点冒充**。
 */
export async function regeoPointsForAdcode(adcode: string): Promise<RegeoPoint[] | undefined> {
  if (!backend?.list || !backend.get) return undefined;
  const listing = await backend.list({ offset: 0, limit: REGEO_LOOKUP_CAP, namespace: "regeo" });
  const out: RegeoPoint[] = [];
  for (const e of listing.entries) {
    const pt = regeoKeyToPoint(e.key);
    if (!pt) continue;
    try {
      // 预览里只有 200 字符，逆地理的值通常装得下，但"通常"不是判据——重新取全值。
      const raw = await backend.get(e.key);
      if (!raw) continue;
      const v = JSON.parse(raw) as { adcode?: string; district?: string; formatted?: string };
      if (v.adcode !== adcode) continue;
      out.push({ ...pt, district: v.district ?? "", formatted: v.formatted ?? "" });
    } catch {
      /* 单条坏了不影响其余 */
    }
  }
  return out;
}

/** 仅供测试。 */
export function resetEnvCacheStats(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.degraded = 0;
  stats.keys = 0;
}

/**
 * 坐标取整精度。
 *
 * 2 位小数 ≈ 1.1km。天气与沿线搜索在这个尺度上没有差别，
 * 而不取整会让每次微小的 GPS 抖动都变成一次 miss——缓存等于没做。
 */
export function roundCoord(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 缓存键。
 *
 * **不得含 userId / VIN / 会话 id**（§隐私）：⑤存的是外部世界的事实，
 * 与"谁在问"无关。带上用户维度既泄露隐私，又让命中率归零——
 * 同一个地点的天气对所有人是同一份。
 */
/** 所有环境缓存键的共同前缀。**键的构造与统计必须用同一个常量**——
    分两处写死时，改了构造而忘了统计，那边数出来的就永远是 0。 */
export const KEY_PREFIX = "carlife:env:";

export function envCacheKey(namespace: string, parts: Array<string | number>): string {
  return `${KEY_PREFIX}${namespace}:${parts.join(":")}`;
}

export interface CachedResult<T> {
  value: T;
  /** 本次是否来自缓存。进工具结果与轨迹——回放要能区分"刚查的"与"缓存的"。 */
  cached: boolean;
}

/**
 * 读穿缓存。
 *
 * `ttlSeconds` 由调用方给，**不设默认值**：一个默认 TTL 会被无脑复用到
 * 变化速度完全不同的数据上，而那正是本模块要避免的（见文件头）。
 */
export async function withEnvCache<T>(
  key: string,
  ttlSeconds: number,
  fetch: () => Promise<T>,
): Promise<CachedResult<T>> {
  if (!backend) {
    // 未接入不算降级：那是明确的部署选择，不是故障。
    return { value: await fetch(), cached: false };
  }

  try {
    const hit = await backend.get(key);
    if (hit !== null) {
      stats.hits += 1;
      return { value: JSON.parse(hit) as T, cached: true };
    }
    stats.misses += 1;
  } catch (err) {
    stats.degraded += 1;
    console.warn(`[env-cache] 读失败，直连：${key}`, err);
    return { value: await fetch(), cached: false };
  }

  const value = await fetch();
  try {
    await backend.set(key, JSON.stringify(value), ttlSeconds);
    stats.keys += 1;
  } catch (err) {
    // 写失败只影响下一次命中，本次结果照常返回。
    stats.degraded += 1;
    console.warn(`[env-cache] 写失败（本次结果不受影响）：${key}`, err);
  }
  return { value, cached: false };
}

/**
 * 各类环境数据的 TTL，**每一条都写明依据**。
 *
 * 拍一个数很容易，但 TTL 定错的后果是单向的：定长了给过期数据，
 * 而过期数据带着"刚查的"的可信度，比不缓存更糟。
 */
export const ENV_TTL = {
  /**
   * 天气预报：30 分钟。
   * 高德与中国气象局的预报本身按小时/半天更新，30 分钟内重复查必然拿到同一份。
   */
  weatherForecast: 30 * 60,
  /**
   * 实时观测：10 分钟。比预报短——它的价值就在"现在"。
   */
  weatherObservation: 10 * 60,
  /**
   * 路线规划：3 分钟。
   *
   * **刻意很短**：实时路况是它的价值所在，缓存久了等于给过期路况。
   * 但 3 分钟足以覆盖真正的浪费场景——实测一轮出行规划里
   * 同一条路线被调了两次（579ms + 508ms）。
   */
  route: 3 * 60,
  /**
   * 充电站搜索：1 小时。
   *
   * 站点位置、名称、功率基本不变，一小时内重复搜必然拿到同一批。
   * **这里不含价格与空闲桩数**——前者本仓没有数据源，后者是刻意不提供的
   * （`charging.ts` 文件头：排队情况恒为不可知，宁可说不知道也不给假数）。
   * 所以这一条比天气更适合缓存：存的全是静态属性，不存在"拿旧的实时数
   * 冒充现在"的风险。哪天真接了价格源，这个 TTL 要重新论证。
   */
  charging: 60 * 60,
  /**
   * 目的地推荐（美食榜 / 打卡点 / 拍照建议）：**2 周**（2026-09-02 从 24 小时改来）。
   *
   * 它与下面的导览简报是本表里仅有的两条**按周**的，理由是两头都极端：
   *  - 变化极慢：网红点与老字号是**周级**变化的内容，两周内重复查拿到的
   *    基本是同一份；24 小时时每天第一次点都要重跑一遍搜索，省下的只是当天的重复；
   *  - 单次极贵：一次调用 = 一次按次计费的联网搜索 + 约 19k input tokens
   *    （搜索结果全量进上下文），是本仓最贵的一次外部调用。
   *
   * 键按**目的地 + 出发日**（`destination-highlights.ts`），不按会话——
   * 同一个城市不同用户查到的东西没有区别，按会话缓存等于没缓存。
   * 端上的沿用闸 `HIGHLIGHTS_STICKY_MS`（`clients/shared/ui/src/hud/gateway-source.ts`）
   * 与这一条同值，改这里要一起改。
   */
  destinationHighlights: 14 * 24 * 60 * 60,
  /**
   * 景区导览简报（M36-01）：**2 周**（2026-09-02 从 24 小时改来），与目的地推荐同理由——
   * 内容周级变化（必玩点/停车场不会一天一换），而单次极贵：一次采集 =
   * 三个子代理并行，各带联网搜索（按次计费 + 约 19k tokens/次）与多次 POI 查询。
   * 键按**城市 + 景区名**（`subgraphs/guide.ts`），不按会话——同一景区谁点都一样。
   * 持久层（PG）读序在它之前，这条只在迁移期兜底与队列的"已采过"判定里起作用。
   */
  guideBrief: 14 * 24 * 60 * 60,
} as const;

/**
 * 造一个 Redis 后端。**连不上就返回 undefined**，由调用方决定怎么说——
 * 这里不抛错：缓存不可用只是慢，不是故障。
 *
 * 放在 `enterprise/backend/shared/tools` 而不是装配层：`redis` 是本包的依赖，
 * 让服务层去 import 它等于给服务层加一个它并不直接使用的依赖。
 */
export async function createRedisEnvCache(url: string): Promise<EnvCacheBackend | undefined> {
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url });
    client.on("error", (e: unknown) =>
      console.warn("[env-cache] Redis 连接异常（后续调用将直连上游）", e),
    );
    await client.connect();
    return {
      async get(key) {
        return (await client.get(key)) as string | null;
      },
      async set(key, value, ttlSeconds) {
        await client.set(key, value, { EX: ttlSeconds });
      },
      async entry(key) {
        const [raw, ttl] = await Promise.all([
          client.get(key) as Promise<string | null>,
          client.ttl(key) as Promise<number>,
        ]);
        // 取值与取 TTL 之间刚好过期：值为 null 就是没有，不拿 TTL 猜。
        if (raw === null) return null;
        return { value: raw, ttlSeconds: ttl };
      },
      /**
       * 分页列举。
       *
       * 三个都不显然的地方：
       *  1. **先扫全量键再排序切片**，不用 SCAN 游标当分页游标——游标是单向的，
       *     翻不回上一页，而且 SCAN 的顺序跨调用不稳定，会重复或漏掉条目；
       *  2. **只对本页的键取值与 TTL**，不是全量取——一次列举的成本因此与页大小
       *     成正比，而不是与库大小成正比；
       *  3. 取值与取 TTL 之间键可能刚好过期，`get` 返回 null。那不是错误，
       *     如实标成"已过期"，不假装还在。
       */
      async list({ offset, limit, namespace }) {
        const all: string[] = [];
        let cursor = 0;
        let truncated = false;
        do {
          const r = await client.scan(cursor, { MATCH: `${KEY_PREFIX}*`, COUNT: 500 });
          cursor = Number(r.cursor);
          all.push(...r.keys);
          if (all.length >= SCAN_CAP) {
            truncated = true;
            break;
          }
        } while (cursor !== 0);

        const { page, total, totalAll, namespaces } = paginateKeys(all, { offset, limit, namespace });
        const entries = await Promise.all(
          page.map(async (key): Promise<EnvCacheEntry> => {
            const [raw, ttl] = await Promise.all([
              client.get(key) as Promise<string | null>,
              client.ttl(key) as Promise<number>,
            ]);
            const { title, summary } = describeEnvCacheEntry(key, raw);
            return {
              key,
              namespace: namespaceOf(key),
              ttlSeconds: ttl,
              sizeBytes: raw ? Buffer.byteLength(raw, "utf8") : 0,
              preview: raw
                ? raw.slice(0, PREVIEW_CHARS) + (raw.length > PREVIEW_CHARS ? "…" : "")
                : "（读取时已过期）",
              title,
              summary,
            };
          }),
        );
        return { entries, total, totalAll, truncated, namespaces };
      },
      async size() {
        /*
         * 只数本前缀，不用 DBSIZE——那台 Redis 未必只给环境缓存用，
         * 把别人的键算进"⑤环境缓存有多少条"就是编数字。
         * SCAN 而不是 KEYS：KEYS 在大库上会阻塞整个 Redis。
         */
        let cursor = 0;
        let n = 0;
        do {
          const r = await client.scan(cursor, { MATCH: `${KEY_PREFIX}*`, COUNT: 500 });
          cursor = Number(r.cursor);
          n += r.keys.length;
        } while (cursor !== 0);
        return n;
      },
    };
  } catch (err) {
    console.warn(`[env-cache] Redis 连接失败（${url}）`, err);
    return undefined;
  }
}
