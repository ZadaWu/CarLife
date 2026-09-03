/**
 * 目录视图与三态文案（施工单 M14-07 起，M14-08 改吃实时关联关系）。
 *
 * 这组断言的由来是两个真实缺陷：目录声称"与知识库相匹配"其实不是；
 * 建档落库的车型名拼了品牌前缀，导致连有手册的车也检索不到自己的手册。
 * 两者都没让任何单测变红——因为当时没人把**目录数据**与**检索匹配函数**
 * 放在一起测。所以这里跨包引 `documentMatchesModel`。
 *
 * M14-08 之后又多一条要守的：**读不到 ≠ 没有资料**。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { documentMatchesModel } from "@carlife/rag";
import { VEHICLE_CATALOG } from "@carlife/shared";

import {
  catalogBrands,
  catalogFromResponse,
  catalogYears,
  knowledgeNote,
  offlineCatalog,
  searchCatalog,
  type CatalogResponse,
} from "../src/vehicle/catalog";
import { draftToCreateBody } from "../src/vehicle/wizard-logic";

const KB_DOCUMENTS = [
  "Model3_车主手册.md",
  "ModelY_车主手册.md",
  "Cybertruck_Owners_Manual.md",
  "2017雪佛兰全新迈锐宝用户手册_OM000G542.md",
];

const docsFor = (model: string) => KB_DOCUMENTS.filter((d) => documentMatchesModel(d, model));

/** 一份"知识库只有 Model Y"的响应，用来测三态而不依赖真实网络。 */
const RESPONSE: CatalogResponse = {
  entries: VEHICLE_CATALOG.map((e) => ({
    ...e,
    links:
      e.model === "Model Y"
        ? [{ dataset: "vehicle-manuals", datasetName: "车辆说明书", documents: ["ModelY_车主手册.md"] }]
        : [],
  })),
  coverage: { state: "live", fetchedAt: 1 },
};

test("建档落库的车型名能被检索侧匹配到——不拼品牌前缀", () => {
  const body = draftToCreateBody({
    brand: "特斯拉", model: "Model Y", modelYear: 2023,
    energy: "bev", odometerKm: 41280, purchaseYear: 2023, purchaseMonth: 5,
  });
  assert.equal(body.model, "Model Y");
  // 回归点：曾经是 "特斯拉 Model Y"，下面这条会拿到空数组。
  assert.ok(docsFor(body.model).includes("ModelY_车主手册.md"));
});

test("目录外车型带标注，且不冒充任何车型的资料", () => {
  const body = draftToCreateBody({
    model: "某小众车", modelYear: 2020, offCatalog: true,
    energy: "icev", odometerKm: 100, purchaseYear: 2020, purchaseMonth: 1,
  });
  assert.equal(body.model, "某小众车（目录外）");
  assert.deepEqual(docsFor(body.model), []);
});

test("目录里每个车型名都是检索侧能用的键（写法与知识库文件名对得上）", () => {
  // 有资料的那几款必须匹配得到；这条挡的是"目录写法改了但知识库没改"。
  for (const model of ["Model 3", "Model Y", "Cybertruck", "迈锐宝"]) {
    assert.ok(
      VEHICLE_CATALOG.some((e) => e.model === model),
      `目录里应有 ${model}`,
    );
    assert.ok(docsFor(model).length > 0, `${model} 应能匹配到知识库文档`);
  }
});

test("有资料时列出关联到哪些资料", () => {
  const view = catalogFromResponse(RESPONSE);
  const note = knowledgeNote(view, "Model Y");
  assert.match(note, /已关联知识库/);
  assert.match(note, /车辆说明书 1 篇/);
});

test("没资料时明说没有，并说清哪些功能不受影响", () => {
  const view = catalogFromResponse(RESPONSE);
  const note = knowledgeNote(view, "海豚");
  assert.match(note, /暂时没有这一款的资料/);
  assert.match(note, /不会拿别的车型的手册作答/);
  assert.match(note, /保养推算/);
});

test("读不到时说读不到——绝不写成「没有资料」", () => {
  const note = knowledgeNote(offlineCatalog("网关不可达"), "Model Y");
  assert.match(note, /读不到知识库覆盖情况/);
  assert.match(note, /网关不可达/);
  // 这是这一条测试的全部意义：unavailable 不得被折叠成 "没有资料"。
  assert.doesNotMatch(note, /没有这一款的资料/);
});

test("stale 状态照常给关联，但标注可能不是最新", () => {
  const view = catalogFromResponse({ ...RESPONSE, coverage: { state: "stale", reason: "RAGFlow 超时" } });
  assert.match(knowledgeNote(view, "Model Y"), /可能不是最新/);
});

test("有资料的品牌排前面；读不到时保持清单原序，不暗示任何排序含义", () => {
  assert.equal(catalogBrands(catalogFromResponse(RESPONSE))[0], "特斯拉");
  const offline = offlineCatalog();
  assert.deepEqual(catalogBrands(offline), [...new Set(VEHICLE_CATALOG.map((e) => e.brand))]);
});

test("目录检索无结果就是无结果，不做模糊兜底", () => {
  const view = offlineCatalog();
  assert.equal(searchCatalog(view, "宋").length, 2);
  assert.deepEqual(searchCatalog(view, "不存在的车"), []);
  assert.deepEqual(searchCatalog(view, "  "), []);
});

test("年款是通用年份表，不是逐车型编出来的上市年表", () => {
  // `catalogYears` 按用户本地日历年取值；用本地构造器避免 UTC 午夜在
  // 美洲时区仍属于前一年的边界漂移。
  const years = catalogYears(new Date(2026, 0, 1));
  assert.equal(years[0], 2026);
  assert.equal(years.at(-1), 2007);
  for (const e of VEHICLE_CATALOG) {
    assert.equal("years" in e, false, `${e.model} 仍带 years`);
    assert.equal("manual" in e, false, `${e.model} 仍带手写的 manual 标记`);
  }
});
