/**
 * [F-18-04][F-18-08] `route_services`：停靠点周边的餐饮 / 公厕 / 停车场 / 服务区
 * （行程详情「沿途服务」数据源交接，待执行事项 4）。
 *
 * 钉住交接文档的四条约束里能在工具层验的三条：母婴室不算厕所（约束 2）、
 * 「查过没有」与「没查成」是两种形状（约束 3）、单点失败只记账不中断且串行发（约束 4）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AmapPoi } from "../src/amap";
import {
  NURSERY_ROOM_TYPECODE,
  SERVICE_RADIUS_M,
  SERVICE_TYPECODES,
  createRouteServicesTool,
  type RouteServicesBackend,
} from "../src/route-services";

const poi = (id: string, name: string, typecode: string): AmapPoi => ({
  id,
  name,
  type: "",
  typecode,
  address: "",
  cityName: "韶关市",
  lat: 24.9,
  lon: 113.6,
  distanceM: 500,
});

const P1 = { name: "丹霞山", lat: 25.02, lon: 113.74 };
const P2 = { name: "阳元山", lat: 25.05, lon: 113.72 };
const ctx = { sessionId: "s", turnId: "t", agent: "trip" } as never;

describe("route_services：计数口径", () => {
  it("同一个 POI 在两个停靠点的半径里都命中：按 id 去重只算一次；默认四类目（M93-04 起含充电站）", async () => {
    const calls: string[] = [];
    const backend: RouteServicesBackend = {
      async around(_at, typecode) {
        calls.push(typecode);
        if (typecode === SERVICE_TYPECODES.food) return [poi("f1", "山脚农家菜", "050100"), poi("f2", "丹霞小吃", "050100")];
        if (typecode === SERVICE_TYPECODES.parking) return [poi("p1", "景区北门停车场", "150900")];
        return [];
      },
    };
    const r = await createRouteServicesTool(backend).call({ points: [P1, P2] }, ctx);
    assert.equal(r.data.food?.pois.length, 2, "两个点各回同样两条，去重后仍是 2");
    assert.equal(r.data.food?.queriedPoints, 2);
    assert.equal(r.data.parking?.pois.length, 1);
    assert.deepEqual(r.data.restroom, { pois: [], queriedPoints: 2, failedPoints: 0 }, "查过了没有：0 条但 queriedPoints>0");
    assert.deepEqual(r.data.charging, { pois: [], queriedPoints: 2, failedPoints: 0 }, "充电站进了缺省类目");
    assert.equal(r.data.service_area, undefined, "没要的类目不出现");
    assert.equal(calls.length, 8, "2 点 × 4 类目 = 8 次");
  });

  it("[F-18-04] 充电站走 011100、3km 半径——那一格从前读的是 drive 求解出来的补能点，恒显「无需补能」", async () => {
    const seen: Array<{ typecode: string; radiusM: number }> = [];
    const backend: RouteServicesBackend = {
      async around(_at, typecode, radiusM) {
        seen.push({ typecode, radiusM });
        return typecode === SERVICE_TYPECODES.charging ? [poi("c1", "国网充电站(丹霞店)", "011100")] : [];
      },
    };
    const r = await createRouteServicesTool(backend).call({ points: [P1], categories: ["charging"] }, ctx);
    assert.deepEqual(seen, [{ typecode: "011100", radiusM: 3_000 }]);
    assert.equal(SERVICE_RADIUS_M.charging, 3_000);
    assert.equal(r.data.charging?.pois.length, 1);
    assert.equal(r.data.charging?.pois[0]?.name, "国网充电站(丹霞店)");
  });

  it("[F-18-04] 点名老的三类目时行为逐字不变——加类目不影响既有调用", async () => {
    const calls: string[] = [];
    const backend: RouteServicesBackend = {
      async around(_at, typecode) {
        calls.push(typecode);
        return [];
      },
    };
    const r = await createRouteServicesTool(backend).call(
      { points: [P1], categories: ["food", "restroom", "parking"] },
      ctx,
    );
    assert.deepEqual(calls, [SERVICE_TYPECODES.food, SERVICE_TYPECODES.restroom, SERVICE_TYPECODES.parking]);
    assert.equal(r.data.charging, undefined, "没点名就不查，不能悄悄多打一类请求");
  });

  it("母婴室（200304）在 200300 大类里，但不算厕所", async () => {
    const backend: RouteServicesBackend = {
      async around(_at, typecode) {
        if (typecode !== SERVICE_TYPECODES.restroom) return [];
        return [poi("w1", "游客中心公共厕所", "200300"), poi("w2", "母婴室", NURSERY_ROOM_TYPECODE), poi("w3", "无障碍卫生间", "200303")];
      },
    };
    const r = await createRouteServicesTool(backend).call({ points: [P1], categories: ["restroom"] }, ctx);
    assert.deepEqual(r.data.restroom?.pois.map((p) => p.id), ["w1", "w3"]);
  });

  it("单点失败只记账：那一类目仍有结果，failedPoints 计数；全部失败则 queriedPoints=0（展示层当待查）", async () => {
    let n = 0;
    const backend: RouteServicesBackend = {
      async around(_at, typecode) {
        if (typecode === SERVICE_TYPECODES.parking) throw new Error("local_queue");
        n += 1;
        return n % 2 === 0 ? [] : [poi(`f${n}`, `店${n}`, "050100")];
      },
    };
    const r = await createRouteServicesTool(backend).call({ points: [P1, P2], categories: ["food", "parking"] }, ctx);
    assert.equal(r.data.food?.queriedPoints, 2);
    assert.deepEqual(r.data.parking, { pois: [], queriedPoints: 0, failedPoints: 2 });
  });

  it("服务区用 180301 与 8km 半径，与三项日常类目的半径无关", async () => {
    const seen: Array<{ typecode: string; radiusM: number }> = [];
    const backend: RouteServicesBackend = {
      async around(_at, typecode, radiusM) {
        seen.push({ typecode, radiusM });
        return typecode === SERVICE_TYPECODES.service_area ? [poi("sa1", "乳源服务区", "180301")] : [];
      },
    };
    const r = await createRouteServicesTool(backend).call({ points: [P1], categories: ["service_area", "food"], radiusM: 2000 }, ctx);
    assert.deepEqual(seen, [
      { typecode: "180301", radiusM: SERVICE_RADIUS_M.service_area },
      { typecode: "050000", radiusM: 2000 },
    ]);
    assert.deepEqual(r.data.service_area?.pois.map((p) => p.name), ["乳源服务区"]);
    assert.equal(r.data.radiusM, 2000);
  });

  it("串行发：任一时刻只有一个请求在飞（高德闸门排队封顶 6 秒，并发会撞上限）", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const backend: RouteServicesBackend = {
      async around() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return [];
      },
    };
    await createRouteServicesTool(backend).call({ points: [P1, P2] }, ctx);
    assert.equal(maxInFlight, 1);
  });

  it("空点列表与超过 20 个点都当场拒绝；mock 档给固定数据且 queriedPoints=点数", async () => {
    const tool = createRouteServicesTool({ around: async () => [] });
    await assert.rejects(() => tool.call({ points: [] }, ctx), /至少需要一个停靠点/);
    await assert.rejects(() => tool.call({ points: Array.from({ length: 21 }, () => P1) }, ctx), /最多 20 个点/);
    const m = await tool.call({ points: [P1, P2] }, { ...(ctx as object), mode: "mock" } as never);
    assert.equal(m.source.kind, "mock");
    assert.equal(m.data.food?.queriedPoints, 2);
    assert.ok(m.data.food!.pois.every((p) => p.name.includes("模拟")));
    // mock 三态里充电站也得有一份，否则离线跑的那一格恒空——那正是本单要修的症状。
    assert.ok(m.data.charging!.pois.length > 0);
    assert.ok(m.data.charging!.pois.every((p) => p.name.includes("模拟")));
  });
});
