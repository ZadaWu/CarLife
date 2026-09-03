/**
 * `refuel` 单测。
 *
 * 这个工具最容易做错的地方不是查不到站，是**替它编出一个它没有的能力**：
 * 照着 `charging` 的样子按"续航"插点，产出一串看起来很专业的"建议加油里程"。
 * 那需要油量和油耗，两个都没有。所以这里的断言重点是
 * **结构上不给模型编造的落点**，而不只是"能返回结果"。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AmapPoi, LngLat } from "../src/amap";
import {
  DEFAULT_EVERY_KM,
  FUEL_NOTICE,
  MAX_SAMPLE_POINTS,
  createRefuelTool,
  parseBrand,
  planSamplePoints,
  type RefuelBackend,
} from "../src/refuel";

const ctx = { sessionId: "s-refuel" };

/** 上海 → 南京方向的一串点，约每 50km 一个。 */
function route(n: number) {
  return Array.from({ length: n }, (_, i) => ({ lat: 31.23 + i * 0.45, lon: 121.47 - i * 0.5 }));
}

function fakeBackend(perPoint: number): RefuelBackend & { calls: LngLat[] } {
  const calls: LngLat[] = [];
  return {
    calls,
    async around(at) {
      calls.push(at);
      return Array.from({ length: perPoint }, (_, i) => ({
        id: `poi-${calls.length}-${i}`,
        name: i === 0 ? "中国石化 阳澄湖服务区加油站" : "某加油站",
        type: "加油站",
        typecode: "010100",
        address: "某路 1 号",
        cityName: "苏州",
        lat: at.lat,
        lon: at.lon,
        distanceM: 300 + i * 100,
      })) as AmapPoi[];
    },
  };
}

describe("沿线取点", () => {
  it("**不含任何油量假设**——取点只由总里程与间隔决定", () => {
    assert.deepEqual(planSamplePoints(350, 100), [100, 200, 300]);
    // 同样的路线换个间隔，结果只随间隔变；没有第三个变量能影响它。
    assert.deepEqual(planSamplePoints(350, 150), [150, 300]);
  });

  it("短途不取点——总里程不足一个间隔时返回空", () => {
    assert.deepEqual(planSamplePoints(80, 100), []);
  });

  it("跨省长途也不返回几十组——那是把筛选推给模型", () => {
    const pts = planSamplePoints(5_000, 100);
    assert.equal(pts.length, MAX_SAMPLE_POINTS);
  });

  it("间隔非正数直接报错，不静默兜底成默认值", () => {
    assert.throws(() => planSamplePoints(300, 0), /间隔必须为正数/);
  });
});

describe("品牌解析", () => {
  it("认得出就给，认不出留空——**不猜**", () => {
    assert.equal(parseBrand("中国石化 阳澄湖服务区加油站"), "中国石化");
    assert.equal(parseBrand("阳澄湖服务区加油站"), undefined);
  });
});

describe("结果形状：不给编造留落点", () => {
  it("**返回类型里没有「还能跑多远」这类字段**，且油量恒为不可知", async () => {
    const backend = fakeBackend(2);
    const tool = createRefuelTool(backend);
    const { data: r } = await tool.call({ route: route(12) }, ctx);

    assert.equal(r.fuelLevelUnknown, true);
    assert.equal(r.fuelNotice, FUEL_NOTICE);

    const asRecord = r as unknown as Record<string, unknown>;
    for (const forbidden of ["rangeKm", "remainingKm", "startSoc", "needsRefuel", "fuelCost"]) {
      assert.equal(asRecord[forbidden], undefined, `不该存在的字段：${forbidden}`);
    }
  });

  it("atKm 是「路过这里」——查询点数与取点算法一致，与候选站多少无关", async () => {
    const backend = fakeBackend(3);
    const tool = createRefuelTool(backend);
    const { data: r } = await tool.call({ route: route(12), everyKm: 100 }, ctx);

    assert.equal(backend.calls.length, r.stops.length);
    assert.ok(r.stops.length > 0, "这条路线应该长于一个取点间隔");
    for (const s of r.stops) assert.equal(s.candidates.length, 3);
  });

  it("默认间隔是显式常量，不是散落的魔数", async () => {
    const backend = fakeBackend(1);
    const tool = createRefuelTool(backend);
    const { data: withDefault } = await tool.call({ route: route(12) }, ctx);
    const { data: explicit } = await tool.call(
      { route: route(12), everyKm: DEFAULT_EVERY_KM },
      ctx,
    );
    assert.deepEqual(
      withDefault.stops.map((s) => s.atKm),
      explicit.stops.map((s) => s.atKm),
    );
  });

  it("路线点不足两个直接报错", async () => {
    const tool = createRefuelTool(fakeBackend(1));
    await assert.rejects(
      () => tool.call({ route: [{ lat: 31, lon: 121 }] }, ctx),
      /至少需要两个取样点/,
    );
  });
});
