/**
 * [F-24-03][AC-24-7] 手册图文索引（ACR-029）：一张图几行、低置信不进库、观察层只对指示灯类插图跑且失败不拖垮；
 * 双路召回按 figureId 融合、命中带出处。全部离线——embedder / store / observe 用桩。
 * 另：图占位在清洗与切片两端的行为（`cleanMineruMarkdown` / `resolveFigurePlaceholders`）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepareMarkdownForChunking, resolveFigurePlaceholders } from "../src/chunk-prep";
import { buildFigureIndex, recallFigures, type FigureStore, type FigureStoreRow } from "../src/figure-index";
import type { ManualFigure } from "../src/figures";
import type { Embedder } from "../src/icon-index";
import { cleanMineruMarkdown, figurePlaceholder, parseContentList } from "../src/mineru";

const DIM = 8;
const unit = (i: number): number[] => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));
const cos = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i], 0);

/** 桩 embedder：按文本关键字 / 图片首字节落到固定维度，让距离可预期。 */
const embedder: Embedder = {
  model: "stub",
  dimension: DIM,
  async embedText(t) {
    if (/充电/.test(t)) return unit(1);
    if (/雾灯/.test(t)) return unit(2);
    return unit(0);
  },
  async embedImage(b) {
    return unit(b[0] % DIM);
  },
};

