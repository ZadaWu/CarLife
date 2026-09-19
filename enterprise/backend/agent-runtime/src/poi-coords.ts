/**
 * 「这一轮 `poi_search` 查到过的点 → 坐标」的按轮登记簿（M77 走查追修）。
 *
 * 与 `branch-submissions.ts` 同一形态、同一生命周期：进程内 Map、按 (sessionId, turnId)、
 * 轮结束即弃、**不落库**（§7①）。丢了的后果只是"该轮的片区缺口判定回落到字符串匹配"
 * ——设计内的降级，不是缺陷。
 *
 * 存在的理由见 `poi-search.ts` 的 `PoiCoordSink`：两个分支写的中文片区标签对不上，
 * 而它们的点名都是从同一个工具的返回里逐字抄的，坐标那时就在手上。
 */

import type { PoiKind } from "@carlife/shared";

export interface PoiCoord {
  lat: number;
  lon: number;
  /**
   * 命中 POI 自述的城市。**这是 `trustCoordHit` 的验证材料**，不是展示用的——
   * 没有它，复用这份坐标时 ADR-008 的第三道网（城市证据冲突）就查不了。
   */
  cityName?: string;
  /** 贴纸品类，高德 type 字段分出来的。带上它，确认轮才不用为了品类再搜一次。 */
  poiKind?: PoiKind;
}

/** 一轮最多记这么多条。一份四天行程的两个分支加起来 ~100 条，留足余量又不至于被刷爆。 */
const MAX_PER_TURN = 500;

const books = new Map<string, Map<string, PoiCoord>>();

const key = (sessionId: string, turnId: string): string => `${sessionId}#${turnId}`;

/** 名字归一：只去首尾空白与全角空格。**不做别的**——名字是逐字抄来的，改写它等于制造对不上。 */
export function normalizePoiName(name: string): string {
  return name.replace(/[\s　]+/g, " ").trim();
}

/**
 * 记一批坐标。turnId 缺失就不记（归不了轮，谁也读不到）。
 * 同名后写**不覆盖**前写：先查到的那次通常是该分支带着正确城市限定查的，
 * 后面别的分支用另一个城市查到同名点时不该把它顶掉（ADR-008 的同名异地）。
 */
export function recordPoiCoords(
  ctx: { sessionId: string; turnId?: string },
  hits: ReadonlyArray<{ name: string; lat: number; lon: number; cityName?: string; poiKind?: PoiKind }>,
): void {
  if (!ctx.turnId) return;
  const k = key(ctx.sessionId, ctx.turnId);
  let book = books.get(k);
  if (!book) {
    book = new Map();
    books.set(k, book);
  }
  for (const h of hits) {
    if (book.size >= MAX_PER_TURN) break;
    const n = normalizePoiName(h.name);
    if (!n || !Number.isFinite(h.lat) || !Number.isFinite(h.lon)) continue;
    if (!book.has(n)) {
      book.set(n, {
        lat: h.lat,
        lon: h.lon,
        ...(h.cityName ? { cityName: h.cityName } : {}),
        ...(h.poiKind ? { poiKind: h.poiKind } : {}),
      });
    }
  }
}

/** 查一个名字的坐标；没记过返回 undefined（调用方必须能接受"查不到"）。 */
export function lookupPoiCoord(
  sessionId: string | undefined,
  turnId: string | undefined,
  name: string | undefined,
): PoiCoord | undefined {
  if (!sessionId || !turnId || !name) return undefined;
  return books.get(key(sessionId, turnId))?.get(normalizePoiName(name));
}

/** 轮结束清理（与 `sweepTurn` 同一时机调用）。 */
export function sweepPoiCoords(sessionId: string, turnId: string): void {
  books.delete(key(sessionId, turnId));
}

/** 测试用：清空全部。 */
export function resetPoiCoords(): void {
  books.clear();
}

/** 大屏/排查用：这一轮记了多少条。 */
export function poiCoordCount(sessionId: string, turnId: string): number {
  return books.get(key(sessionId, turnId))?.size ?? 0;
}
