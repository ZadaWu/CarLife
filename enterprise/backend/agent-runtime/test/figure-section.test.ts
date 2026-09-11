/**
 * [F-20-03][AC-20-1] 手册图示那一路（ACR-029）：开关 off 上下文逐字节不变；on 时【手册图示】段的位置与形状；
 * 相似度门与去重；召回抛错不进 caveats；top-1 图的暂存交接取一次即清、读不到文件不挂。零依赖。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  FIGURE_MIN_SIM_IMAGE,
  FIGURE_MIN_SIM_TEXT,
  FIGURE_SECTION,
  figureSection,
  figuresEnabled,
  pickFigures,
  runDualPath,
  setFigureDeps,
  stageFigureForAnswer,
  takeStagedFigure,
  type FigureHitLite,
} from "../src/graph/subgraphs/ownership";

const chunks = [{ content: "锂电池低温下离子活性下降", source: { document: "说明书.pdf", location: "第 42 页" } }];
const summary = { avgDailyKm: 42, lowTempRangeKm: 320, mildTempRangeKm: 400, sampleSize: 18 };
const hit = (over: Partial<FigureHitLite> = {}): FigureHitLite => ({
  figureId: "Model3_车主手册#p148#b57",
  doc: "Model3_车主手册",
  page: 148,
  location: "第 146 页",
  breadcrumb: "Model3_车主手册 › 充电和能耗 › 打开充电端口",
  anchorText: "当 Model 3处于驻车模式时，按下并释放 Tesla 充电电缆上的按钮可打开充电接口盖板。",
  caption: "",
  imgPath: "Model3_车主手册.2fcd395b/part-2/images/a.jpg",
  sim: 0.82,
  via: "text",
  ...over,
});

afterEach(() => {
  setFigureDeps(undefined);
  delete process.env.CARLIFE_KB_FIGURES;
});

describe("[F-20-03][AC-20-1] 开关与装配", () => {
  it("缺省 off；on 但未装配也不算启用；on 且装配才启用", () => {
    assert.equal(figuresEnabled({}), false);
    assert.equal(figuresEnabled({ CARLIFE_KB_FIGURES: "on" }), false);
    setFigureDeps({ recall: async () => [] });
    assert.equal(figuresEnabled({ CARLIFE_KB_FIGURES: "on" }), true);
    assert.equal(figuresEnabled({ CARLIFE_KB_FIGURES: "off" }), false);
  });
});

describe("[F-20-03][AC-20-1] pickFigures / figureSection", () => {
  it("相似度门按路：文字路 0.70、图像路 0.65；同图只留一条、按相似度排、最多 3 条", () => {
    const picked = pickFigures([
      hit({ figureId: "a", sim: 0.71 }),
      hit({ figureId: "a", sim: 0.88, via: "image" }),
      hit({ figureId: "b", sim: FIGURE_MIN_SIM_TEXT - 0.01 }),
      hit({ figureId: "b2", sim: FIGURE_MIN_SIM_IMAGE - 0.01, via: "crop" }),
      hit({ figureId: "c", sim: 0.8 }),
      hit({ figureId: "d", sim: 0.66, via: "crop" }),
      hit({ figureId: "e", sim: 0.75 }),
    ]);
    assert.deepEqual(picked.map((h) => [h.figureId, h.sim]), [["a", 0.88], ["c", 0.8], ["e", 0.75]]);
    assert.deepEqual(pickFigures([hit({ figureId: "x", sim: 0.45, via: "image" })]), [], "文字 → 图像的跨模态 0.45 不过图像路的门");
  });
  it("段：一图一行，出处 · 面包屑：锚段；有图注带上；没有命中不出段", () => {
    assert.equal(figureSection([]), undefined);
    const s = figureSection([hit(), hit({ figureId: "x", location: "第 13 页", caption: "驻车状态触摸屏", anchorText: "锚段".repeat(200) })])!;
    const lines = s.split("\n");
    assert.equal(lines[0], FIGURE_SECTION);
    assert.equal(lines[1], "- Model3_车主手册 第 146 页 · Model3_车主手册 › 充电和能耗 › 打开充电端口：当 Model 3处于驻车模式时，按下并释放 Tesla 充电电缆上的按钮可打开充电接口盖板。");
    assert.match(lines[2], /^- Model3_车主手册 第 13 页 · .*：锚段.*…（图注：驻车状态触摸屏）$/);
    assert.ok(lines[2].length < 300, "锚段截到 220 字");
  });
});

describe("[F-20-03][AC-20-1] runDualPath 多一路", () => {
  it("不给 figures → 上下文与现状逐字节相同，figures 为空数组", async () => {
    const base = await runDualPath(async () => chunks, async () => ({ summary }), true, "低温续航");
    const same = await runDualPath(async () => chunks, async () => ({ summary }), true, "低温续航", {});
    assert.equal(same.context, base.context);
    assert.deepEqual(base.figures, []);
    assert.ok(!base.context.includes("【手册图示"));
  });
  it("给了 figures → 段在【通用原理】之后、【这辆车的真实数据】之前；结果带 figures", async () => {
    const r = await runDualPath(async () => chunks, async () => ({ summary }), true, "充电口在哪", { figures: async () => [hit(), hit({ figureId: "low", sim: 0.5 })] });
    assert.equal(r.figures.length, 1);
    const i1 = r.context.indexOf("【通用原理");
    const i2 = r.context.indexOf(FIGURE_SECTION);
    const i3 = r.context.indexOf("【这辆车的真实数据】");
    assert.ok(i1 >= 0 && i1 < i2 && i2 < i3, r.context);
    assert.match(r.context, /第 146 页 · Model3_车主手册 › 充电和能耗/);
    assert.deepEqual(r.caveats, []);
  });
  it("召回抛错 → 没有这一段、不进 caveats、不影响个性化判定", async () => {
    const r = await runDualPath(async () => chunks, async () => ({ summary }), true, "q", { figures: async () => { throw new Error("pgvector 不通"); } });
    assert.equal(r.personalized, true);
    assert.deepEqual(r.caveats, []);
    assert.deepEqual(r.figures, []);
    assert.ok(!r.context.includes("【手册图示"));
  });
  it("召回全部低于门槛 → 同样不出段", async () => {
    const r = await runDualPath(async () => chunks, async () => ({ summary }), true, "q", { figures: async () => [hit({ sim: 0.6 })] });
    assert.deepEqual(r.figures, []);
    assert.ok(!r.context.includes("【手册图示"));
  });
});

describe("[F-20-03][AC-20-1] top-1 图交接给 answer", () => {
  it("未装配 readImage → 取不到；装配后取到 jpeg，且取一次即清；stage(undefined) 清掉", () => {
    stageFigureForAnswer("t1", hit());
    assert.equal(takeStagedFigure("t1"), undefined, "没有 readImage 就不挂图");
    setFigureDeps({ recall: async () => [], readImage: (p) => (p.endsWith("a.jpg") ? Buffer.from([0xff, 0xd8, 0xff, 0x00]) : null) });
    stageFigureForAnswer("t1", hit());
    const img = takeStagedFigure("t1")!;
    assert.equal(img.mimeType, "image/jpeg");
    assert.equal(img.label, "手册图示：Model3_车主手册 第 146 页");
    assert.equal(img.base64, Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64"));
    assert.equal(takeStagedFigure("t1"), undefined, "取过就清");
    stageFigureForAnswer("t1", hit({ imgPath: "missing.jpg" }));
    assert.equal(takeStagedFigure("t1"), undefined, "文件读不到不挂");
    stageFigureForAnswer("t1", hit());
    stageFigureForAnswer("t1", undefined);
    assert.equal(takeStagedFigure("t1"), undefined);
  });
  it("png 按魔数识别", () => {
    setFigureDeps({ recall: async () => [], readImage: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    stageFigureForAnswer("t2", hit());
    assert.equal(takeStagedFigure("t2")!.mimeType, "image/png");
  });
});
