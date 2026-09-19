/**
 * 「偏好」一段的读取器（ACR-036 §4.9 的 `readers.preferences`）。
 *
 * 单独成文件是为了能拿假客户端测两条不变量——它们藏在 `index.ts` 的闭包里时测不到：
 *
 * 1. **不做向量检索。** 这里没有查询词，要的是"这个人的全部偏好"，走 `getAll`
 *    （按 metadata 列举，一条带过滤的 SQL）。`search("")` 连空串都要先过一次 embedding
 *    （本地 Ollama），一次读的下限就是一次 embed 调用——模型冷着时上秒，
 *    稳稳超过 `ASSEMBLE_BUDGET_MS`。
 * 2. **后端不可用时抛出，不当空表。** 记忆客户端对故障的表达是 `degraded: true` + 空结果；
 *    把它原样返回，锚定块里就成了"他没有偏好"。投影层（`assemble.ts`）对"读不到"另有形状
 *    （`{ unavailable, reason }`），只有抛出去才会走到那一档。2026-09-16 在控制台
 *    「查看上下文」里实测：本机没装 Ollama，22 轮里 20 轮显示"没有"、2 轮显示
 *    "超过 300ms 预算"，没有一轮说了实话。
 */

import type { CarLifeMemoryClient } from "@carlife/memory";

/** 与写入侧 `setPreferenceStore` 同一个 category，不另写一套。 */
export const PREFERENCE_CATEGORY = "preference";
/** 锚定块里最多放几条偏好。投影上限，不是存储上限。 */
export const PREFERENCE_LIMIT = 5;

/** 只依赖列举能力：类型上就排除了走 `search` 的可能。 */
export type PreferenceSource = Pick<CarLifeMemoryClient, "getAll">;

export async function readPreferences(source: PreferenceSource, userId: string): Promise<string[]> {
  const r = await source.getAll(userId, { category: PREFERENCE_CATEGORY }, PREFERENCE_LIMIT);
  if (r.degraded) throw new Error(`记忆后端不可用：${r.error ?? "未知原因"}`);
  return r.results.map((m) => String(m.memory ?? "")).filter((s) => s.length > 0);
}
