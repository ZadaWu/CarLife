/**
 * 用户长期状态的快照缓存（施工单 M84-03，ACR-036 §4.9）。
 *
 * 与 `vehicle-cache-backend.ts` 同一取向：**接口在这里，redis 依赖在装配层**；
 * 连不上就直连权威源，不抛错——缓存不可用只是慢，不是故障。
 *
 * # TTL 兜底，不只靠失效
 *
 * 写路径（确认行程、改档案、成员变更、worker 的提醒与聚合）各自调 `invalidate(userId)`，
 * 但**漏接一处是迟早的事**，而漏接的表现是"车主改了档案，助手还照着旧的说话"，
 * 没有任何报错。60 秒 TTL 是那件事的上限：漏接最多旧一分钟，不是永远旧。
 */

import type { UserContext } from "@carlife/shared";

/** 装配层给的后端。形状照 `VehicleCacheBackend`，故意不复用它的类型——那是 ④ 的接口。 */
export interface ContextCacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(keys: string[]): Promise<void>;
}

export const DEFAULT_CONTEXT_CACHE_TTL_S = 60;

export function contextCacheTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CARLIFE_CONTEXT_CACHE_TTL_S);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTEXT_CACHE_TTL_S;
}

const keyOf = (userId: string): string => `ctx:${userId}`;

export interface ContextCache {
  get(userId: string): Promise<UserContext | undefined>;
  set(userId: string, ctx: UserContext): Promise<void>;
  invalidate(userId: string): Promise<void>;
}

/** 没有后端时的空实现：每次都直连权威源。行为正确，只是慢。 */
export const NO_CONTEXT_CACHE: ContextCache = {
  async get() {
    return undefined;
  },
  async set() {},
  async invalidate() {},
};

export function createContextCache(
  backend: ContextCacheBackend | undefined,
  ttlSeconds: number = contextCacheTtlSeconds(),
): ContextCache {
  if (!backend) return NO_CONTEXT_CACHE;
  return {
    async get(userId) {
      try {
        const raw = await backend.get(keyOf(userId));
        return raw ? (JSON.parse(raw) as UserContext) : undefined;
      } catch (err) {
        // 缓存读坏了就当没有——**不能让它变成一次失败的对话**。
        console.warn("[context] 快照读取失败，本轮直连权威源", err);
        return undefined;
      }
    },
    async set(userId, ctx) {
      try {
        await backend.set(keyOf(userId), JSON.stringify(ctx), ttlSeconds);
      } catch (err) {
        console.warn("[context] 快照写入失败（不影响本轮）", err);
      }
    },
    async invalidate(userId) {
      try {
        await backend.del([keyOf(userId)]);
      } catch (err) {
        console.warn("[context] 快照失效失败（TTL 会兜底）", err);
      }
    },
  };
}

/**
 * 进程级的单例。写路径（工具层、worker）拿不到装配层的对象，只能经这里失效。
 *
 * 与 `getGuardGate()` / `getAmapClient()` 同一形态：装配处 `set`，调用处 `get`；
 * 没装配时是空实现，不是抛错。
 */
let current: ContextCache = NO_CONTEXT_CACHE;

export function setContextCache(c: ContextCache): void {
  current = c;
}

export function getContextCache(): ContextCache {
  return current;
}

/** 写路径调它。**fire-and-forget**：失效失败只是缓存旧一会儿，不该让写操作失败。 */
export function invalidateUserContext(userId: string | undefined): void {
  if (!userId) return;
  void current.invalidate(userId).catch(() => {});
}
