/**
 * `charging` / `refuel` 候选站的按轮暂存（行程详情「沿途服务」数据源交接，待执行事项 3）。
 *
 * 形态照抄 `route-candidates.ts`：①Working 层、进程内 Map、按 (sessionId, turnId) 键、
 * 轮结束即弃、不落库。写入端在 `enterprise/backend/shared/tools/src/energy-stop-candidates.ts`
 * （经 `setEnergyStopCandidateRecorder` 注入，装配在 `index.ts`）；读取端有两处：
 * `submit_drive_draft` 经 `setEnergyStopLookup` 当场核对，`subgraphs/itinerary.ts` 的汇聚兜底。
 *
 * 同名后写**不覆盖**前写（与 `poi-coords.ts` 同一条）：核对只看名字，先到的那份足够。
 */

import type { EnergyStopCandidate } from "@carlife/tools";

/** 一轮最多记这么多条。一次 charging 最多 10 个插点 × 10 条候选，refuel 6 点 × 若干；留足余量。 */
const MAX_PER_TURN = 300;

const store = new Map<string, Map<string, EnergyStopCandidate>>();

const key = (sessionId: string, turnId: string): string => `${sessionId}#${turnId}`;

/** 名字归一只去空白：**不做别的**——核对时的宽松判据在工具包里（`verifyEnergyStops`），这里只是去重键。 */
const nameKey = (name: string): string => name.replace(/[\s　]+/g, " ").trim();

export function recordEnergyStopCandidates(
  ctx: { sessionId?: string; turnId?: string; agent?: string },
  candidates: readonly EnergyStopCandidate[],
): void {
  if (!ctx.sessionId || !ctx.turnId) return;
  const k = key(ctx.sessionId, ctx.turnId);
  let book = store.get(k);
  if (!book) {
    book = new Map();
    store.set(k, book);
  }
  for (const c of candidates) {
    if (book.size >= MAX_PER_TURN) break;
    const n = nameKey(c.name);
    if (!n) continue;
    if (!book.has(n)) book.set(n, c);
  }
}

/** 读取（不删除）：这一轮查到过的全部候选。没记过就是空数组——"本轮没查过"，与"没接"由调用方区分。 */
export function peekEnergyStopCandidates(sessionId: string, turnId: string): EnergyStopCandidate[] {
  return [...(store.get(key(sessionId, turnId))?.values() ?? [])];
}

/** 轮结束清理（与 `sweepPoiCoords` 同一时机调用）。 */
export function sweepEnergyStopCandidates(sessionId: string, turnId: string): void {
  store.delete(key(sessionId, turnId));
}

/** 测试用：清空全部。 */
export function resetEnergyStopCandidates(): void {
  store.clear();
}
