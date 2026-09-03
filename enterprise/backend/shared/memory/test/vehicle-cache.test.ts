/**
 * ④档案读缓存单测（施工单 M14-01，F-23-13）。零依赖、不连库。
 *
 * 核心不变量：**任何写操作后紧接读，结果与直连库一致**——
 * 缓存只许影响读延迟，不许影响读到的值。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  createCachedVehicleStore,
  getVehicleCacheStats,
  resetVehicleCacheStats,
  vehicleOwnerKey,
  vehicleVinKey,
  type VehicleCacheBackend,
} from "../src/vehicle-cache";
import type { MaintenanceRecord, VehicleProfile, VehicleStore } from "../src/vehicle-store";

const VIN = "LSVAA49P4E2123456";
const VIN2 = "LSVAA49P4E2123457";
const OWNER = "user-1";

function makeProfile(overrides: Partial<VehicleProfile> = {}): VehicleProfile {
  return {
    vin: VIN,
    ownerId: OWNER,
    model: "测试车型",
    modelYear: 2024,
    purchasedAt: Date.UTC(2024, 0, 1),
    odometerKm: 10_000,
    maintenance: [],
    repairs: [],
    updatedAt: Date.UTC(2026, 0, 1),
    ...overrides,
  };
}

/** 内存后端：支持 TTL（用逻辑时钟）与按需注错。 */
function makeBackend(clock: { now: number }) {
  const rows = new Map<string, { value: string; expiresAt: number }>();
  const failing = { get: false, set: false, del: false };
  const backend: VehicleCacheBackend = {
    async get(key) {
      if (failing.get) throw new Error("backend down");
      const row = rows.get(key);
      if (!row || row.expiresAt <= clock.now) return null;
      return row.value;
    },
    async set(key, value, ttlSeconds) {
      if (failing.set) throw new Error("backend down");
      rows.set(key, { value, expiresAt: clock.now + ttlSeconds * 1000 });
    },
    async del(keys) {
      if (failing.del) throw new Error("backend down");
      for (const key of keys) rows.delete(key);
    },
  };
  return { backend, rows, failing };
}

/** 内存版真相源：行为对齐 `repositories/vehicle.ts` 的可观察语义。 */
function makeInnerStore() {
  const byVin = new Map<string, VehicleProfile>();
  const calls = { get: 0, listByOwner: 0 };
  const store: VehicleStore = {
    async get(vin) {
      calls.get += 1;
      return byVin.get(vin) ?? null;
    },
    async listByOwner(ownerId) {
      calls.listByOwner += 1;
      return [...byVin.values()].filter((p) => p.ownerId === ownerId);
    },
    async upsert(p) {
      byVin.set(p.vin, { ...p });
    },
    async setDefault(_ownerId, vin) {
      const p = byVin.get(vin);
      if (!p) throw new Error("not found");
      return p;
    },
    async appendMaintenance(vin, r: MaintenanceRecord) {
      const p = byVin.get(vin);
      if (!p) throw new Error("not found");
      const next = { ...p, maintenance: [...p.maintenance, r] };
      byVin.set(vin, next);
      return next;
    },
    async appendRepair(vin, r) {
      const p = byVin.get(vin);
      if (!p) throw new Error("not found");
      const next = { ...p, repairs: [...p.repairs, r] };
      byVin.set(vin, next);
      return next;
    },
    async advanceOdometer(vin, km) {
      const p = byVin.get(vin);
      if (!p) throw new Error("not found");
      const next = { ...p, odometerKm: Math.max(p.odometerKm, km) };
      byVin.set(vin, next);
      return next;
    },
  };
  return { store, calls, byVin };
}

