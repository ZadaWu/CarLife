/**
 * `web_search` 结果的按轮白名单暂存（施工单 M36-01）。
 *
 * # 它为什么存在
 *
 * 出处校验的不变量（M32-01 实测钉下）："展示的出处必须与**这次搜索真实返回过的**
 * 某条 URL 字符串全等，匹配不上就置空"。`destination_highlights` 是单次调用，
 * 白名单就在同一个回包里；导游采集是**三个分支各自多次调用 `web_search`**，
 * 白名单散落在各次工具调用里——merge 汇聚时必须能拿到本轮累计的完整清单。
 *
 * # 形态照抄 branch-submissions
 *
 * ①Working 层：进程内 Map、按 (sessionId, turnId) 键、轮结束即弃、不落库。
 * 写入端在 `enterprise/backend/shared/tools/src/web-search.ts`（经 `setSearchResultRecorder` 注入，
 * 装配在 `index.ts`）；读取端是 `subgraphs/guide.ts` 的 merge。
 * runtime 重启丢失的后果只是"该轮出处全部置空、条目照常展示"——设计内的降级。
 *
 * # 为什么不分分支（agent 维度）
 *
 * 校验要回答的只是"这条 URL 真的在这次采集的搜索结果里出现过吗"——
 * 跨分支引用（spots 引到 comfort 搜出来的链接）没有危害，分支维度只会让
 * 键空间多一层、漏配一处就整支置空。按轮聚合就够。
 */

import type { SearchResultRef } from "@carlife/tools";

const store = new Map<string, Map<string, SearchResultRef>>();

function key(sessionId: string, turnId: string): string {
  return `${sessionId}#${turnId}`;
}

/** 落一批搜索结果。sessionId/turnId 缺失时丢弃——归不了轮的结果谁也读不到。 */
export function recordSearchResults(
  ctx: { sessionId?: string; turnId?: string; agent?: string },
  results: readonly SearchResultRef[],
): void {
  if (!ctx.sessionId || !ctx.turnId) return;
  const k = key(ctx.sessionId, ctx.turnId);
  let m = store.get(k);
  if (!m) {
    m = new Map();
    store.set(k, m);
  }
  // 按 url 去重：同一条链接被多轮搜索命中是常态，title 取先到的那份。
  for (const r of results) {
    if (r.url && !m.has(r.url)) m.set(r.url, r);
  }
}

/** 读本轮累计的白名单（不删除；清理归 sweep）。 */
export function peekSearchResults(sessionId: string, turnId: string): SearchResultRef[] {
  return [...(store.get(key(sessionId, turnId))?.values() ?? [])];
}

/** 轮级清理，与 branch-submissions.sweepTurn 挂同一处调用。 */
export function sweepSearchResults(sessionId: string, turnId: string): void {
  store.delete(key(sessionId, turnId));
}

/** 测试用：全量复位。 */
export function __resetSearchResults(): void {
  store.clear();
}
