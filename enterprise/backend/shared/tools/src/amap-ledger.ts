/**
 * 高德 key 池的用量台账（M100-01）。
 *
 * # 它回答的问题
 *
 * 「这把 key 今天这一族接口用了多少」。高德**不开放余量查询**（财务页 `amapQuota` 的注释原话：
 * 配额信息请在控制台看），所以要规划一个 key 池，账只能我们自己记。记账的位置是 `amap.ts` 的
 * `get()`——所有高德请求的唯一出口——谁来都记，调用点不必知道有这回事（与 `wait-meter.ts` 同一形态）。
 *
 * # 三个维度，缺一个都规划不了
 *
 * - **按 key**：日配额是按 key 算的（2026-09-15 实测三把 key 各自约 450 次搜索后 10044）。
 *   台账里用 `sha1(key)` 前 8 位当指纹，不落明文——日志与后台页也只出指纹，重排 `_2` / `_3` 的顺序不丢账。
 * - **按接口族**：搜索、地理编码、算路、天气各是一份配额，一个总数没有意义。族按请求路径分（`amapFamilyOf`）。
 * - **按北京日**：高德的日界大概率是北京时间，而本机可能在任何时区（`session-row-no-echo` 那三条红就是这么来的）。
 *   `beijingDay` 只做 UTC+8 的算术，不看 `process.env.TZ`。⚠️ 重置点**不是** 00:00（2026-09-16 09:55 仍 10044），
 *   按日切桶只是记账口径，退役与复活另有一套（M100-02）。
 *
 * # 接口是异步的，闸门不等它
 *
 * 生产上台账在 Redis（M100-02），一次 `record` 是一趟网络。挑车道必须同步、在 FIFO 链里完成，
 * 所以客户端里另有一份**用量镜像**：发出前先把镜像 +1，`record` 回来后用它返回的总数校正，
 * 每 30 s 再拉一次全表对齐别的进程。软顶留 10% 正是给镜像滞后的余量。
 */

import { createHash } from "node:crypto";

/** 接口族：高德各接口的配额彼此独立，记账按族分。 */
export type AmapApiFamily =
  | "place"
  | "geocode"
  | "regeo"
  | "district"
  | "direction"
  | "transit"
  | "weather"
  | "other";

export const AMAP_API_FAMILIES: readonly AmapApiFamily[] = [
  "place",
  "geocode",
  "regeo",
  "district",
  "direction",
  "transit",
  "weather",
  "other",
];

/**
 * 一次请求的结局。**四种都计数**：高德按请求收费与计额，不按成功——被限流的那一发照样从配额里扣。
 * 分列存是为了回放页能看出"今天 450 次里有几次是白打的"。
 */
export type AmapOutcome = "ok" | "rate_limited" | "quota_exhausted" | "error";

export const AMAP_OUTCOMES: readonly AmapOutcome[] = ["ok", "rate_limited", "quota_exhausted", "error"];

/** 请求路径 → 接口族。未识别的路径归 `other`，不猜。 */
export function amapFamilyOf(path: string): AmapApiFamily {
  if (path.startsWith("/v5/place/") || path.startsWith("/v3/place/")) return "place";
  if (path.startsWith("/v3/geocode/regeo")) return "regeo";
  if (path.startsWith("/v3/geocode/")) return "geocode";
  if (path.startsWith("/v3/config/district")) return "district";
  if (path.startsWith("/v3/direction/transit")) return "transit";
  if (path.startsWith("/v5/direction/") || path.startsWith("/v3/direction/")) return "direction";
  if (path.startsWith("/v3/weather/")) return "weather";
  return "other";
}

/** key 的指纹：sha1 前 8 位。台账、日志、后台页都只用它，不出现 key 本身的任何片段。 */
export function amapKeyFingerprint(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 8);
}

