/**
 * 休息点插点与沿途取样点**落在路线中间**，而不是被长 step 吸到末尾。
 *
 * 这条回归守的是 turn-54929566：高德 v5 把整段高速合成一条 step（实测
 * 上海→江宁区 321km 里有一条从 35.4km 盖到 279.7km），而 `walk()` 当时只在
 * 每个 step 的终点落游标，于是 41~206 分钟之间任何插点都被吸到 206 分钟。
 *
 * **它全程不报错**：restStops 照样有一条、天气取样点照样有五个、方案照样成立，
 * 只是休息点插在离终点 40km 处、五个取样点是同一个坐标。修复轮把上限从 180
 * 收紧到 90 之后三个插点仍落在同一位置，模型两轮都只看到同一个服务区，
 * 如实回报"线路数据里没有更密的服务区"——而车主在高德上看得见八个。
 *
 * 所以判据必须打在**插点的位置**上，不能打在"有没有返回休息点"上：
 * 后者在坏掉的实现上同样为真。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createAmapClient, setAmapClient } from "../src/amap";
import { mapRouteTool } from "../src/map-route";
import type { ToolCallContext } from "../src/external";

const ctx: ToolCallContext = { sessionId: "sess-anchor", agent: "drive" };

function stubFetch(routes: Array<[string, unknown]>) {
  const impl = (async (input: URL | RequestInfo) => {
    const url = String(input);
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) throw new Error("stub 没有为 " + url + " 准备响应");
    return { ok: true, status: 200, json: async () => hit[1] } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl };
}

/** 折线：沿纬度 31.5 从 lon0 等距走到 lon1，共 n 个点。 */
function line(lon0: number, lon1: number, n: number): string {
  return Array.from({ length: n }, (_, i) => {
    const lon = lon0 + ((lon1 - lon0) * i) / (n - 1);
    return lon.toFixed(5) + ",31.50000";
  }).join(";");
}

/**
 * 一条 300km / 240 分钟的路：先 12km 市区（折线只有一个点，高德对短 step 就是这样），
 * 再**一条 288km / 230 分钟的高速 step**——后者正是把插点吸走的那种 step。
 */
function longHighwayDriving() {
  return {
    status: "1",
    infocode: "10000",
    route: {
      paths: [
        {
          distance: "300000",
          cost: { duration: "14400", tolls: "142", traffic_lights: "7" },
          steps: [
            { instruction: "市区段", step_distance: "12000", cost: { duration: "600" }, polyline: "121.00000,31.50000" },
            { instruction: "沿高速行驶288千米", step_distance: "288000", cost: { duration: "13800" }, polyline: line(121.0, 118.5, 101) },
          ],
        },
      ],
    },
  };
}

/**
 * 两个服务区，都压在路线上（纬度 31.502，路线是 31.5），分别落在 80 分钟与 160 分钟插点附近。
 *
 * 要两个是因为同一个服务区不会重复占两个插点——只放一个的话第二个插点会空手而归，
 * 那考的是去重不是插点位置。
 */
function around(...pois: Array<{ id: string; name: string; typecode: string; lon: number }>) {
  return {
    status: "1",
    infocode: "10000",
    pois: pois.map((p) => ({
      id: p.id,
      name: p.name,
      type: "道路附属设施;服务区;高速服务区",
      typecode: p.typecode,
      address: "沪蓉高速",
      cityname: "苏州市",
      location: p.lon.toFixed(4) + ",31.5020",
      distance: "220",
    })),
  };
}

const OK_AROUND = around(
  { id: "B001", name: "甲服务区", typecode: "180300", lon: 120.24 }, // ≈ 第 80 分钟
  { id: "B002", name: "乙服务区", typecode: "180300", lon: 119.37 }, // ≈ 第 160 分钟
  { id: "B003", name: "丙服务区", typecode: "180300", lon: 119.804 }, // ≈ 第 120 分钟
);

const ORIGIN = { lat: 31.5, lon: 121.0, name: "上海" };
const DESTINATION = { lat: 31.5, lon: 118.5, name: "江宁区" };

function wire(): void {
  const { impl } = stubFetch([
    ["/v5/direction/driving", longHighwayDriving()],
    ["/v5/place/around", OK_AROUND],
  ]);
  setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));
}

afterEach(() => setAmapClient(undefined));

