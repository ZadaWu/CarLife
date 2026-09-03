/**
 * poi_search 与 transit_route（施工单 M12-01）。
 *
 * 这组测试守的是**诚实边界**，不是接口封装：
 *  - poi_search 的出参在类型与运行时都不存在价格字段——模型没地方把房价编进来；
 *  - transit_route 只合并真查到的方案，单档失败不补不猜；
 *  - 两者的恒定声明（priceNotice / note）必须在场——表述层靠它们知道边界。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPoiSearchTool, PRICE_NOTICE, type PoiSearchBackend } from "../src/poi-search";
import { createTransitRouteTool, TRANSIT_NOTE, type TransitBackend } from "../src/transit-route";
import { getTool } from "../src/registry";
import type { AmapTextPoi, AmapTransit } from "../src/amap";

const ctx = { sessionId: "t", agent: "hotel", mode: "real" } as never;

function poiBackend(pois: AmapTextPoi[], calls: unknown[] = []): PoiSearchBackend {
  return {
    async textSearch(params) {
      calls.push(params);
      return pois;
    },
  };
}

const POI: AmapTextPoi = {
  id: "B0FF",
  name: "白天鹅宾馆",
  type: "住宿服务",
  typecode: "100101",
  address: "沙面南街1号",
  cityName: "广州",
  province: "广东省",
  district: "荔湾区",
  adcode: "440103",
  lat: 23.107,
  lon: 113.243,
  distanceM: null,
  rating: "4.7",
};

test("poi_search：出参含真实评分、恒带 priceNotice、无价格字段", async () => {
  const tool = createPoiSearchTool(poiBackend([POI]));
  const r = await tool.call({ city: "广州", category: "hotel" }, ctx);
  assert.equal(r.data.candidates[0].name, "白天鹅宾馆");
  assert.equal(r.data.candidates[0].rating, "4.7");
  assert.equal(r.data.priceNotice, PRICE_NOTICE);
  // 运行时也不许溜进价格形状的字段——酒店类目 cost 实测恒空，出现即是编的。
  for (const c of r.data.candidates) {
    const keys = Object.keys(c);
    for (const k of keys) assert.ok(!/price|cost|fee/i.test(k), `不该有价格字段：${k}`);
  }
});

test("poi_search：缺省关键词按类目补，city 空则拒绝", async () => {
  const calls: Array<{ keywords: string }> = [];
  const tool = createPoiSearchTool(poiBackend([POI], calls));
  await tool.call({ city: "广州", category: "attraction" }, ctx);
  assert.equal(calls[0].keywords, "景点");
  await assert.rejects(() => tool.call({ city: "  ", category: "hotel" }, ctx), /city 不能为空/);
});

function transitBackend(byStrategy: Record<number, AmapTransit[] | Error>): TransitBackend {
  return {
    async geocode() {
      return { lat: 31.23, lon: 121.475 };
    },
    async transitIntegrated({ strategy }) {
      const v = byStrategy[strategy] ?? [];
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

const G99: AmapTransit = {
  durationMin: 417,
  costYuan: 793,
  trains: [{ no: "G99(上海虹桥-广州南)", trip: "G99", durationMin: 405, prices: [793, 1264] }],
};
const D941: AmapTransit = {
  durationMin: 771,
  costYuan: 609,
  trains: [{ no: "D941(上海虹桥-珠海)", trip: "D941", durationMin: 658, prices: [860] }],
};

test("transit_route：多策略合并去重、按时长排序、恒带只覆盖火车的声明", async () => {
  const tool = createTransitRouteTool(
    transitBackend({ 0: [D941], 1: [G99, D941], 2: [] }),
  );
  const r = await tool.call({ fromCity: "上海", toCity: "广州" }, ctx);
  assert.equal(r.data.options.length, 2); // D941 在两档出现，只留一份
  assert.equal(r.data.options[0].trains[0], "G99(上海虹桥-广州南)"); // 快的在前
  assert.deepEqual(r.data.options[0].firstLegPrices, [793, 1264]);
  assert.equal(r.data.note, TRANSIT_NOTE);
});

test("transit_route：单档失败不拖垮整体；全空才报错", async () => {
  const ok = createTransitRouteTool(
    transitBackend({ 0: new Error("限流"), 1: [G99], 2: new Error("限流") }),
  );
  const r = await ok.call({ fromCity: "上海", toCity: "广州" }, ctx);
  assert.equal(r.data.options.length, 1);

  /*
   * 问通了但没有火车 ≠ 失败（M13-14）。同城短途本来就没有铁路直达，
   * 从前这里一律抛错，于是「上海静安→上海嘉定」每次规划都以 transit 分支
   * failed 收场，看轨迹像查询挂了。空结果照常返回，只在 note 里说明。
   */
  const noTrain = await createTransitRouteTool(transitBackend({})).call(
    { fromCity: "上海静安", toCity: "上海嘉定" },
    ctx,
  );
  assert.equal(noTrain.data.options.length, 0);
  assert.match(noTrain.data.note, /没有铁路直达/);

  // 三档全抛才是真失败——上游坏了必须报出来，不能伪装成"这条线没火车"。
  const broken = createTransitRouteTool(
    transitBackend({ 0: new Error("限流"), 1: new Error("限流"), 2: new Error("限流") }),
  );
  await assert.rejects(() => broken.call({ fromCity: "上海", toCity: "拉萨" }, ctx), /查询未成功/);
});

test("registry：ACL 裁剪——poi_search 归 hotel/tour，buying/cabin 看不见", () => {
  const poi = getTool("poi_search");
  const transit = getTool("transit_route");
  assert.ok(poi && transit);
  assert.ok(poi.agents.includes("hotel") && poi.agents.includes("tour"));
  assert.ok(!poi.agents.includes("buying") && !poi.agents.includes("cabin"));
  assert.ok(transit.agents.includes("transit") && transit.agents.includes("drive"));
  // 描述里必须带住诚实边界——pi 注入时这是模型唯一能看到的说明。
  assert.match(poi.description, /不含任何价格/);
  assert.match(transit.description, /禁止编造具体航班号/);
});

test("mock 三态：两工具都能离线跑", async () => {
  const mctx = { ...ctx, mode: "mock" } as never;
  const poi = await createPoiSearchTool(poiBackend([])).call({ city: "广州", category: "hotel" }, mctx);
  assert.ok(poi.data.candidates.length > 0 && poi.source.kind === "mock");
  const tr = await createTransitRouteTool(transitBackend({})).call(
    { fromCity: "上海", toCity: "广州" },
    mctx,
  );
  assert.ok(tr.data.options.length > 0 && tr.source.kind === "mock");
});
