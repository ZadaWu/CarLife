/**
 * [F-18-05] 插点位置按里程在取样点之间插值，不吸附到最近的取样点
 * （行程详情「沿途服务」数据源交接，缺陷 3）。
 *
 * 73 次真实调用里 12 次 route 只传了起终点，插点被吸附到起点或终点的城区；
 * 传满 8 个点时 352km 的路误差也有 ±25km。这里钉住：两点之间的位置按里程线性插，
 * 越界钳到两端，charging 与 refuel 的搜索中心都是插出来的点而不是某个取样点。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LngLat } from "../src/amap";
import { createChargingTool, pointAlongRoute } from "../src/charging";
import { createRefuelTool } from "../src/refuel";

// 沿纬线 23° 从 113° 到 116°：每 1° 经度约 102km，全程约 306km。
const ROUTE = [
  { name: "起点", lat: 23, lon: 113 },
  { name: "终点", lat: 23, lon: 116 },
];
const ctx = { sessionId: "s", turnId: "t", agent: "drive" } as never;

describe("pointAlongRoute", () => {
  const cum = [0, 100, 300];
  const route = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 0, lon: 3 },
  ];

  it("段内按里程线性插值", () => {
    assert.deepEqual(pointAlongRoute(route, cum, 50), { lat: 0, lon: 0.5 });
    assert.deepEqual(pointAlongRoute(route, cum, 200), { lat: 0, lon: 2 });
  });

  it("越界钳到两端；正好落在取样点上就是那个点", () => {
    assert.deepEqual(pointAlongRoute(route, cum, -5), { lat: 0, lon: 0 });
    assert.deepEqual(pointAlongRoute(route, cum, 999), { lat: 0, lon: 3 });
    assert.deepEqual(pointAlongRoute(route, cum, 100), { lat: 0, lon: 1 });
  });
});

describe("charging / refuel 的搜索中心是插值点", () => {
  it("只传起终点、续航 250km 满电出发：插点在约 212km 处，搜索中心落在路中间而不是起点或终点", async () => {
    const centers: LngLat[] = [];
    const tool = createChargingTool({
      around: async (at) => {
        centers.push(at);
        return [];
      },
    });
    // 可用里程 = (1 - 0.15) × 250 = 212.5km < 306km → 一个插点。
    const r = await tool.call({ route: ROUTE, rangeKm: 250, startSoc: 1 }, ctx);
    assert.equal(r.data.stops.length, 1);
    assert.equal(centers.length, 1);
    const at = centers[0]!;
    assert.ok(at.lon > 114.5 && at.lon < 115.5, `搜索中心应在路中段，实际 lon=${at.lon}`);
    assert.ok(Math.abs(at.lat - 23) < 1e-9);
  });

  it("refuel 每 100km 取点：三个搜索中心各不相同且都在两端之间", async () => {
    const centers: LngLat[] = [];
    const tool = createRefuelTool({
      around: async (at) => {
        centers.push(at);
        return [];
      },
    });
    await tool.call({ route: ROUTE, everyKm: 100 }, ctx);
    assert.equal(centers.length, 3, "306km 每 100km 取 100 / 200 / 300");
    const lons = centers.map((c) => c.lon);
    assert.deepEqual([...new Set(lons)].length, 3, "不再全部吸附到同一个取样点");
    for (const lon of lons) assert.ok(lon > 113 && lon < 116);
    assert.ok(lons[0]! < lons[1]! && lons[1]! < lons[2]!, "按行进顺序递增");
  });
});
