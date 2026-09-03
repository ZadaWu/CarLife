/**
 * ③偏好读取的 Mem0 后端（施工单 M14-10）。
 *
 * 与 `vehicle-cache-backend.ts` 同一条装配纪律：**具体后端由装配层持有**，
 * 端点只认 `PreferenceReader` 接口。这样 `profile-data.test.ts` 不必起
 * 一个真实的 PG + pgvector 才能测三态。
 *
 * `degraded` 原样带出，不吞：Mem0 客户端把"后端挂了"标成 degraded 而不是抛错
 * （见 `client.ts` 的 guard），端点若不区分，降级会被端上当成"没有偏好"。
 */

import { getMemoryClient } from "@carlife/memory";

import type { PreferenceReader } from "./profile-data";

/** metadata 里偏好领域的键。与 `preference-extract.ts` 写入侧一致。 */
const DOMAIN_KEY = "domain";

export function createMem0PreferenceReader(): PreferenceReader {
  return {
    async list(userId, limit) {
      const client = getMemoryClient();
      const r = await client.getAll(userId, { category: "preference" }, limit);
      return {
        items: r.results.map((m) => ({
          id: m.id,
          content: String(m.memory ?? ""),
          domain: typeof m.metadata?.[DOMAIN_KEY] === "string"
            ? (m.metadata[DOMAIN_KEY] as string)
            : undefined,
          updatedAt: m.updatedAt ? Date.parse(String(m.updatedAt)) || undefined : undefined,
        })),
        degraded: r.degraded,
        error: r.error,
      };
    },

    /**
     * 删除一条，**先验归属**。
     *
     * Mem0 的 `delete` 只认 memoryId，没有用户维度——直接透传等于开了一个
     * "知道 id 就能删任何人记忆"的接口。这里拿本人的清单核对一遍；
     * `client.get(id)` 帮不上忙：它返回的 `MemoryItem` 不带 userId。
     *
     * 核对用的上限比读取侧（20）大得多：端上只会删它看得见的那 20 条，
     * 200 是个宽裕的超集，避免"人多了之后校验开始误杀"。
     */
    async remove(userId, id) {
      const client = getMemoryClient();
      const owned = await client.getAll(userId, { category: "preference" }, 200);
      // 降级时**不许删**：验不了归属就动手，等于没验。
      if (owned.degraded) return { kind: "degraded", reason: owned.error };
      if (!owned.results.some((m) => m.id === id)) return { kind: "not_found" };
      await client.delete(id);
      return { kind: "ok" };
    },
  };
}
