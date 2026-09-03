/**
 * ⑤缓存的两处接线（充电站搜索 / CMA 站点视图）。
 *
 * 这两条以前都没接：`ENV_TTL.charging` 定义了却没人用，CMA 那条天气路径每次
 * 都直连——而架构文档 §9 写的是"环境缓存（天气/充电价）"。
 *
 * 用例盯的不是"缓存生效了"，而是**缓存生效之后不会答错**：
 *  - 半径不同必须是两条键（否则一次大半径搜索会把小半径那次的答案顶掉，
 *    那是给了错的站，不是给了旧的站）；
 *  - 半径小到与坐标取整同量级时干脆不缓存；
 *  - CMA 按站点做键（`nearestStation` 已经把一片区域收敛到同一个站了）。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setAmapClient, type AmapClient, type AmapPoi } from "../src/amap";
import {
  createAmapChargingBackend,
  MIN_CACHEABLE_RADIUS_M,
} from "../src/charging";
import {
  resetEnvCacheStats,
  setEnvCache,
  type EnvCacheBackend,
} from "../src/env-cache";

/** 最小可用的内存后端，够验"第二次没打网络"。 */
function memoryBackend(): EnvCacheBackend {
  const m = new Map<string, string>();
  return {
    async get(k) {
      return m.get(k) ?? null;
    },
    async set(k, v) {
      m.set(k, v);
    },
  };
}

const poi = (id: string): AmapPoi => ({
  id,
  name: `站点 ${id}（120kW）`,
  address: "地址",
  lat: 30,
  lon: 120,
  distanceM: 500,
});

describe("charging：沿线找桩走⑤缓存", () => {
  let calls: Array<{ radiusM: number; lat: number; lon: number }>;

  beforeEach(() => {
    calls = [];
    setEnvCache(memoryBackend());
    resetEnvCacheStats();
    setAmapClient({
      async around({ at, radiusM }) {
        calls.push({ radiusM: radiusM ?? 0, lat: at.lat, lon: at.lon });
        return [poi(`p${calls.length}`)];
      },
    } as unknown as AmapClient);
  });

  afterEach(() => {
    setAmapClient(undefined);
    setEnvCache(undefined);
  });

  it("同一点同一半径第二次不打网络", async () => {
    const be = createAmapChargingBackend();
    await be.around({ lat: 30.123, lon: 120.456 }, 5_000);
    await be.around({ lat: 30.123, lon: 120.456 }, 5_000);
    assert.equal(calls.length, 1);
  });

  it("坐标抖动落在同一个取整格里也命中——不然缓存等于没做", async () => {
    const be = createAmapChargingBackend();
    await be.around({ lat: 30.1231, lon: 120.4562 }, 5_000);
    await be.around({ lat: 30.1234, lon: 120.4559 }, 5_000);
    assert.equal(calls.length, 1);
  });

  it("**半径不同必须重新查**：5km 与 20km 是两个结果集，串了就是给错的站", async () => {
    const be = createAmapChargingBackend();
    await be.around({ lat: 30.12, lon: 120.45 }, 5_000);
    await be.around({ lat: 30.12, lon: 120.45 }, 20_000);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((c) => c.radiusM),
      [5_000, 20_000],
    );
  });

  it("半径小于取整尺度时不缓存——1.1km 的取整误差与半径同量级，串味就是答错", async () => {
    const be = createAmapChargingBackend();
    const small = MIN_CACHEABLE_RADIUS_M - 1;
    await be.around({ lat: 30.12, lon: 120.45 }, small);
    await be.around({ lat: 30.12, lon: 120.45 }, small);
    assert.equal(calls.length, 2, "小半径必须每次直连");
  });

  it("缓存未接入时照常工作（未接入不是故障）", async () => {
    setEnvCache(undefined);
    const be = createAmapChargingBackend();
    const r = await be.around({ lat: 30.12, lon: 120.45 }, 5_000);
    assert.equal(r.length, 1);
    assert.equal(calls.length, 1);
  });
});
