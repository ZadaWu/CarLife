/**
 * ④档案缓存的 Redis 后端——网关侧装配（施工单 M14-04）。
 *
 * 与 agent-runtime 的 `vehicle-cache-backend.ts` 同款（刻意重复这 30 行，
 * 不为它抽公共包：redis 依赖该由各装配层自己持有，见 M14-01）。
 * **两边共用同一键空间**（`carlife:vehicle:`）：网关侧建档/改里程会同步
 * 失效 agent-runtime 正在读的缓存——写后立即可见跨进程成立。
 */

import type { VehicleCacheBackend } from "@carlife/memory";

export async function createRedisVehicleCacheBackend(
  url: string | undefined,
): Promise<VehicleCacheBackend | undefined> {
  if (!url) return undefined;
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url });
    client.on("error", (e: unknown) =>
      console.warn("[vehicle-cache] Redis 连接异常（后续读将直连 PG）", e),
    );
    await client.connect();
    return {
      async get(key) {
        return (await client.get(key)) as string | null;
      },
      async set(key, value, ttlSeconds) {
        await client.set(key, value, { EX: ttlSeconds });
      },
      async del(keys) {
        if (keys.length > 0) await client.del(keys);
      },
    };
  } catch (err) {
    console.warn(`[vehicle-cache] Redis 连接失败（${url}）——④档案读直连 PG`, err);
    return undefined;
  }
}
