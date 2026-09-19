/**
 * 人群分群图谱的视图模型（施工单 M82-09）。
 *
 * 三条红线各有一条断言：抑制卡不出明细、`draft` 排表尾、`minCell` 只能调大。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampMinCell,
  MAX_EDGES,
  MIN_CELL_FLOOR,
  radiusOf,
  segmentAtlasView,
  suppressedNote,
  type SegmentAtlasData,
} from "../src/pages/research/segment-atlas/model";

const rows = (task: string) => ({
  task,
  constraint: "时间紧",
  alternative: "手机导航",
  value: "别出岔子",
  behavior: "avgDailyKm=0.3",
  reach: { value: 0.91, kind: "measured" as const },
});

const data = (): SegmentAtlasData => ({
  method: "behavior-kmeans-k5",
  segments: [
    {
      id: "seg-1",
      name: "群 1",
      size: 21,
      pct: 0.32,
      status: "draft",
      rows: rows("understand-car"),
      externalValidation: { metric: "resolved-rate-proxy", value: 0.83, n: 21, verdict: "insufficient" },
      tags: ["other"],
    },
    {
      id: "seg-2",
      name: "群 2",
      size: 14,
      pct: 0.21,
      status: "validated",
      rows: rows("keep-charged"),
      externalValidation: { metric: "提醒接受率", value: 0.71, n: 14, verdict: "validated" },
      tags: ["range-anxiety"],
    },
    {
      id: "seg-5",
      name: "群 5",
      size: 9,
      pct: 0.13,
      status: "suppressed",
      rows: rows(""),
      externalValidation: null,
      tags: ["x"],
      suppressed: true,
    },
  ],
  similarity: [
    { a: "seg-1", b: "seg-2", score: 0.38 },
    { a: "seg-2", b: "seg-5", score: -0.18 },
    { a: "seg-1", b: "seg-5", score: -0.38 },
    { a: "seg-1", b: "seg-2", score: 0.12 },
    { a: "seg-2", b: "seg-5", score: 0.05 },
    { a: "seg-1", b: "seg-5", score: 0.02 },
  ],
  suppressed: [{ key: "seg-5", reason: "小单元抑制", vehicles: 9 }],
});

describe("segmentAtlasView", () => {
  it("抑制群：卡 kind='suppressed'、六行清空、关系图圆虚线", () => {
    const view = segmentAtlasView(data(), MIN_CELL_FLOOR);
    const card = view.cards.find((c) => c.id === "seg-5");
    assert.ok(card);
    assert.equal(card.kind, "suppressed");
    // 留着明细等于没抑制
    assert.equal(card.rows, null);
    assert.deepEqual(card.tags, []);
    assert.equal(card.externalText, "");
    assert.ok(card.note?.includes("样本 9 台"), card.note);

    const node = view.nodes.find((n) => n.id === "seg-5");
    assert.equal(node?.dashed, true);
  });

  it("群名与规模仍然在——存在这件事本身不是秘密", () => {
    const view = segmentAtlasView(data(), MIN_CELL_FLOOR);
    const card = view.cards.find((c) => c.id === "seg-5");
    assert.equal(card?.name, "群 5");
    assert.equal(card?.size, 9);
  });

  it("已验证在前，draft 与抑制排表尾", () => {
    const view = segmentAtlasView(data(), MIN_CELL_FLOOR);
    assert.deepEqual(view.cards.map((c) => c.id), ["seg-2", "seg-1", "seg-5"]);
    assert.equal(view.cards[0].externalOk, true);
    assert.equal(view.cards[1].externalOk, false);
    assert.ok(view.cards[1].externalText.startsWith("未验证"));
  });

  it("minCell 输入 5 → 夹到下限 10", () => {
    assert.equal(clampMinCell(5, MIN_CELL_FLOOR), 10);
    assert.equal(clampMinCell(0, MIN_CELL_FLOOR), 10);
    assert.equal(clampMinCell(-100, MIN_CELL_FLOOR), 10);
    assert.equal(clampMinCell(Number.NaN, MIN_CELL_FLOOR), 10);
    // 调大是允许的
    assert.equal(clampMinCell(15, MIN_CELL_FLOOR), 15);
    assert.equal(clampMinCell(15.6, MIN_CELL_FLOOR), 16);
  });

  it("阈值调大只能让更多群变成抑制态，永远不会让抑制群露出明细", () => {
    const wide = segmentAtlasView(data(), 20);
    const seg2 = wide.cards.find((c) => c.id === "seg-2");
    assert.equal(seg2?.kind, "suppressed", "14 台低于 20 应转抑制");
    assert.equal(seg2?.rows, null);
    assert.equal(seg2?.statusLabel, "样本不足");
    // 已抑制的仍然抑制
    assert.equal(wide.cards.find((c) => c.id === "seg-5")?.rows, null);
  });

  it("抑制原话逐字带阈值与样本数", () => {
    assert.equal(
      suppressedNote(9, 10),
      "样本 9 台，低于最小群体阈值 10 台。为避免小单元再识别，不显示明细。需要 ≥10 台或改用更粗的分群粒度。",
    );
  });

  it("圆面积正比于群大小 → 半径正比于 √size，且有最小可点半径", () => {
    assert.equal(radiusOf(100, 100, 44), 44);
    assert.equal(radiusOf(25, 100, 44), 22);
    assert.equal(radiusOf(1, 100, 44), 14, "小群也要点得到");
    assert.equal(radiusOf(5, 0), 14, "空数据不除零");
  });

  it("相似度是余弦不是百分比，只画最强的几条", () => {
    const view = segmentAtlasView(data(), MIN_CELL_FLOOR);
    assert.equal(view.edges.length, MAX_EDGES);
    assert.equal(view.edges[0].label, "0.38");
    // 降序
    const scores = view.edges.map((e) => e.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.ok(!view.edges.some((e) => e.label.includes("%")), "别把余弦写成百分比");
  });
});
