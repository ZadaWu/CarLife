/**
 * 高德类目 → 贴纸品类（M13-07）。
 *
 * 盯两类错：把「湿地公园」分成 park（先窄后宽的顺序被改坏）；
 * 类目覆盖不到时不落 spot 而去猜（真实性红线）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyAmapPoi, POI_KINDS } from "../src/index";

test("常见类目按 type 文本分类", () => {
  const cases: Array<[string, string]> = [
    ["风景名胜;风景名胜;寺庙道观", "temple"],
    ["科教文化服务;博物馆;博物馆", "museum"],
    ["风景名胜;公园广场;公园", "park"],
    ["风景名胜;公园广场;动物园", "park"],
    ["体育休闲服务;娱乐场所;游乐场", "amusement_park"],
    ["风景名胜;风景名胜;海滩", "beach"],
    ["汽车服务;充电站;充电站", "charge"],
    ["餐饮服务;中餐厅;中餐厅", "food"],
    ["住宿服务;宾馆酒店;五星级宾馆", "hotel"],
    // 只有大类粒度：如实落通用景点，不猜。
    ["风景名胜;风景名胜;国家级景点", "spot"],
  ];
  for (const [type, want] of cases) {
    assert.equal(classifyAmapPoi({ type }), want, type);
  }
});

test("先窄后宽：湿地公园是 wetland 不是 park", () => {
  assert.equal(classifyAmapPoi({ type: "风景名胜;公园广场;湿地公园" }), "wetland");
});

test("type 缺失时 typecode 前缀兜底；两者都没有 → spot", () => {
  assert.equal(classifyAmapPoi({ typecode: "011100" }), "charge");
  assert.equal(classifyAmapPoi({ typecode: "110101" }), "park");
  assert.equal(classifyAmapPoi({ typecode: "140100" }), "museum");
  assert.equal(classifyAmapPoi({ typecode: "100100" }), "hotel");
  assert.equal(classifyAmapPoi({}), "spot");
  assert.equal(classifyAmapPoi({ type: "", typecode: "" }), "spot");
});

test("产出永远在贴纸品类集合内（HUD 端不需要再兜底枚举外的值）", () => {
  const kinds = new Set<string>(POI_KINDS);
  for (const type of ["随便什么;新类目", "风景名胜;风景名胜;寺庙道观", ""]) {
    assert.ok(kinds.has(classifyAmapPoi({ type })));
  }
});