/** 北京日（`YYYY-MM-DD`）。纯 UTC+8 算术，不受本机 TZ 影响。 */
export function beijingDay(at: number): string {
  return new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 台账字段名：`{family}:{outcome}`，与 Redis hash 的 field 同形。 */
export function amapUsageField(family: AmapApiFamily, outcome: AmapOutcome): string {
  return `${family}:${outcome}`;
}

/** 一把 key 一天的原始计数：field（`place:ok`）→ 次数。 */
export type AmapUsageFields = Record<string, number>;
/** 全表：fp → 原始计数。 */
export type AmapUsageSnapshot = Record<string, AmapUsageFields>;

/** 原始计数按族求和（四种结局相加）——预算比较的是"发了多少"，不是"成了多少"。 */
export function sumByFamily(fields: AmapUsageFields | undefined): Partial<Record<AmapApiFamily, number>> {
  const out: Partial<Record<AmapApiFamily, number>> = {};
  if (!fields) return out;
  for (const [field, n] of Object.entries(fields)) {
    const family = field.slice(0, field.indexOf(":")) as AmapApiFamily;
    if (!AMAP_API_FAMILIES.includes(family)) continue;
    out[family] = (out[family] ?? 0) + n;
  }
  return out;
}

/** 退役记录：哪一族、哪个 infocode、什么时候。给 M100-02 的持久化与探活复活用。 */
export interface AmapRetiredInfo {
  at: number;
  family: AmapApiFamily;
  infocode: string;
}

export interface AmapUsageLedger {
  /**
   * 记一次**已发出**的请求，返回该 fp × family 今日累计（四种结局之和，含这一次）。
   * 失败（Redis 断线）由实现自己吞并 warn——计数丢一次好过请求失败。
   */
  record(fp: string, family: AmapApiFamily, outcome: AmapOutcome, at: number): Promise<number>;
  /** 某一天的全表。给镜像刷新、probe 与财务页用。 */
  snapshot(day: string): Promise<AmapUsageSnapshot>;
  /** 一把 key 退役（日配额用尽）。M100-01 只定义，M100-02 接线。 */
  retire(fp: string, info: AmapRetiredInfo): Promise<void>;
  /** 当前所有退役中的 key。 */
  retired(): Promise<Record<string, AmapRetiredInfo>>;
  /** 一把 key 复活；实现应把「退役 → 复活」的间隔留一份观测（重置窗口从此有数据）。 */
  revive(fp: string, at: number): Promise<void>;
  /** 「退役 → 复活」的观测，最新在前，至多 50 条。 */
  observations(): Promise<AmapResetObservation[]>;
}

/** 一条重置窗口的观测：退役多少小时后再次可用。 */
export interface AmapResetObservation {
  fp: string;
  retiredAt: number;
  revivedAt: number;
  hours: number;
}

/** 内存实现：缺省与单测用；进程内一本账，重启即忘。 */
export function createMemoryAmapLedger(): AmapUsageLedger & { resetObserved(): AmapResetObservation[] } {
  const days = new Map<string, Map<string, Map<string, number>>>();
  const retiredMap = new Map<string, AmapRetiredInfo>();
  const observations: AmapResetObservation[] = [];

  function bucket(day: string, fp: string): Map<string, number> {
    let byFp = days.get(day);
    if (!byFp) {
      byFp = new Map();
      days.set(day, byFp);
    }
    let fields = byFp.get(fp);
    if (!fields) {
      fields = new Map();
      byFp.set(fp, fields);
    }
    return fields;
  }

  return {
    async record(fp, family, outcome, at) {
      const fields = bucket(beijingDay(at), fp);
      const field = amapUsageField(family, outcome);
      fields.set(field, (fields.get(field) ?? 0) + 1);
      let total = 0;
      for (const [f, n] of fields) if (f.startsWith(`${family}:`)) total += n;
      return total;
    },
    async snapshot(day) {
      const out: AmapUsageSnapshot = {};
      for (const [fp, fields] of days.get(day) ?? []) out[fp] = Object.fromEntries(fields);
      return out;
    },
    async retire(fp, info) {
      retiredMap.set(fp, info);
    },
    async retired() {
      return Object.fromEntries(retiredMap);
    },
    async revive(fp, at) {
      const info = retiredMap.get(fp);
      retiredMap.delete(fp);
      if (info) {
        observations.unshift(resetObservation(fp, info, at));
        observations.length = Math.min(observations.length, AMAP_RESET_OBSERVATIONS_MAX);
      }
    },
    async observations() {
      return [...observations];
    },
    resetObserved: () => [...observations],
  };
}

/** 一条「退役 → 复活」观测；`hours` 保留一位小数就够回答"重置窗口大概多长"。 */
function resetObservation(fp: string, info: AmapRetiredInfo, revivedAt: number): AmapResetObservation {
  return { fp, retiredAt: info.at, revivedAt, hours: (revivedAt - info.at) / 3_600_000 };
}

/** 重置窗口观测最多留几条。 */
export const AMAP_RESET_OBSERVATIONS_MAX = 50;

// ── Redis 台账（M100-02）────────────────────────────────────────

/** 用量 hash 的保留期：3 天。回放页看昨天与前天就够，更早的账没有决策价值。 */
export const AMAP_USAGE_TTL_S = 3 * 24 * 3600;
/**
 * 退役键的兜底保留期：36 小时。探活复活是主路径，这个 TTL 只防探活逻辑失效——
 * 万一没人探，36 小时后这把 key 也自动回来。
 */
export const AMAP_RETIRED_TTL_S = 36 * 3600;
/** 所有键都在这个前缀下，与 `env:` / 车辆缓存的键井水不犯河水（工单红线）。 */
export const AMAP_POOL_KEY_PREFIX = "amap:pool:";

const USAGE_PREFIX = `${AMAP_POOL_KEY_PREFIX}usage:`;
const RETIRED_PREFIX = `${AMAP_POOL_KEY_PREFIX}retired:`;
const RESET_OBSERVED_KEY = `${AMAP_POOL_KEY_PREFIX}reset-observed`;

/**
 * 台账用到的 Redis 命令子集。`redis@4` 的客户端结构上满足它；单测注入一个内存替身。
 * 只列真正调用的命令：接口越窄，替身越好写，也越难在替身里藏一条与真 Redis 不同的语义。
 */
export interface AmapRedisLike {
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
  hmGet(key: string, fields: string[]): Promise<Array<string | null>>;
  hGetAll(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<unknown>;
  scan(cursor: number, options: { MATCH: string; COUNT?: number }): Promise<{ cursor: number; keys: string[] }>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  lPush(key: string, element: string): Promise<unknown>;
  lTrim(key: string, start: number, stop: number): Promise<unknown>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
}

export interface AmapRedisLedgerOptions {
  /** 造客户端并连上。缺省 `import("redis")` + `connect()`；单测注入替身。 */
  clientFactory?: (url: string) => Promise<AmapRedisLike>;
  warn?: (msg: string, err?: unknown) => void;
  now?: () => number;
}

export interface AmapRedisLedger extends AmapUsageLedger {
  /** 连接结果：`redis` 或退回 `memory`。装配层打日志用；台账本身不等它。 */
  ready(): Promise<"redis" | "memory">;
}

/** 断线 warn 的最小间隔：Redis 挂了每个请求都会失败一次，日志不能跟着刷。 */
const REDIS_WARN_GAP_MS = 60_000;

/**
 * Redis 实现：三个进程记同一份账。
 *
 * **同步返回、懒连接**：worker 的装配（`createReviewDeps`）是同步的，而 `redis` 的连接是异步的。
 * 台账的每个方法本来就是异步的，所以连接放在第一次调用之前等即可；连不上就退回内部那本内存账，
 * 每个方法各自兜底——**Redis 挂掉只是三个进程各记各的，请求照发**（工单约束 4）。
 * 内存账在 Redis 可用时也同步在记，这样 Redis 半路失败时返回的还是本进程见过的真数。
 */
export function createRedisAmapLedger(url: string, opts: AmapRedisLedgerOptions = {}): AmapRedisLedger {
  const warn = opts.warn ?? ((m, e) => (e === undefined ? console.warn(m) : console.warn(m, e)));
  const now = opts.now ?? (() => Date.now());
  const factory = opts.clientFactory ?? connectRedis;
  const memory = createMemoryAmapLedger();
  let lastWarnAt = -Infinity;

  function warnThrottled(what: string, err: unknown): void {
    const t = now();
    if (t - lastWarnAt < REDIS_WARN_GAP_MS) return;
    lastWarnAt = t;
    warn(`[amap] Redis 台账${what}失败，这一次退回进程内的账（每分钟最多提示一次）`, err);
  }

  const connecting: Promise<AmapRedisLike | undefined> = factory(url).catch((e: unknown) => {
    warn("[amap] Redis 台账连不上，退回进程内——三进程各记各的", e);
    return undefined;
  });

  /** 在 Redis 上做一件事；没连上或失败就交给内存版。 */
  async function onRedis<T>(what: string, run: (c: AmapRedisLike) => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    const client = await connecting;
    if (!client) return fallback();
    try {
      return await run(client);
    } catch (e) {
      warnThrottled(what, e);
      return fallback();
    }
  }

  async function scanAll(client: AmapRedisLike, pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = 0;
    do {
      const page = await client.scan(cursor, { MATCH: pattern, COUNT: 200 });
      cursor = Number(page.cursor);
      keys.push(...page.keys);
    } while (cursor !== 0);
    return keys;
  }

  return {
    ready: () => connecting.then((c) => (c ? "redis" : "memory")),

    async record(fp, family, outcome, at) {
      const local = await memory.record(fp, family, outcome, at);
      const key = `${USAGE_PREFIX}${beijingDay(at)}:${fp}`;
      return onRedis(
        "记账",
        async (c) => {
          await c.hIncrBy(key, amapUsageField(family, outcome), 1);
          await c.expire(key, AMAP_USAGE_TTL_S);
          // 该族总数一次拿全：四个 outcome 的 field 一趟 HMGET，不 HGETALL。
          const values = await c.hmGet(key, AMAP_OUTCOMES.map((o) => amapUsageField(family, o)));
          return values.reduce((sum, v) => sum + (Number(v) || 0), 0);
        },
        async () => local,
      );
    },

    async snapshot(day) {
      const prefix = `${USAGE_PREFIX}${day}:`;
      return onRedis(
        "读全表",
        async (c) => {
          const out: AmapUsageSnapshot = {};
          for (const key of await scanAll(c, `${prefix}*`)) {
            const fields: AmapUsageFields = {};
            for (const [f, v] of Object.entries(await c.hGetAll(key))) fields[f] = Number(v) || 0;
            out[key.slice(prefix.length)] = fields;
          }
          return out;
        },
        () => memory.snapshot(day),
      );
    },

    async retire(fp, info) {
      await memory.retire(fp, info);
      await onRedis(
        "写退役",
        (c) => c.set(`${RETIRED_PREFIX}${fp}`, JSON.stringify(info), { EX: AMAP_RETIRED_TTL_S }),
        async () => undefined,
      );
    },

    async retired() {
      return onRedis(
        "读退役",
        async (c) => {
          const out: Record<string, AmapRetiredInfo> = {};
          for (const key of await scanAll(c, `${RETIRED_PREFIX}*`)) {
            const info = parseRetired(await c.get(key));
            if (info) out[key.slice(RETIRED_PREFIX.length)] = info;
          }
          return out;
        },
        () => memory.retired(),
      );
    },

    async revive(fp, at) {
      const key = `${RETIRED_PREFIX}${fp}`;
      // 退役记录以 Redis 为准（可能是别的进程写的）；本进程的内存账只是它连不上时的影子。
      const info = await onRedis("读退役", (c) => c.get(key).then(parseRetired), async () => (await memory.retired())[fp]);
      await memory.revive(fp, at);
      await onRedis(
        "写复活",
        async (c) => {
          await c.del(key);
          if (!info) return;
          await c.lPush(RESET_OBSERVED_KEY, JSON.stringify(resetObservation(fp, info, at)));
          await c.lTrim(RESET_OBSERVED_KEY, 0, AMAP_RESET_OBSERVATIONS_MAX - 1);
        },
        async () => undefined,
      );
    },

    async observations() {
      return onRedis(
        "读观测",
        async (c) => {
          const out: AmapResetObservation[] = [];
          for (const raw of await c.lRange(RESET_OBSERVED_KEY, 0, AMAP_RESET_OBSERVATIONS_MAX - 1)) {
            const parsed = parseObservation(raw);
            if (parsed) out.push(parsed);
          }
          return out;
        },
        () => memory.observations(),
      );
    },
  };
}

// ── 池子快照：probe 与财务页共用一份组装（M100-03）──────────────

/** 一把 key 在快照里的样子。**只有指纹，没有 key 本身**——这份结构会直接进 HTTP 响应。 */
export interface AmapPoolKeyStatus {
  /** 环境变量名，如 `AMAP_SERVER_KEY_3`。 */
  name: string;
  fp: string;
  /** 今日各接口族次数（四种结局相加）。 */
  usage: Partial<Record<AmapApiFamily, number>>;
  /** 有预算的族才有：预算数与占比（0~1）。没有预算的族两项都没有。 */
  budget?: Partial<Record<AmapApiFamily, number>>;
  ratio?: Partial<Record<AmapApiFamily, number>>;
  retiredAt?: number;
  retiredInfocode?: string;
}

export interface AmapPoolSnapshot {
  /** 北京日。 */
  day: string;
  keys: AmapPoolKeyStatus[];
  /** 这份账从哪来：Redis 上的全局账 / 某个进程内的账 / 压根没有台账。 */
  source: "redis" | "memory" | "none";
  /** 「退役 → 复活」的最近观测，最新在前。 */
  observations: AmapResetObservation[];
}

/** `resolveAmapKeys` 返回的形状，这里只需要名字与指纹（**不接受 key 本身**）。 */
export interface AmapPoolKeyRef {
  name: string;
  fp: string;
}

/**
 * 组装池子快照。probe 与财务页读的是同一份账、走的是同一段组装——
 * 两处各写一份的话，"后台说 27%、probe 说 31%" 这种问题没人说得清谁对。
 *
 * 台账不可用时返回 `source: "none"` 的空账，而不是抛错：看不到账是观测缺失，不是故障。
 */
export async function buildAmapPoolSnapshot(
  keys: readonly AmapPoolKeyRef[],
  ledger: AmapUsageLedger | undefined,
  budget: AmapDailyBudget,
  at: number,
): Promise<AmapPoolSnapshot> {
  const day = beijingDay(at);
  const empty: AmapPoolSnapshot = {
    day,
    source: "none",
    observations: [],
    keys: keys.map((k) => ({ name: k.name, fp: k.fp, usage: {} })),
  };
  if (!ledger) return empty;
  const source: "redis" | "memory" =
    "ready" in ledger && typeof (ledger as AmapRedisLedger).ready === "function"
      ? await (ledger as AmapRedisLedger).ready()
      : "memory";
  const [snap, retired, observations] = await Promise.all([
    ledger.snapshot(day),
    ledger.retired(),
    ledger.observations(),
  ]);
  return {
    day,
    source,
    observations,
    keys: keys.map((k) => {
      const usage = sumByFamily(snap[k.fp]);
      const status: AmapPoolKeyStatus = { name: k.name, fp: k.fp, usage };
      const budgets: Partial<Record<AmapApiFamily, number>> = {};
      const ratios: Partial<Record<AmapApiFamily, number>> = {};
      for (const [family, limit] of Object.entries(budget) as Array<[AmapApiFamily, number]>) {
        if (!limit || limit <= 0) continue;
        budgets[family] = limit;
        ratios[family] = (usage[family] ?? 0) / limit;
      }
      if (Object.keys(budgets).length > 0) {
        status.budget = budgets;
        status.ratio = ratios;
      }
      const info = retired[k.fp];
      if (info) {
        status.retiredAt = info.at;
        status.retiredInfocode = info.infocode;
      }
      return status;
    }),
  };
}

/**
 * 缺省的连接方式：与 `env-cache.ts` 的 `createRedisEnvCache` 同形，但**不共享连接**（工单红线），
 * 且**关掉自动重连**。
 *
 * 关重连的理由是 2026-09-16 真跑出来的：Redis 停着时默认策略无限重试，每次失败都触发一次
 * `error` 事件——`probe:amap` 被刷了满屏 `ECONNREFUSED`，而且那个句柄让进程再也退不出去。
 * 台账连不上本来就是"这一趟退回进程内"，没有必要在后台一直敲门；下次进程重启自然会再连。
 */
async function connectRedis(url: string): Promise<AmapRedisLike> {
  const { createClient } = await import("redis");
  const client = createClient({ url, socket: { reconnectStrategy: false } });
  let warned = false;
  client.on("error", (e: unknown) => {
    if (warned) return;
    warned = true;
    console.warn("[amap] Redis 台账连接异常（记账退回进程内，本进程不再重连）", e);
  });
  try {
    await client.connect();
  } catch (e) {
    // 连不上的客户端不能留着：它会一直占着事件循环，让 probe 这类短进程退不出去。
    // 从没连上过时 `disconnect()` 自己会抛 ClientClosedError——那正是我们要的状态，吞掉。
    await Promise.resolve(client.disconnect()).catch(() => undefined);
    throw e;
  }
  return client as unknown as AmapRedisLike;
}

function parseRetired(raw: string | null): AmapRetiredInfo | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<AmapRetiredInfo>;
    if (typeof v.at !== "number" || typeof v.family !== "string" || typeof v.infocode !== "string") return undefined;
    return { at: v.at, family: v.family, infocode: v.infocode };
  } catch {
    return undefined;
  }
}

