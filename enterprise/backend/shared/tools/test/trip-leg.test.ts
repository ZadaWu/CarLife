/**
 * 出发段（屏底状态栏三格）：路况按里程加权、缓存键不带用户维度、拿不到就没有。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { setAmapClient, type AmapClient, type AmapPath } from "../src/amap";
import { resetEnvCacheStats, setEnvCache } from "../src/env-cache";
import { computeTripLeg, roadCondition, roadLabel } from "../src/trip-leg";

afterEach(() => {
  setAmapClient(undefined);
  setEnvCache(undefined);
  resetEnvCacheStats();
});

describe("roadCondition：按里程加权，不数段数", () => {
  it("城里两百段短畅通 + 高速一段十公里拥堵 → 拥堵", () => {
    const tmcs = [
      ...Array.from({ length: 200 }, () => ({ status: "畅通", distanceM: 40 })), // 8 km
      { status: "拥堵", distanceM: 10_000 },
    ];
    assert.equal(roadCondition(tmcs), "拥堵");
  });
  it("拥堵不到一成、缓行两成以上 → 缓行", () => {
    assert.equal(
      roadCondition([
        { status: "畅通", distanceM: 7_000 },
        { status: "缓行", distanceM: 2_500 },
        { status: "严重拥堵", distanceM: 500 },
      ]),
      "缓行",
    );
  });
  it("几乎都畅通 → 畅通；零星缓行不算", () => {
    assert.equal(roadCondition([{ status: "畅通", distanceM: 9_000 }, { status: "缓行", distanceM: 500 }]), "畅通");
  });
  it("未知过半 → 读不到（undefined），不拿畅通冒充好消息", () => {
    assert.equal(roadCondition([{ status: "未知", distanceM: 6_000 }, { status: "畅通", distanceM: 4_000 }]), undefined);
  });
  it("一段都没有 → undefined", () => {
    assert.equal(roadCondition([]), undefined);
  });
});

describe("roadLabel：按收费里程占比分路型", () => {
  it("六成以上收费 → 高速；两成以下 → 城区；中间 → 混合", () => {
    assert.equal(roadLabel({ distanceM: 100_000, tollDistanceM: 80_000 }), "高速");
    assert.equal(roadLabel({ distanceM: 20_000, tollDistanceM: 0 }), "城区");
    assert.equal(roadLabel({ distanceM: 50_000, tollDistanceM: 20_000 }), "混合");
  });
});

function fakePath(over: Partial<AmapPath> = {}): AmapPath {
  return {
    distanceM: 599_922,
    durationS: 24_868,
    tollYuan: 279,
    tollDistanceM: 518_806,
    trafficLights: 13,
    steps: [
      { instruction: "", distanceM: 599_922, durationS: 24_868, points: [], tmcs: [{ status: "畅通", distanceM: 599_922 }] },
    ],
    ...over,
  };
}

function fakeAmap(calls: { geocode: number; driving: number }): AmapClient {
  return {
    async geocode(address) {
      calls.geocode += 1;
      return { name: address, adcode: "330100", city: "杭州市", lat: 30.2875, lon: 120.1536 };
    },
    async driving() {
      calls.driving += 1;
      return fakePath();
    },
  } as unknown as AmapClient;
}

function memoryCache() {
  const store = new Map<string, { v: string; ttl: number }>();
  return {
    store,
    backend: {
      async get(k: string) {
        return store.get(k)?.v ?? null;
      },
      async set(k: string, v: string, ttl: number) {
        store.set(k, { v, ttl });
      },
    },
  };
}

describe("computeTripLeg", () => {
  it("未接入高德 → undefined（状态栏显示暂无），不编数", async () => {
    assert.equal(await computeTripLeg({ origin: "浙江杭州", destination: { lat: 34.26, lon: 117.18 } }), undefined);
  });

  it("地名起点：里程 / 用时 / 路况都来自高德回包，单位换算成公里与分钟", async () => {
    const calls = { geocode: 0, driving: 0 };
    setAmapClient(fakeAmap(calls));
    const leg = await computeTripLeg({ origin: "浙江杭州", destination: { lat: 34.2618, lon: 117.1849 } });
    assert.ok(leg);
    assert.equal(leg.distanceKm, 599.9);
    assert.equal(leg.durationMin, 414);
    assert.deepEqual(leg.road, { label: "高速", status: "畅通" });
    assert.equal(calls.geocode, 1);
    assert.equal(calls.driving, 1);
  });

  it("⑤缓存：地名→坐标 1h、规划 3 分钟；键不含用户维度；三次轮询只打一次高德", async () => {
    const calls = { geocode: 0, driving: 0 };
    setAmapClient(fakeAmap(calls));
    const { store, backend } = memoryCache();
    setEnvCache(backend);
    const input = { origin: "浙江杭州", destination: { lat: 34.2618, lon: 117.1849 } };
    await computeTripLeg(input);
    await computeTripLeg(input);
    await computeTripLeg(input);
    assert.equal(calls.geocode, 1, "地名坐标应命中缓存");
    assert.equal(calls.driving, 1, "规划应命中缓存");
    const keys = [...store.keys()];
    assert.ok(keys.some((k) => k.includes(":geocode:")), "有 geocode 命名空间的键");
    assert.ok(keys.some((k) => k.includes(":leg:")), "有 leg 命名空间的键");
    for (const k of keys) assert.ok(!/user|plan|session/i.test(k), `键里不许带用户 / 行程维度：${k}`);
    const ttls = Object.fromEntries([...store.entries()].map(([k, e]) => [k.split(":")[2], e.ttl]));
    assert.equal(ttls.geocode, 60 * 60);
    assert.equal(ttls.leg, 3 * 60);
  });

  it("未知路段过半 → 有里程用时、没有 road（那一格显示读不到）", async () => {
    setAmapClient({
      async geocode() {
        return { name: "x", adcode: "", city: "", lat: 30, lon: 120 };
      },
      async driving() {
        return fakePath({
          steps: [
            { instruction: "", distanceM: 10_000, durationS: 600, points: [], tmcs: [{ status: "未知", distanceM: 7_000 }, { status: "畅通", distanceM: 3_000 }] },
          ],
        });
      },
    } as unknown as AmapClient);
    const leg = await computeTripLeg({ origin: { lat: 30, lon: 120 }, destination: { lat: 31, lon: 121 } });
    assert.ok(leg);
    assert.equal(leg.road, undefined);
    assert.equal(leg.distanceKm, 599.9);
  });
});
