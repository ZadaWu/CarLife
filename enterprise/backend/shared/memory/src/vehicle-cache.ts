/**
 * ④车辆档案读缓存（施工单 M14-01，F-23-13）。
 *
 * # 写后立即可见是硬性质，TTL 是优化
 *
 * ④是强一致存储（§7④）：缓存只允许影响读延迟，不允许影响读到的值。
 * 所以失效挂在**写路径内**——写库成功后同步删 key，不靠 TTL 自然过期兜正确性。
 * TTL 的作用只剩兜"失效删漏了"的极端场景（如另一进程绕过本包装直写库）。
 *
 * # 与⑤环境缓存（env-cache）是两个键空间
 *
 * ⑤的键**禁含**用户维度（外部世界的事实，与谁在问无关）；
 * 这里的键**必含** VIN / ownerId（档案就是用户数据）。前缀因此分开
 * （`carlife:vehicle:` vs `carlife:env:`），TTL 也不复用 `ENV_TTL`——
 * 档案的变化由事件驱动，60s 只是重复读的合并窗口。
 *
 * # 后端不可用：读直连、写不回滚
 *
 * 读失败降级直连 PG（缓存挂了只是慢）。写路径上**库是真相源**：
 * 失效删除失败不能回滚已成功的库写，只能计数上报——
 * `degraded` 是"缓存可能短暂不一致"的唯一信号，不静默。
 */

import type { VehicleProfile, VehicleStore } from "./vehicle-store";

export interface VehicleCacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(keys: string[]): Promise<void>;
}

export interface VehicleCacheStats {
  hits: number;
  misses: number;
  /** 后端故障（读降级直连 / 写后失效失败）的次数。**不静默**。 */
  degraded: number;
  /** 写路径成功执行的失效次数。 */
  invalidations: number;
}

const stats: VehicleCacheStats = { hits: 0, misses: 0, degraded: 0, invalidations: 0 };

export function getVehicleCacheStats(): VehicleCacheStats {
  return { ...stats };
}

/** 仅供测试。 */
export function resetVehicleCacheStats(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.degraded = 0;
  stats.invalidations = 0;
}

/** 60s：不是数据有效期（档案事件驱动更新），是同一会话内重复读的合并窗口。 */
export const VEHICLE_CACHE_TTL_SECONDS = 60;

export function vehicleVinKey(vin: string): string {
  return `carlife:vehicle:vin:${vin}`;
}

export function vehicleOwnerKey(ownerId: string): string {
  return `carlife:vehicle:owner:${ownerId}`;
}

async function readThrough<T>(
  backend: VehicleCacheBackend,
  key: string,
  ttlSeconds: number,
  fetch: () => Promise<T | null>,
  /** 空结果不进缓存：缓存"没有档案"会让刚建完档的读多等一个 TTL。 */
  cacheable: (v: T | null) => boolean,
): Promise<T | null> {
  try {
    const hit = await backend.get(key);
    if (hit !== null) {
      stats.hits += 1;
      return JSON.parse(hit) as T;
    }
    stats.misses += 1;
  } catch (err) {
    stats.degraded += 1;
    console.warn(`[vehicle-cache] 读失败，直连库：${key}`, err);
    return fetch();
  }

  const value = await fetch();
  if (cacheable(value)) {
    try {
      await backend.set(key, JSON.stringify(value), ttlSeconds);
    } catch (err) {
      // 写缓存失败只影响下一次命中，本次结果照常返回。
      stats.degraded += 1;
      console.warn(`[vehicle-cache] 写缓存失败（本次结果不受影响）：${key}`, err);
    }
  }
  return value;
}

async function invalidate(backend: VehicleCacheBackend, keys: string[]): Promise<void> {
  try {
    await backend.del(keys);
    stats.invalidations += 1;
  } catch (err) {
    // 库写已成功，这里不能抛——但必须可观测：这是缓存与库短暂不一致的唯一窗口。
    stats.degraded += 1;
    console.warn(`[vehicle-cache] 失效失败（最长不一致 ${VEHICLE_CACHE_TTL_SECONDS}s）：${keys.join(", ")}`, err);
  }
}

/**
 * 缓存装饰器：读走缓存、写透传后同步失效。
 *
 * 每个写操作删两类 key：该 vin 的档案 + 该 owner 的列表
 * （upsert/setDefault 影响列表内容与排序；append/advance 改列表里那份档案的内容）。
 */
export function createCachedVehicleStore(
  inner: VehicleStore,
  backend: VehicleCacheBackend,
  ttlSeconds: number = VEHICLE_CACHE_TTL_SECONDS,
): VehicleStore {
  return {
    async get(vin) {
      return readThrough(
        backend,
        vehicleVinKey(vin),
        ttlSeconds,
        () => inner.get(vin),
        (v) => v !== null,
      );
    },

    async listByOwner(ownerId) {
      const cached = await readThrough<VehicleProfile[]>(
        backend,
        vehicleOwnerKey(ownerId),
        ttlSeconds,
        () => inner.listByOwner(ownerId),
        // 空列表同样不缓存：建档动作可能来自尚未接缓存的路径。
        (v) => v !== null && v.length > 0,
      );
      return cached ?? [];
    },

    async upsert(p) {
      await inner.upsert(p);
      await invalidate(backend, [vehicleVinKey(p.vin), vehicleOwnerKey(p.ownerId)]);
    },

    async setDefault(ownerId, vin) {
      const profile = await inner.setDefault(ownerId, vin);
      // 旧默认车的 vin 缓存无需删：VehicleProfile 形状里没有 isDefault，
      // 默认与否只体现在 listByOwner 的排序——删 owner key 已覆盖。
      await invalidate(backend, [vehicleVinKey(vin), vehicleOwnerKey(ownerId)]);
      return profile;
    },

    async appendMaintenance(vin, r) {
      const profile = await inner.appendMaintenance(vin, r);
      await invalidate(backend, [vehicleVinKey(vin), vehicleOwnerKey(profile.ownerId)]);
      return profile;
    },

    async appendRepair(vin, r) {
      const profile = await inner.appendRepair(vin, r);
      await invalidate(backend, [vehicleVinKey(vin), vehicleOwnerKey(profile.ownerId)]);
      return profile;
    },

    /*
     * ⚠️ **透传每一个参数**。这里漏掉 `source` 实测过一次（M26-04 真跑）：
     * 装配层注入的是这个缓存包装，而它的签名少一个参数——于是补录写进去的
     * 里程来源全程为空，档案里里程对了、保养记录的 source 也对了，唯独里程的
     * 来源是 null，而**没有任何东西会报错**。包装层的形状必须跟着被包装的接口走。
     */
    async advanceOdometer(vin, km, source) {
      const profile = await inner.advanceOdometer(vin, km, source);
      await invalidate(backend, [vehicleVinKey(vin), vehicleOwnerKey(profile.ownerId)]);
      return profile;
    },
  };
}