describe("[F-18-04][F-18-07] 长 step 不把插点吸到末尾", () => {
  it("[F-18-04] 240 分钟的路配 180 分钟上限：插点落在第 120 分钟上下，不是终点那一头", async () => {
    wire();
    const r = await mapRouteTool.call(
      { origin: ORIGIN, destination: DESTINATION, maxLegMinutes: 180 },
      ctx,
    );
    assert.equal(r.data.restStops.length, 1);
    const stop = r.data.restStops[0]!;
    // 坏掉的实现给的是 240（第二条 step 的终点）——判据要能把这两种情况分开。
    assert.equal(stop.name, "丙服务区", "该挑离插点最近的那个");
    assert.ok(stop.atMinute >= 110 && stop.atMinute <= 130, "应在 120 分钟附近，实际 " + stop.atMinute);
    assert.ok(stop.atMinute <= 180, "停靠点必须落在单段上限之内");
  });

  it("[F-18-04][F-18-07] 收紧上限就该多出插点，且两个插点互不相同", async () => {
    wire();
    const r = await mapRouteTool.call(
      { origin: ORIGIN, destination: DESTINATION, maxLegMinutes: 80 },
      ctx,
    );
    // 240 / 80 = 3 段 → 2 个插点
    assert.equal(r.data.restStops.length, 2);
    const mins = r.data.restStops.map((s) => s.atMinute);
    assert.notEqual(mins[0], mins[1], "两个插点落在同一处 = 长 step 又把它们吸到一起了");
    assert.ok(mins[0]! >= 70 && mins[0]! <= 90, "第一个停靠点应在 80 分钟附近，实际 " + mins[0]);
    assert.ok(mins[1]! >= 150 && mins[1]! <= 170, "第二个停靠点应在 160 分钟附近，实际 " + mins[1]);
    assert.deepEqual(r.data.restStops.map((s) => s.name), ["甲服务区", "乙服务区"]);
  });

  it("[F-18-03] 沿途取样点铺满全程 —— weather 吃的是它，挤在一处等于全程只查了一个地方的天气", async () => {
    wire();
    const r = await mapRouteTool.call(
      { origin: ORIGIN, destination: DESTINATION, samplePoints: 5 },
      ctx,
    );
    const pts = r.data.sampledPoints;
    assert.equal(pts.length, 5);
    assert.equal(pts[0]!.name, "上海");
    assert.equal(pts[4]!.name, "江宁区");
    for (let i = 1; i < pts.length; i += 1) {
      assert.ok(pts[i]!.atKm > pts[i - 1]!.atKm, "取样点必须沿路线严格前进，第 " + i + " 个没有");
    }
    // 中间三个点也必须是不同的坐标，而不是同一个点重复三次。
    assert.equal(new Set(pts.map((p) => p.lon.toFixed(4))).size, 5);
  });

  it("[F-18-04] 折线只有一个点的 step 也照样走得通：游标退回 step 端点，位置仍落在半程", async () => {
    // 12 段各 10km/10min、折线各一个点 —— 与 amap.test.ts 的 fakeDriving 同形。
    const steps = Array.from({ length: 12 }, (_, i) => ({
      instruction: "第 " + (i + 1) + " 段",
      step_distance: "10000",
      cost: { duration: "600" },
      polyline: (114 + i * 0.1).toFixed(4) + "," + (22.5 + i * 0.05).toFixed(4),
    }));
    const { impl } = stubFetch([
      [
        "/v5/direction/driving",
        {
          status: "1",
          infocode: "10000",
          route: { paths: [{ distance: "120000", cost: { duration: "7200", tolls: "68", traffic_lights: "10" }, steps }] },
        },
      ],
      [
        "/v5/place/around",
        {
          status: "1",
          infocode: "10000",
          // 压在这条折线第 6 个端点（114.5,22.75）旁边约 1km 处
          pois: [
            {
              id: "B009",
              name: "厚街服务区",
              type: "道路附属设施;服务区;高速服务区",
              typecode: "180300",
              address: "京港澳高速",
              cityname: "东莞市",
              location: "114.5100,22.7520",
              distance: "1050",
            },
          ],
        },
      ],
    ]);
    setAmapClient(createAmapClient({ key: "k", fetchImpl: impl }));
    const r = await mapRouteTool.call(
      { origin: { lat: 22.55, lon: 114.05, name: "深圳" }, destination: { lat: 23.13, lon: 113.26, name: "广州" }, maxLegMinutes: 90 },
      ctx,
    );
    assert.equal(r.data.restStops.length, 1);
    // 游标只有 12 个（每个 step 一个），但位置取的是**垂足**而不是最近的那个游标，
    // 所以会带一点段内插值——60~61 都对，120（终点）才是坏掉的那种。
    const at = r.data.restStops[0]!.atMinute;
    assert.ok(at >= 58 && at <= 62, "应落在半程 60 分钟附近，实际 " + at);
  });
});
