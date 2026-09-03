/**
 * 余额的小时级历史 —— 财务卡片上那条曲线的数据源。
 *
 * # 为什么它和 finance-cache.json 是两个文件
 *
 * `finance-state.ts` 落的是**缓存**：丢了毫无损失，下次采集就有，所以它有
 * 「结构变了就升版本、旧文件按空白处理」的权利。历史不是——**丢一小时就永远
 * 少一小时**，没有任何办法补回来。两者混在一个文件里，早晚有一次为了改缓存
 * 结构而顺手把七天的曲线清空。所以分开放，各自升各自的版本。
 *
 * 但它也**不进 Postgres**：这是运维观测数据不是账本，7 天 × 24 小时 × 3 个
 * 有余额的账户不过五百来个点，为它建表迁移是拿业务数据的成本对待一份看图用的
 * 时间序列。`var/` 被 .gitignore 忽略，清仓库时会一起没——这是已知代价，
 * 曲线断掉不影响任何判断，只是少看几天。
 *
 * # 只记「对方给了确切数字」的账户
 *
 * 判据与前端 `showsAmount()` 逐字对齐：`status=ok && exact && amount!==undefined`。
 * 高德（`exact=false`，只能证明 key 还能用，证明不了还剩多少）与 RAGFlow
 * （订阅制，压根没有余额口径）一个点都不记——**给它们画一条线，等于把
 * "查不到" 画成了 "一直没变"**，那是这一页最不该犯的错。
 *
 * # 一个采样周期一个点，且缺掉的周期必须留成缺口
 *
 * 周期默认 10 分钟（`CARLIFE_FINANCE_HISTORY_INTERVAL_MIN`）。网关停了半小时
 * 就是三个空桶。补点、或者让曲线直接从缺口两端拉一条直线过去，都是在替供应商
 * 编造它没说过的数字。缺口由前端断开线段来表达（见
 * `console/src/pages/finance/history.ts` 的 `gapMs`），这里只负责如实少写。
 *
 * 周期是**唯一的旋钮**：保留窗口、缺口阈值、页面上"每 N 分钟采样一次"那句话
 * 全部由它推出来（`stepMs` 随响应下发）。散着写死的话，改一次周期就会漏掉几处，
 * 而漏掉的地方不会报错，只会开始说假话。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { FinanceAccount } from "./finance-providers";

/** 结构变了就升版本。历史比缓存值钱，升版本时要认真考虑迁移而不是丢弃。 */
const HISTORY_VERSION = 1;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const RETENTION_DAYS = 7;
export const RETENTION_MS = RETENTION_DAYS * 24 * HOUR_MS;

/** 默认采样周期（分钟）。10 分钟整除一小时，因此桶稳定落在 :00 / :10 / :20…… */
export const DEFAULT_INTERVAL_MIN = 10;

/**
 * 采样周期。惰性读 env（模块级读会踩 env-timing 那条不变量）。
 *
 * 下限 1 分钟不是随手定的：7 天 ÷ 周期 = 每个账户的点数，1 分钟就是 10080 个点，
 * 落盘文件与接口响应都会涨到几百 KB，而 300px 宽的曲线上根本画不出这个密度。
 * 上限一天一个点——比这更稀就不叫曲线了。
 */
export function intervalMs(): number {
  const raw = Number(process.env.CARLIFE_FINANCE_HISTORY_INTERVAL_MIN ?? DEFAULT_INTERVAL_MIN);
  const min = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MIN;
  return Math.min(Math.max(Math.round(min), 1), 24 * 60) * MINUTE_MS;
}

/** 盘上的点故意用短字段名：1000+ × N 个点，长字段名会让文件大一倍。 */
export interface StoredPoint {
  /** 所属采样桶的起点（epoch ms） */
  h: number;
  /** 余额 */
  v: number;
  /** 币种 */
  c: string;
}

export interface FinanceHistory {
  version: number;
  /**
   * 上次**尝试**过采集的桶（成功与否都记）。
   *
   * 记的是"尝试"不是"成功"：只记成功的话，一家上游连挂三小时会让定时器
   * 每分钟重打一轮——把一次故障放大成一场自伤。
   */
  lastAttemptBucket: number | null;
  series: Record<string, StoredPoint[]>;
}

export function emptyHistory(): FinanceHistory {
  return { version: HISTORY_VERSION, lastAttemptBucket: null, series: {} };
}

/** 惰性取，避开 env-timing 那条不变量（模块级读 env 会被启动顺序坑）。 */
export function defaultHistoryFile(): string {
  return resolve(process.env.CARLIFE_FINANCE_HISTORY_FILE ?? "var/finance-history.json");
}

/** 时刻所属采样桶的起点。桶从 epoch 起算，因此不同进程算出来的边界一致。 */
export function bucketStart(ms: number, step: number = intervalMs()): number {
  return Math.floor(ms / step) * step;
}

