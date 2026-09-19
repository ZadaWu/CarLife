/**
 * [F-13-01] 搜索按分支拆开（M77 走查追修）：tour 只搜景点、hotel 只搜酒店。
 *
 * 最近两天 tour 的 222 次 poi_search 里 73 次是酒店/充电/停车。真实病例 turn-0c52eebf：
 * tour 自己搜到的「苏州金鸡湖美居酒店」被当景点写进第 2、3 天，与 hotel 分支挑的两不相干。
 * 拆开是"根本调不到"，比按 agent 在工具里加闸干净，谁能搜什么只由 ACL 决定。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createPoiSearchTool, setPoiCoordSink } from "../src/poi-search";
import { describeForPi, listForAgent } from "../src/registry";

const seen: Array<{ types: string; keywords: string }> = [];
const backend = {
  textSearch: async (p: { types: string; keywords: string }) => {
    seen.push({ types: p.types, keywords: p.keywords });
    return [{ id: "1", name: "南通博物苑", address: "濠南路19号", lat: 32.011296, lon: 120.869839 }];
  },
};
const ctx = { sessionId: "s", turnId: "t", agent: "tour" } as never;
afterEach(() => { seen.length = 0; setPoiCoordSink(undefined); });

describe("[F-13-01] 钉死类别的实例", () => {
  it("spot_search 忽略入参里的 category，永远按景点搜", async () => {
    const spot = createPoiSearchTool(backend as never, { name: "spot_search", fixedCategory: "attraction" });
    const r = await spot.call({ city: "南通", category: "hotel", keywords: "濠河" } as never, ctx);
    assert.equal(r.data.category, "attraction");
    // 类目码确实由钉死的类别决定：同一入参给 hotel_search 发出去的 types 必须不同
    const hotel = createPoiSearchTool(backend as never, { name: "hotel_search", fixedCategory: "hotel" });
    await hotel.call({ city: "南通", category: "attraction", keywords: "濠河" } as never, ctx);
    assert.equal(seen.length, 2);
    assert.notEqual(seen[0]!.types, seen[1]!.types, "两个实例发给后端的类目码应不同");
  });

  it("hotel_search 同理，只按酒店搜；缺省关键词按类目补「酒店」", async () => {
    const hotel = createPoiSearchTool(backend as never, { name: "hotel_search", fixedCategory: "hotel" });
    const r = await hotel.call({ city: "南通" } as never, ctx);
    assert.equal(r.data.category, "hotel");
    assert.equal(seen[0]!.keywords, "酒店");
  });

  it("多类别版没给 category 就拒绝——不静默猜一个", async () => {
    const poi = createPoiSearchTool(backend as never);
    await assert.rejects(() => poi.call({ city: "南通" } as never, ctx), /category 不能为空/);
  });

  it("坐标登记簿对三个实例同样生效——同一条 real()", async () => {
    const got: string[] = [];
    setPoiCoordSink({ record: (_c, hits) => got.push(...hits.map((h) => h.name)) });
    const spot = createPoiSearchTool(backend as never, { name: "spot_search", fixedCategory: "attraction" });
    await spot.call({ city: "南通", keywords: "博物苑" } as never, ctx);
    assert.deepEqual(got, ["南通博物苑"]);
  });

  it("mock 档也按钉死的类别给数据", async () => {
    const hotel = createPoiSearchTool(backend as never, { name: "hotel_search", fixedCategory: "hotel" });
    const r = await hotel.call({ city: "广州" } as never, { ...(ctx as object), mode: "mock" } as never);
    assert.equal(r.data.category, "hotel");
    assert.ok(r.data.candidates.every((c) => c.name.includes("（模拟）")));
  });
});

describe("[F-13-01] ACL：tour 手里没有任何能搜酒店的东西，hotel 手里没有任何能搜景点的东西", () => {
  const names = (agent: string) => listForAgent(agent as never).map((t) => t.name);

  it("tour：有 spot_search，没有 poi_search / hotel_search", () => {
    const n = names("tour");
    assert.ok(n.includes("spot_search"));
    assert.ok(!n.includes("poi_search") && !n.includes("hotel_search"), JSON.stringify(n));
  });

  it("hotel：有 hotel_search，没有 poi_search / spot_search", () => {
    const n = names("hotel");
    assert.ok(n.includes("hotel_search"));
    assert.ok(!n.includes("poi_search") && !n.includes("spot_search"), JSON.stringify(n));
  });

  it("guide-spots 跟 tour 一样只搜景点；guide-access 保留多类别（停车/充电/加油）", () => {
    assert.ok(names("guide-spots").includes("spot_search") && !names("guide-spots").includes("poi_search"));
    assert.ok(names("guide-access").includes("poi_search"));
  });

  it("发给 pi 的 spot_search / hotel_search 参数表里**没有 category**——模型无从填错", () => {
    for (const [agent, tool] of [["tour", "spot_search"], ["hotel", "hotel_search"]] as const) {
      const d = describeForPi(agent as never).find((t) => t.name === tool)!;
      assert.ok(d, `${agent} 应有 ${tool}`);
      assert.ok(!("category" in ((d.parameters as any).properties ?? {})), `${tool} 不该暴露 category`);
    }
  });
});

describe("[F-13-01] attraction 类目覆盖文化场馆（M77 走查追修）", () => {
  it("类目码含 140000——只给风景名胜时，搜博物馆返回的是名字里带馆的景区，不是真的那座馆", async () => {
    // 实测（杭州）：110000 搜「浙江省博物馆 杭州博物馆 丝绸博物馆」→ 中国水博览园 / 中国江南水乡文化博物馆；
    // 110000|140000 → 浙江省博物馆(之江馆区) / 杭州博物馆 / 中国丝绸博物馆。雨天备选要的正是后者。
    const seen: string[] = [];
    const t = createPoiSearchTool(
      { textSearch: async (p: { types: string }) => { seen.push(p.types); return []; } } as never,
      { name: "spot_search", fixedCategory: "attraction" },
    );
    await t.call({ city: "杭州", keywords: "博物馆" } as never, { sessionId: "s", turnId: "t", agent: "tour" } as never);
    assert.match(seen[0]!, /110000/);
    assert.match(seen[0]!, /140000/, "缺 140000 的话室内馆会挑错");
  });
});
