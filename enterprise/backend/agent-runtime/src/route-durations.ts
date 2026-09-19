/**
 * 「本轮每条路 map_route 算出来多少分钟」的按轮暂存（ACR-047 的段和核对，turn-ced08ea1）。
 *
 * 形态照抄 `energy-candidates.ts`：①Working 层、进程内 Map、按 (sessionId, turnId) 键、
 * 轮结束即弃、不落库。写入端在 `enterprise/backend/shared/tools/src/map-route.ts`
 * （经 `setRouteDurationRecorder` 注入，装配在 `index.ts`）；读取端是 `submit_drive_plan`
 * 经 `setRouteDurationLookup` 当场核对各段之和。
 *
 * # 同一对起终点，后写**覆盖**前写
 *
 * 与补能站候选那本相反（那本是"这一轮见过哪些名字"，先到的够用）。这本记的是一个**量**：
 * 体检不过时修复轮会把同一条路重算一遍，那是同一条路的新数字，不是第二条路。
 * 不覆盖的话，核对会拿第一轮的时长去比第二轮的段——而两轮之间路线可能已经换了骨架。
 */

import type { RouteDurationRecord } from "@carlife/tools";

/** 一轮最多记这么多条路。一趟七天行程的 drive 分支一轮算 8~10 条，修复轮重算，留足余量。 */
const MAX_PER_TURN = 60;

const store = new Map<string, Map<string, RouteDurationRecord>>();

const key = (sessionId: string, turnId: string): string => `${sessionId}#${turnId}`;

/** 去重键：起终点名去空白。**不做别的**——认不认得是同一个地方的宽松判据在工具包里（`samePlace`）。 */
const routeKey = (r: RouteDurationRecord): string =>
  `${r.from.replace(/[\s　]+/g, "")}→${r.to.replace(/[\s　]+/g, "")}`;

export function recordRouteDuration(
  ctx: { sessionId?: string; turnId?: string; agent?: string },
  route: RouteDurationRecord,
): void {
  if (!ctx.sessionId || !ctx.turnId) return;
  const k = key(ctx.sessionId, ctx.turnId);
  let book = store.get(k);
  if (!book) {
    book = new Map();
    store.set(k, book);
  }
  const rk = routeKey(route);
  if (!rk.trim() || rk === "→") return;
  // 新的覆盖旧的（见文件头）；只有在这本已经满了、且是一条没见过的路时才丢。
  if (!book.has(rk) && book.size >= MAX_PER_TURN) return;
  book.set(rk, route);
}

/** 读取（不删除）：这一轮算过的每条路。没记过就是空数组。 */
export function peekRouteDurations(sessionId: string, turnId: string): RouteDurationRecord[] {
  return [...(store.get(key(sessionId, turnId))?.values() ?? [])];
}

/** 轮结束清理（与 `sweepEnergyStopCandidates` 同一时机调用）。 */
export function sweepRouteDurations(sessionId: string, turnId: string): void {
  store.delete(key(sessionId, turnId));
}

/** 测试用：清空全部。 */
export function resetRouteDurations(): void {
  store.clear();
}
