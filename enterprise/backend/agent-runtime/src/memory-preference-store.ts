/**
 * ③偏好的读那一半（座舱用的 `preference_recall` 工具后端，施工单 M95-02）。
 *
 * 两种语义、两条路：
 *  - 有查询词 → `searchPreference`（向量检索，带 `score`）；
 *  - 没有查询词 → `getAll` 按类别**列举**（契约写的是"取该用户最近的若干条"）。
 *
 * **空串不是查询词。** 此前无查询词分支走的是 `search(userId, "")`——先把空串送去 embedding
 * 再做向量检索。在本机 Ollama 上它只是慢；换到 DashScope 后空输入会被拒，这条路从"慢"变成"断"
 * （M91-04 已把上下文装载那一处改成列举，这里是仓内第二处）。
 *
 * `degraded` 一字不改地透传：读失败不能吞成空列表，否则一次后端故障会被座舱说成
 * "我还不太了解你"——听起来无害，实际是拿谎话盖故障。
 */

import type { CarLifeMemoryClient, MemoryReadResult } from "@carlife/memory";
import type { PreferenceStore, RecalledPreference } from "@carlife/tools";

/** 只依赖这两条读能力；假客户端只实现它们也能编译。 */
export type PreferenceStoreClient = Pick<CarLifeMemoryClient, "getAll" | "searchPreference">;

export const PREFERENCE_STORE_CATEGORY = "preference";

function toRecalled(r: MemoryReadResult): RecalledPreference[] {
  return (r.results ?? []).map((m) => ({
    content: String(m.memory ?? ""),
    score: typeof m.score === "number" ? m.score : undefined,
    domain: (m.metadata as { domain?: string } | undefined)?.domain,
    confidence: (m.metadata as { confidence?: number } | undefined)?.confidence,
  }));
}

export function createPreferenceStore(client: PreferenceStoreClient): PreferenceStore {
  return {
    async recall(userId, query, limit) {
      try {
        const r = query
          ? await client.searchPreference(userId, query, limit)
          : await client.getAll(userId, { category: PREFERENCE_STORE_CATEGORY }, limit);
        return { preferences: toRecalled(r), degraded: r.degraded === true };
      } catch (err) {
        console.warn("[memory] ③偏好检索失败，按降级上报（不当成「没有偏好」）", err);
        return { preferences: [], degraded: true };
      }
    },
  };
}
