/**
 * [F-13-05] poi_search 的坐标登记（M77 走查追修）。
 *
 * 这是一条**接线测试**：sink 没被调用时不报错、不影响返回值，症状只是
 * 片区缺口判定悄悄退回比字符串——正是本仓 内部开发指引 反复警告的那种漏接线。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createPoiSearchTool, setPoiCoordSink } from "../src/poi-search";

const backend = {
  textSearch: async () => [
    { id: "1", name: "南通博物苑", address: "濠南路19号", lat: 32.011296, lon: 120.869839 },
    { id: "2", name: "水绘园", address: "碧霞路299号", lat: 32.395475, lon: 120.56989 },
  ],
};
const tool = createPoiSearchTool(backend as never);
const ctx = { sessionId: "s", turnId: "t", agent: "tour" } as never;
const args = { city: "南通", category: "attraction", keywords: "濠河 博物苑", limit: 20 } as never;

afterEach(() => setPoiCoordSink(undefined));

describe("[F-13-05] poi_search → 坐标登记簿", () => {
  it("真实后端的每条命中都报给 sink，带 name 与坐标", async () => {
    const got: Array<{ name: string; lat: number; lon: number }> = [];
    setPoiCoordSink({ record: (_c, hits) => got.push(...hits) });
    await tool.call(args, ctx);
    assert.deepEqual(got.map((h) => h.name), ["南通博物苑", "水绘园"]);
    assert.equal(got[0]!.lat, 32.011296);
  });

  it("**按命中自己的 name 报，不是按查询词**——ADR-008：查到了不等于查对了", async () => {
    // 实测：拿「南通濠河风景名胜区」当关键词单查，高德返回 45km 外如皋的水绘园。
    // 按命中名入账，它就只会被记成「水绘园」，永远不会冒充成濠河。
    const got: string[] = [];
    setPoiCoordSink({ record: (_c, hits) => got.push(...hits.map((h) => h.name)) });
    await tool.call({ ...(args as object), keywords: "南通濠河风景名胜区" } as never, ctx);
    assert.ok(!got.includes("南通濠河风景名胜区"), "查询词不该进簿");
    assert.ok(got.includes("水绘园"));
  });

  it("sink 抛错不影响搜索结果——旁路记账不该拖垮主链路", async () => {
    setPoiCoordSink({ record: () => { throw new Error("boom"); } });
    const r = await tool.call(args, ctx);
    assert.equal(r.data.candidates.length, 2);
  });

  it("未注入时照常返回（离线/测试档）", async () => {
    const r = await tool.call(args, ctx);
    assert.equal(r.data.candidates.length, 2);
  });

  it("mock 档不经过 sink——那是固定假坐标，记了会让判距离胡说", async () => {
    let called = false;
    setPoiCoordSink({ record: () => { called = true; } });
    const r = await tool.call(args, { ...(ctx as object), mode: "mock" } as never);
    assert.ok(r.data.candidates.length > 0);
    assert.equal(called, false);
  });
});
