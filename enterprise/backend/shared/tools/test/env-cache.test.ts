/**
 * ⑤环境缓存（M11-04）。
 *
 * 三个重点，每个都对应一种"看起来在工作其实没有"的结局：
 *  1. **key 里混进个人数据**——命中率归零，而缓存看起来是接着的；
 *  2. **降级被静默吞掉**——"缓存一直没生效"没有任何人会发现；
 *  3. **坐标不取整**——每次 GPS 抖动都是一次 miss，等于没做。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  ENV_TTL,
  envCacheKey,
  getEnvCacheEntry,
  getEnvCacheStats,
  regeoKeyToPoint,
  regeoPointsForAdcode,
  resetEnvCacheStats,
  roundCoord,
  setEnvCache,
  withEnvCache,
  type EnvCacheBackend,
} from "../src/env-cache";

function memoryBackend(): EnvCacheBackend & { store: Map<string, string>; ttls: Map<string, number> } {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    store,
    ttls,
    async get(k) {
      return store.get(k) ?? null;
    },
    async set(k, v, ttl) {
      store.set(k, v);
      ttls.set(k, ttl);
    },
  };
}

const brokenBackend: EnvCacheBackend = {
  async get() {
    throw new Error("redis down");
  },
  async set() {
    throw new Error("redis down");
  },
};

beforeEach(() => {
  setEnvCache(undefined);
  resetEnvCacheStats();
});

describe("命中与未命中", () => {
  it("第一次 miss、第二次 hit，上游只被调一次", async () => {
    setEnvCache(memoryBackend());
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return { temp: 28 };
    };

    const a = await withEnvCache("k1", 60, fetch);
    const b = await withEnvCache("k1", 60, fetch);

    assert.equal(a.cached, false);
    assert.equal(b.cached, true);
    assert.equal(calls, 1, "第二次不该再打上游");
    assert.deepEqual(b.value, { temp: 28 });
  });

  it("TTL 按调用方给的写入——**没有默认值**", async () => {
    const be = memoryBackend();
    setEnvCache(be);
    await withEnvCache("route:x", ENV_TTL.route, async () => 1);
    await withEnvCache("weather:x", ENV_TTL.weatherForecast, async () => 1);
    // 一个默认 TTL 会被无脑复用到变化速度完全不同的数据上，
    // 而路线缓存久了等于给过期路况。
    assert.equal(be.ttls.get("route:x"), 180);
    assert.equal(be.ttls.get("weather:x"), 1800);
    assert.ok(ENV_TTL.route < ENV_TTL.weatherForecast, "路线的 TTL 必须比天气短");
  });

  it("目的地推荐与导览简报按周缓存：2 周（2026-09-02 从 24 小时改来）", () => {
    // 两者内容周级变化、单次又是本仓最贵的外部调用；24 小时时每天第一次点都要重跑搜索。
    const twoWeeks = 14 * 24 * 60 * 60;
    assert.equal(ENV_TTL.destinationHighlights, twoWeeks);
    assert.equal(ENV_TTL.guideBrief, twoWeeks);
    // 其余条目仍按分钟~小时：这两条是刻意的例外，不该被别的工具无脑复用。
    for (const [name, ttl] of Object.entries(ENV_TTL)) {
      if (name === "destinationHighlights" || name === "guideBrief") continue;
      assert.ok(ttl <= 60 * 60, `${name} 的 TTL 不该超过 1 小时`);
    }
  });

  it("未接入后端时照常直连，且**不计入降级**", async () => {
    let calls = 0;
    const r = await withEnvCache("k", 60, async () => {
      calls += 1;
      return 1;
    });
    assert.equal(r.cached, false);
    assert.equal(calls, 1);
    // 未接入是明确的部署选择，不是故障——混进降级计数会让真正的故障被淹没。
    assert.equal(getEnvCacheStats().degraded, 0);
  });
});

describe("**降级不失败，但要计数**", () => {
  it("Redis 挂了仍返回上游结果", async () => {
    setEnvCache(brokenBackend);
    const r = await withEnvCache("k", 60, async () => ({ ok: true }));
    assert.deepEqual(r.value, { ok: true });
    assert.equal(r.cached, false);
  });

  it("降级次数被记下来——静默的话「缓存一直没生效」没人会发现", async () => {
    setEnvCache(brokenBackend);
    await withEnvCache("k", 60, async () => 1);
    assert.ok(getEnvCacheStats().degraded > 0);
  });

  it("写失败不影响本次结果", async () => {
    const be = memoryBackend();
    setEnvCache({ get: be.get, async set() { throw new Error("write fail"); } });
    const r = await withEnvCache("k", 60, async () => "value");
    assert.equal(r.value, "value");
  });
});

describe("**key 不含个人数据**", () => {
  it("只由命名空间与位置构成", () => {
    const key = envCacheKey("weather", [31.23, 121.47, "2026-08-22"]);
    assert.match(key, /^carlife:env:weather:/);
    for (const forbidden of ["demo-user", "userId", "sess-", "VIN"]) {
      assert.ok(!key.includes(forbidden), `key 里不得出现 ${forbidden}：${key}`);
    }
  });

  it("同一地点对不同用户是同一个 key——带上用户维度会让命中率归零", () => {
    const a = envCacheKey("weather", [31.23, 121.47]);
    const b = envCacheKey("weather", [31.23, 121.47]);
    assert.equal(a, b);
  });
});

describe("坐标取整", () => {
  it("~1km 内视为同一点——不取整的话每次 GPS 抖动都是一次 miss", () => {
    assert.equal(roundCoord(31.23456), 31.23);
    assert.equal(roundCoord(31.23111), 31.23);
    assert.equal(envCacheKey("w", [roundCoord(31.23456)]), envCacheKey("w", [roundCoord(31.23111)]));
  });

  it("超过 ~1km 就是不同的点", () => {
    assert.notEqual(roundCoord(31.23), roundCoord(31.25));
  });
});

describe("单条详情（控制台弹窗，M-mem-cache-detail）", () => {
  function detailBackend() {
    const be = memoryBackend();
    const ttls = be.ttls;
    return Object.assign(be, {
      async entry(k: string) {
        const v = be.store.get(k);
        return v === undefined ? null : { value: v, ttlSeconds: ttls.get(k) ?? -1 };
      },
      async list({ namespace }: { namespace?: string }) {
        const keys = [...be.store.keys()].filter((k) => !namespace || k.includes(`:${namespace}:`));
        return {
          entries: keys.map((key) => ({ key, namespace: namespace ?? "", ttlSeconds: 1, sizeBytes: 1, preview: "" })),
          total: keys.length,
          totalAll: be.store.size,
          truncated: false,
          namespaces: [],
        };
      },
    });
  }

  it("未接入 / 后端不支持 → undefined；键不存在 → null——两种「没有」不合并", async () => {
    assert.equal(await getEnvCacheEntry("x"), undefined);
    setEnvCache(memoryBackend()); // 没实现 entry()
    assert.equal(await getEnvCacheEntry("x"), undefined);
    setEnvCache(detailBackend());
    assert.equal(await getEnvCacheEntry("x"), null);
  });

  it("给完整值（解析后的 JSON）、命名空间与 TTL，不是 200 字符预览", async () => {
    const be = detailBackend();
    setEnvCache(be);
    const key = envCacheKey("guide-brief", ["杭州", "灵隐寺"]);
    const big = { spot: "灵隐寺", spots: Array.from({ length: 40 }, (_, i) => ({ name: `点位${i}` })) };
    await withEnvCache(key, ENV_TTL.guideBrief, async () => big);
    const d = await getEnvCacheEntry(key);
    assert.ok(d);
    assert.equal(d.namespace, "guide-brief");
    assert.equal(d.ttlSeconds, ENV_TTL.guideBrief);
    assert.deepEqual(d.value, big);
    assert.ok(d.sizeBytes > 200, "全值必须比预览长——否则拿的还是预览");
  });

  it("非 JSON 的值原样给出，不吞", async () => {
    const be = detailBackend();
    setEnvCache(be);
    be.store.set("carlife:env:regeo:1:2", "not json");
    const d = await getEnvCacheEntry("carlife:env:regeo:1:2");
    assert.equal(d?.value, "not json");
  });

  it("regeo 键 → 坐标；不合规则的键给 undefined", () => {
    assert.deepEqual(regeoKeyToPoint("carlife:env:regeo:23.18:113.3"), { lat: 23.18, lon: 113.3 });
    assert.equal(regeoKeyToPoint("carlife:env:amap-forecast:440104"), undefined);
    assert.equal(regeoKeyToPoint("carlife:env:regeo:abc:1"), undefined);
  });

  it("按 adcode 反查逆地理点：坐标来自键、行政区来自值，别的 adcode 不混进来", async () => {
    const be = detailBackend();
    setEnvCache(be);
    be.store.set(
      envCacheKey("regeo", [23.18, 113.3]),
      JSON.stringify({ adcode: "440111", city: "广州市", district: "白云区", formatted: "白云山" }),
    );
    be.store.set(
      envCacheKey("regeo", [23.13, 113.26]),
      JSON.stringify({ adcode: "440104", city: "广州市", district: "越秀区", formatted: "越秀公园" }),
    );
    be.store.set(envCacheKey("regeo", [23.14, 113.27]), "broken");
    const pts = await regeoPointsForAdcode("440104");
    assert.deepEqual(pts, [{ lat: 23.13, lon: 113.26, district: "越秀区", formatted: "越秀公园" }]);
    // 反查不到是正常结果：空数组，不是 undefined（那是"后端不支持"）
    assert.deepEqual(await regeoPointsForAdcode("999999"), []);
  });
});