/**
 * 这个账户能不能上曲线。与前端 `showsAmount()` 是同一条判据——
 * 两处不一致的表现是：卡片上没有大数字，底下却画着一条线。
 */
export function isChartable(a: FinanceAccount): boolean {
  return a.status === "ok" && a.exact && typeof a.amount === "number" && Number.isFinite(a.amount);
}

/**
 * 把一次采集结果写进它所属的采样桶。
 *
 * 同一个桶内重复采集（有人连点几次强制刷新）**覆盖而不是追加**——
 * 说好了一周期一个点，追加会让那一段曲线突然变密，看起来像波动。
 */
export function recordSnapshot(
  history: FinanceHistory,
  accounts: FinanceAccount[],
  atMs: number,
): FinanceHistory {
  const h = bucketStart(atMs);
  const series = { ...history.series };

  for (const a of accounts) {
    if (!isChartable(a)) continue;
    const point: StoredPoint = { h, v: a.amount as number, c: a.currency ?? "CNY" };
    const kept = (series[a.id] ?? []).filter((p) => p.h !== h);
    // 按时间插入而不是 push+sort：采集永远是往后走的，push 后只在极少数
    // （改过系统时间）情况下需要排序，但排一次的代价可以忽略。
    kept.push(point);
    kept.sort((x, y) => x.h - y.h);
    series[a.id] = kept;
  }

  return prune({ ...history, series }, atMs);
}

/** 只留最近 7 天。空掉的账户整条删除——留一个空数组会让前端多一种"有 key 但没点"的形态。 */
export function prune(history: FinanceHistory, nowMs: number): FinanceHistory {
  const cutoff = bucketStart(nowMs) - RETENTION_MS;
  const series: Record<string, StoredPoint[]> = {};
  for (const [id, points] of Object.entries(history.series)) {
    const kept = points.filter((p) => p.h > cutoff);
    if (kept.length > 0) series[id] = kept;
  }
  return { ...history, series };
}

export interface HistoryApiPoint {
  /** 采样桶起点（epoch ms）。用毫秒不用 ISO：1000+ 个点 × N 个账户，字符串会把响应撑大三倍。 */
  t: number;
  v: number;
}

export interface HistoryApiSeries {
  currency: string;
  points: HistoryApiPoint[];
}

export interface HistoryApiResponse {
  retentionDays: number;
  /**
   * 采样周期。**必须下发**：前端的缺口阈值、空态里那句"每 N 分钟采样一次"
   * 都由它推出来，在前端再写死一份就是等着两边不一致。
   */
  stepMs: number;
  /** 时间窗口固定为 [now-7d, now]，让所有卡片的横轴可比。 */
  from: number;
  to: number;
  series: Record<string, HistoryApiSeries>;
  note: string;
}

export function toApi(history: FinanceHistory, nowMs: number): HistoryApiResponse {
  const step = intervalMs();
  const to = nowMs;
  const from = bucketStart(nowMs, step) - RETENTION_MS;
  const series: Record<string, HistoryApiSeries> = {};

  for (const [id, points] of Object.entries(history.series)) {
    const kept = points.filter((p) => p.h > from);
    if (kept.length === 0) continue;
    series[id] = {
      // 币种理论上不会变；真变了以最新那个为准，历史点的数值口径由供应商负责。
      currency: kept[kept.length - 1].c,
      points: kept.map((p) => ({ t: p.h, v: p.v })),
    };
  }

  return {
    retentionDays: RETENTION_DAYS,
    stepMs: step,
    from,
    to,
    series,
    note: `每 ${step / MINUTE_MS} 分钟一个采样点；网关没在跑的那些时段没有点，曲线上是断开的缺口，不做补点`,
  };
}

export function loadHistory(file: string): FinanceHistory {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[finance] 读取余额历史失败，按空白启动：${String(err)}`);
    }
    return emptyHistory();
  }
  try {
    const parsed = JSON.parse(raw) as FinanceHistory;
    if (parsed?.version !== HISTORY_VERSION || typeof parsed.series !== "object" || parsed.series === null) {
      return emptyHistory();
    }
    return { ...emptyHistory(), ...parsed };
  } catch (err) {
    // 与缓存同样的处置：改名留证再按空白启动。但这里的留证更要紧——
    // 坏掉的是七天数据，改名后至少还有人工捞回来的可能。
    const broken = `${file}.broken-${Date.now()}`;
    try {
      renameSync(file, broken);
      console.warn(`[finance] 余额历史损坏（${String(err)}），已另存为 ${broken}，按空白启动`);
    } catch {
      console.warn(`[finance] 余额历史损坏且无法改名（${String(err)}），按空白启动`);
    }
    return emptyHistory();
  }
}

/** 先写临时文件再改名——进程写一半被 kill 不该留下半个 JSON。写失败只告警不抛。 */
export function saveHistory(file: string, history: FinanceHistory): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(history));
    renameSync(tmp, file);
  } catch (err) {
    console.warn(`[finance] 余额历史落盘失败（不影响本次查询）：${String(err)}`);
  }
}