function parseObservation(raw: string): AmapResetObservation | undefined {
  try {
    const v = JSON.parse(raw) as Partial<AmapResetObservation>;
    if (typeof v.fp !== "string" || typeof v.retiredAt !== "number" || typeof v.revivedAt !== "number") return undefined;
    return { fp: v.fp, retiredAt: v.retiredAt, revivedAt: v.revivedAt, hours: (v.revivedAt - v.retiredAt) / 3_600_000 };
  } catch {
    return undefined;
  }
}

/** 每接口族的日预算；没有的族 = 不设限。 */
export type AmapDailyBudget = Partial<Record<AmapApiFamily, number>>;

/**
 * 解析 `AMAP_DAILY_BUDGET`：`place=450,direction=0`。
 * `0` 或缺省都是"不设限"；非法片段 warn 跳过，不让一个错字把整份预算作废。
 */
export function parseAmapDailyBudget(
  raw: string | undefined,
  warn: (msg: string) => void = (m) => console.warn(m),
): AmapDailyBudget {
  const out: AmapDailyBudget = {};
  if (!raw?.trim()) return out;
  for (const piece of raw.split(",")) {
    const seg = piece.trim();
    if (!seg) continue;
    const eq = seg.indexOf("=");
    const family = (eq < 0 ? seg : seg.slice(0, eq)).trim() as AmapApiFamily;
    const value = eq < 0 ? "" : seg.slice(eq + 1).trim();
    const n = Number(value);
    if (!AMAP_API_FAMILIES.includes(family) || value === "" || !Number.isInteger(n) || n < 0) {
      warn(`[amap] AMAP_DAILY_BUDGET 片段「${seg}」不合法（应为 <族>=<非负整数>，族取 ${AMAP_API_FAMILIES.join("/")}），已跳过`);
      continue;
    }
    if (n > 0) out[family] = n;
  }
  return out;
}