function memStore(): FigureStore & { rows: Array<FigureStoreRow & { embedding: number[] }> } {
  const rows: Array<FigureStoreRow & { embedding: number[] }> = [];
  return {
    rows,
    async upsertMany(xs) {
      for (const x of xs) {
        const i = rows.findIndex((r) => r.doc === x.doc && r.figureId === x.figureId && r.kind === x.kind && r.sourceAsset === x.sourceAsset);
        if (i >= 0) rows[i] = x;
        else rows.push(x);
      }
      return xs.length;
    },
    async nearest(q) {
      return rows
        .filter((r) => (!q.doc || r.doc === q.doc) && (!q.kind || r.kind === q.kind) && r.confidence >= (q.minConfidence ?? 0))
        .map((r) => ({ ...r, distance: 1 - cos(q.vector, r.embedding) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, q.k);
    },
    async deleteByDoc(doc) {
      const n = rows.filter((r) => r.doc === doc).length;
      rows.splice(0, rows.length, ...rows.filter((r) => r.doc !== doc));
      return n;
    },
  };
}

const fig = (over: Partial<ManualFigure> & { id: string }): ManualFigure => ({
  doc: "D",
  page: 3,
  printedPage: "3",
  location: "第 3 页",
  blockIndex: 1,
  bbox: [0, 0, 10, 10],
  imgPath: "images/a.jpg",
  imageKey: "a",
  kind: "figure",
  caption: "",
  footnote: "",
  headings: ["充电"],
  breadcrumb: "D › 充电",
  anchor: { rule: "adjacent", confidence: 0.6, blockIndex: 0, text: "按下按钮可打开充电接口盖板。" },
  ...over,
});

describe("[F-24-03][AC-24-7] buildFigureIndex", () => {
  it("一张图两行（text + image）；读不到图片只有 text 行并记进 missingImages；低置信不进库", async () => {
    const store = memStore();
    const r = await buildFigureIndex(
      [fig({ id: "D#p3#b1" }), fig({ id: "D#p4#b9", imgPath: "images/missing.jpg", page: 4 }), fig({ id: "D#p5#b2", anchor: { rule: "previous-page", confidence: 0.4, blockIndex: 0, text: "x" } })],
      { embedder, store, readImage: (p) => (p === "images/a.jpg" ? Buffer.from([1, 2, 3]) : null) },
    );
    assert.equal(r.figures, 2);
    assert.equal(r.skippedLowConfidence, 1);
    assert.equal(r.textRows, 2);
    assert.equal(r.imageRows, 1);
    assert.deepEqual(r.missingImages, ["images/missing.jpg"]);
    assert.deepEqual(store.rows.map((x) => [x.figureId, x.kind, x.sourceAsset]), [
      ["D#p3#b1", "text", ""],
      ["D#p3#b1", "image", "images/a.jpg"],
      ["D#p4#b9", "text", ""],
    ]);
    assert.equal(store.rows[0].anchorText, "按下按钮可打开充电接口盖板。");
    assert.equal(store.rows[0].location, "第 3 页");
  });
  it("观察层只对指示灯类插图跑，每枚 crop 出图像 + 描述子文本两行；抛错只记不拖垮", async () => {
    const store = memStore();
    let calls = 0;
    const r = await buildFigureIndex(
      [
        fig({ id: "D#p3#b1", breadcrumb: "D › 概述 › 指示灯" }),
        fig({ id: "D#p3#b2", breadcrumb: "D › 充电" }),
        fig({ id: "D#p3#b3", kind: "icon", breadcrumb: "D › 概述 › 指示灯" }),
        fig({ id: "D#p3#b4", breadcrumb: "D › 概述 › 仪表", imgPath: "images/boom.jpg" }),
      ],
      {
        embedder,
        store,
        readImage: (p) => Buffer.from([p === "images/boom.jpg" ? 9 : 2]),
        observe: async (img) => {
          calls += 1;
          if (img[0] === 9) throw new Error("模型超时");
          return [{ crop: Buffer.from([3]), descriptor: { shape: "lamp", color: "amber", elements: ["wavy_lines"], text: [] } }];
        },
      },
    );
    assert.equal(calls, 2, "只有两张指示灯类插图过观察层（icon 与充电插图不过）");
    assert.equal(r.observed, 1);
    assert.equal(r.cropRows, 2);
    assert.match(r.observeFailed[0], /D#p3#b4: 模型超时/);
    const crops = store.rows.filter((x) => x.kind === "crop");
    assert.deepEqual(crops.map((x) => x.sourceAsset), ["D#p3#b1#crop1", "D#p3#b1#crop1#text"]);
    assert.equal((crops[1].descriptor as { text_query: string }).text_query, "琥珀色 灯形 波浪线");
  });
  it("幂等：同键重跑只更新，不翻倍", async () => {
    const store = memStore();
    const deps = { embedder, store, readImage: () => Buffer.from([1]) };
    await buildFigureIndex([fig({ id: "D#p3#b1" })], deps);
    await buildFigureIndex([fig({ id: "D#p3#b1" })], deps);
    assert.equal(store.rows.length, 2);
  });
});

describe("[F-24-03][AC-24-7] recallFigures", () => {
  async function seeded() {
    const store = memStore();
    await buildFigureIndex(
      [
        fig({ id: "D#p3#b1", breadcrumb: "D › 充电", anchor: { rule: "adjacent", confidence: 0.6, blockIndex: 0, text: "打开充电接口盖板。" }, imgPath: "images/charge.jpg" }),
        fig({ id: "D#p9#b1", breadcrumb: "D › 车灯", anchor: { rule: "row", confidence: 0.9, blockIndex: 0, text: "后雾灯亮起时显示。" }, imgPath: "images/fog.jpg", page: 9, location: "第 9 页" }),
      ],
      { embedder, store, readImage: (p) => Buffer.from([p.includes("fog") ? 2 : 1]) },
    );
    return store;
  }
  it("文字提问：检索词的向量命中讲充电的图，带出处与锚段；两路都没输入返回空", async () => {
    const store = await seeded();
    const { hits, paths } = await recallFigures({ text: "充电口在哪" }, { embedder, store });
    assert.deepEqual(paths, ["text"]);
    assert.equal(hits[0].figureId, "D#p3#b1");
    assert.equal(hits[0].location, "第 3 页");
    assert.equal(hits[0].anchorText, "打开充电接口盖板。");
    assert.ok(hits[0].textSim !== null && hits[0].textSim > 0.99);
    assert.equal(hits[0].imageSim, null);
    assert.deepEqual(await recallFigures({}, { embedder, store }), { hits: [], paths: [] });
  });
  it("照片提问：crop 图像向量命中同图的整图行；两路都有时按 figureId 融合、同图只出一条", async () => {
    const store = await seeded();
    const { hits, paths } = await recallFigures({ text: "雾灯", crops: [Buffer.from([2])] }, { embedder, store });
    assert.deepEqual(paths, ["text", "image"]);
    assert.equal(hits[0].figureId, "D#p9#b1");
    assert.ok(hits[0].imageSim !== null && hits[0].textSim !== null);
    assert.equal(hits.filter((h) => h.figureId === "D#p9#b1").length, 1);
  });
  it("锚定置信度下限：0.9 只剩 row 那张", async () => {
    const store = await seeded();
    const { hits } = await recallFigures({ text: "充电口在哪", minConfidence: 0.9 }, { embedder, store });
    assert.deepEqual(hits.map((h) => h.figureId), ["D#p9#b1"]);
  });
});

describe("[F-24-03][AC-24-7] 图占位：清洗端与切片端", () => {
  it("cleanMineruMarkdown 缺省仍删图；placeholder 模式换成 [[fig:前16位]] 独占一行", () => {
    const md = "看图\n![](images/abcdef0123456789abcdef.jpg)\n说明";
    assert.equal(cleanMineruMarkdown(md), "看图\n\n说明");
    assert.equal(cleanMineruMarkdown(md, { figures: "placeholder" }), "看图\n\n[[fig:abcdef0123456789]]\n\n说明");
    assert.equal(figurePlaceholder("part-1/images/abcdef0123456789abcdef.jpg"), "[[fig:abcdef0123456789]]");
  });
  it("切片前：有图注的占位换成「（图：…）」，没有的剥掉；旧 md 没占位不受影响", () => {
    assert.equal(resolveFigurePlaceholders("上文\n[[fig:abcdef0123456789]]\n下文", { abcdef0123456789: "充电接口位置" }), "上文\n（图：充电接口位置）\n下文");
    assert.equal(resolveFigurePlaceholders("上文\n[[fig:abcdef0123456789]]\n下文"), "上文\n\n下文");
    assert.equal(resolveFigurePlaceholders("[[fig:abcdef0123456789]]"), "");
    const md = "# 章\n\n段落一。\n\n[[fig:abcdef0123456789]]\n\n段落二。";
    const out = prepareMarkdownForChunking(md, { title: "T" });
    assert.ok(!/\[\[fig:/.test(out), out);
    assert.match(out, /段落一。\n\n段落二。/);
    assert.equal(prepareMarkdownForChunking("# 章\n\n段落一。\n\n段落二。", { title: "T" }), out, "没有占位的输入逐字节不变");
  });
  it("parseContentList：数组且每块有 type / bbox / page_idx；否则抛", () => {
    assert.equal(parseContentList('[{"type":"text","bbox":[1,2,3,4],"page_idx":0,"text":"a"}]').length, 1);
    assert.throws(() => parseContentList("{}"), /不是数组/);
    assert.throws(() => parseContentList('[{"type":"text"}]'), /第 0 块缺/);
  });
});
