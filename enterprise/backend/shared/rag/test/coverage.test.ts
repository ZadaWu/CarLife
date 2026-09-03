/**
 * 车型 ↔ 知识库关联关系（施工单 M14-08）。
 *
 * 这里的文件名是 RAGFlow 三个数据集里的**真实文件名**（`probe:ragflow` 实测
 * 5 / 4 / 7 篇）。加语料时同步这份清单——它是"算出来的关联与真实库不符"的防线。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { catalogModels } from "@carlife/shared";

import { coverageOf, invisibleDocuments, type DocumentsByDataset } from "../src/coverage";

const KB: DocumentsByDataset = {
  "vehicle-manuals": [
    "Model3_车主手册.md",
    "ModelY_车主手册.md",
    "Cybertruck_Owners_Manual.md",
    "2017雪佛兰全新迈锐宝用户手册_OM000G542.md",
    "2017雪佛兰全新迈锐宝导航娱乐系统手册_OM000G543.md",
  ],
  "repair-kb": [
    "Model3_保养.md",
    "ModelY_保养.md",
    "Cybertruck_Maintenance.md",
    "2017雪佛兰全新迈锐宝保修及保养手册_OM000G544.md",
  ],
  "car-catalog": [
    "Model3_参数规格.md",
    "ModelY_参数规格.md",
    "Cybertruck_Specifications.md",
    "tesla_m3_选配.md",
    "tesla_my_选配.md",
    "tesla_ct_选配.md",
    "2017雪佛兰迈锐宝车型手册与配置参数.md",
  ],
};

test("有资料的车型算得出关联，且落到正确的数据集", () => {
  const index = coverageOf(catalogModels(), KB);
  const my = index.get("Model Y");
  assert.ok(my, "Model Y 应有关联");
  assert.deepEqual(
    my.map((l) => l.dataset).sort(),
    ["car-catalog", "repair-kb", "vehicle-manuals"],
  );
  assert.deepEqual(my.find((l) => l.dataset === "vehicle-manuals")!.documents, ["ModelY_车主手册.md"]);
  // 迈锐宝的手册在三个集里都有；导航娱乐手册也算在 vehicle-manuals。
  assert.equal(index.get("迈锐宝")!.find((l) => l.dataset === "vehicle-manuals")!.documents.length, 2);
});

test("没资料的车型不出现在索引里——不是空数组，是没有这个 key", () => {
  const index = coverageOf(catalogModels(), KB);
  assert.equal(index.has("海豚"), false);
  // 迈锐宝 XL 与迈锐宝是两辆车：前者没有资料，不能被后者的手册蹭上。
  assert.equal(index.get("迈锐宝 XL"), undefined);
});

test("读不到的数据集不被记成 0 篇——跳过而不是判空", () => {
  // repair-kb 读失败（key 缺席）：Model Y 仍有另外两集的关联，
  // 但**不会**多出一条 documents 为空的 repair-kb 链接。
  const partial: DocumentsByDataset = { ...KB, "repair-kb": undefined };
  const links = coverageOf(["Model Y"], partial).get("Model Y")!;
  assert.deepEqual(links.map((l) => l.dataset).sort(), ["car-catalog", "vehicle-manuals"]);
});

test("知识库为空时没有任何车型有关联", () => {
  assert.equal(coverageOf(catalogModels(), {}).size, 0);
});

test("每篇文档都能被目录里的某个车型匹配到——否则它对限定检索是隐形的", () => {
  assert.deepEqual(invisibleDocuments(catalogModels(), KB), []);
});

test("文件名不含车型的文档会被点名", () => {
  const withOrphan: DocumentsByDataset = { "vehicle-manuals": ["某车企通用保养须知.md"] };
  assert.deepEqual(invisibleDocuments(catalogModels(), withOrphan), [
    "vehicle-manuals/某车企通用保养须知.md",
  ]);
});