describe("④档案读缓存（F-23-13）", () => {
  beforeEach(() => resetVehicleCacheStats());

  it("读 miss 回源，二读命中缓存不再落库", async () => {
    const clock = { now: 0 };
    const { backend } = makeBackend(clock);
    const inner = makeInnerStore();
    await inner.store.upsert(makeProfile());
    const cached = createCachedVehicleStore(inner.store, backend);

    const first = await cached.get(VIN);
    const second = await cached.get(VIN);
    assert.equal(first?.vin, VIN);
    assert.deepEqual(second, first);
    assert.equal(inner.calls.get, 1, "二读应命中缓存");
    const stats = getVehicleCacheStats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
  });

  it("**写后立即可见**：追加保养后紧接读拿到新记录", async () => {
    const clock = { now: 0 };
    const { backend } = makeBackend(clock);
    const inner = makeInnerStore();
    await inner.store.upsert(makeProfile());
    const cached = createCachedVehicleStore(inner.store, backend);

    await cached.get(VIN); // 灌热缓存
    await cached.appendMaintenance(VIN, {
      at: Date.UTC(2026, 5, 1),
      odometerKm: 12_000,
      items: "常规保养",
      source: "4S",
    });
    const after = await cached.get(VIN);
    assert.equal(after?.maintenance.length, 1, "写后读必须与库一致，不许读到失效前的旧值");
  });

  it("setDefault 后 listByOwner 立即回源（列表 key 被失效）", async () => {
    const clock = { now: 0 };
    const { backend, rows } = makeBackend(clock);
    const inner = makeInnerStore();
    await inner.store.upsert(makeProfile());
    await inner.store.upsert(makeProfile({ vin: VIN2 }));
    const cached = createCachedVehicleStore(inner.store, backend);

    await cached.listByOwner(OWNER); // 灌热
    assert.ok(rows.has(vehicleOwnerKey(OWNER)));
    await cached.setDefault(OWNER, VIN2);
    assert.equal(rows.has(vehicleOwnerKey(OWNER)), false, "owner 列表 key 应被删除");
    assert.equal(rows.has(vehicleVinKey(VIN2)), false, "目标 vin key 应被删除");
    await cached.listByOwner(OWNER);
    assert.equal(inner.calls.listByOwner, 2, "失效后必须回源");
  });

  it("TTL 过期后回源", async () => {
    const clock = { now: 0 };
    const { backend } = makeBackend(clock);
    const inner = makeInnerStore();
    await inner.store.upsert(makeProfile());
    const cached = createCachedVehicleStore(inner.store, backend, 60);

    await cached.get(VIN);
    clock.now += 61_000;
    await cached.get(VIN);
    assert.equal(inner.calls.get, 2);
  });

  it("空结果不缓存：建档后立即可查，不用等 TTL", async () => {
    const clock = { now: 0 };
    const { backend } = makeBackend(clock);
    const inner = makeInnerStore();
    const cached = createCachedVehicleStore(inner.store, backend);

    assert.equal(await cached.get(VIN), null);
    assert.deepEqual(await cached.listByOwner(OWNER), []);
    await inner.store.upsert(makeProfile()); // 模拟别的路径建档（未经本包装）
    assert.equal((await cached.get(VIN))?.vin, VIN, "null 不该被缓存住");
    assert.equal((await cached.listByOwner(OWNER)).length, 1, "空列表不该被缓存住");
  });

  it("后端读故障：降级直连、不失败、degraded 计数", async () => {
    const clock = { now: 0 };
    const { backend, failing } = makeBackend(clock);
    const inner = makeInnerStore();
    await inner.store.upsert(makeProfile());
    const cached = createCachedVehicleStore(inner.store, backend);

    failing.get = true;
    const p = await cached.get(VIN);
    assert.equal(p?.vin, VIN);
    assert.ok(getVehicleCacheStats().degraded >= 1);
  });

  it("后端删故障：库写成功不回滚、不抛错、degraded 计数", async () => {
    const clock = { now: 0 };
    const { backend, failing } = makeBackend(clock);
    const inner = makeInnerStore();
    await inner.store.upsert(makeProfile());
    const cached = createCachedVehicleStore(inner.store, backend);

    failing.del = true;
    const profile = await cached.advanceOdometer(VIN, 15_000);
    assert.equal(profile.odometerKm, 15_000, "库是真相源，失效失败不影响写结果");
    assert.ok(getVehicleCacheStats().degraded >= 1);
    assert.equal(inner.byVin.get(VIN)?.odometerKm, 15_000);
  });
});
