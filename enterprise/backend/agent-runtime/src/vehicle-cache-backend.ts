/**
 * ④档案缓存的 Redis 后端（施工单 M14-01，F-23-13）。
 *
 * 装配层持有 redis 依赖，`@carlife/memory` 只认 `VehicleCacheBackend` 接口——
 * 与⑤环境缓存（`createRedisEnvCache`）同一取向：连不上返回 undefined，
 * 由调用方决定裸仓储直连，不抛错（缓存不可用只是慢，不是故障）。
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
