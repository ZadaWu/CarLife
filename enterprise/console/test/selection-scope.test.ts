/**
 * 下标 → 语义范围（施工单 M85-04）。
 *
 * 这一步是"后端只认码"这条纪律的实现处：行序会随人群筛选变，
 * 把下标发出去等于发一个会过期的引用，而它过期之后照样解析得出某一行。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectionScope, type MatrixCell, type MatrixView } from "../src/pages/research/shell/model";

const value = (over: Partial<Extract<MatrixCell, { kind: "value" }>> = {}): MatrixCell => ({
  kind: "value",
  n: 12,
  N: 100,
  pct: 0.12,
  bar: 1,
  glyph: "—",
  counter: 2,
  counterDim: false,
  ...over,
});

const suppressed = (): MatrixCell => ({ kind: "suppressed", reason: "小单元抑制：只覆盖 3 台车" });

const view: MatrixView = {
  scenes: [
    { code: "charging", label: "充电补能", N: 100 },
    { code: "long-trip", label: "长途出行", N: 80 },
  ],
  rows: [
    {
      index: 1,
      code: "cold-range-loss",
      label: "低温续航",
      total: 40,
      undeliverable: false,
      catchAll: false,
      cells: [value(), value({ glyph: "↑" })],
    },
    {
      index: 2,
      code: "feature-discovery",
      label: "车机功能找不到",
      total: 20,
      undeliverable: false,
      catchAll: false,
      cells: [value(), suppressed()],
    },
    {
      index: null,
      code: "other",
      label: "其它",
      total: 70,
      undeliverable: false,
      catchAll: true,
      cells: [suppressed(), suppressed()],
    },
  ],
  note: "一轮可归多个需求码",
  turns: 180,
};

describe("[M85-04] selectionScope：三种选中各翻出正确的码", () => {
  it("格 → needPainCode + sceneCode，不是下标", () => {
    const s = selectionScope(view, { kind: "cell", row: 0, col: 1 });
    assert.deepEqual(s, {
      kind: "cell",
      needPainCode: "cold-range-loss",
      sceneCode: "long-trip",
      suppressed: false,
      catchAll: false,
      hasDirection: true,
    });
  });

  it("行 → 只有码与兜底桶标记", () => {
    assert.deepEqual(selectionScope(view, { kind: "row", row: 0 }), {
      kind: "row",
      needPainCode: "cold-range-loss",
      catchAll: false,
      suppressed: false,
    });
  });

  it("列 → 只有场景码", () => {
    assert.deepEqual(selectionScope(view, { kind: "col", col: 0 }), { kind: "col", sceneCode: "charging" });
  });
});

describe("[M85-04] selectionScope：抑制、兜底桶、方向", () => {
  it("被抑制的格 suppressed 为 true", () => {
    const s = selectionScope(view, { kind: "cell", row: 1, col: 1 });
    assert.equal(s?.kind === "cell" && s.suppressed, true);
  });

  it("方向持平（`—`）不算有方向——C3 问的是「这次变化是不是我们干的」", () => {
    const flat = selectionScope(view, { kind: "cell", row: 0, col: 0 });
    assert.equal(flat?.kind === "cell" && flat.hasDirection, false);
    const up = selectionScope(view, { kind: "cell", row: 0, col: 1 });
    assert.equal(up?.kind === "cell" && up.hasDirection, true);
  });

  it("兜底桶行的 catchAll 为 true", () => {
    const s = selectionScope(view, { kind: "row", row: 2 });
    assert.equal(s?.kind === "row" && s.catchAll, true);
  });

  it("**整行的抑制是每一格都被抑制**，不是有一格被抑制", () => {
    // 第 2 行有一格有明细 → 行不算抑制，行级能力还有东西可读。
    const partial = selectionScope(view, { kind: "row", row: 1 });
    assert.equal(partial?.kind === "row" && partial.suppressed, false);
    // 第 3 行两格都抑制 → 行级能力拿到的会是一个全空的行，正是 G1 要挡的。
    const all = selectionScope(view, { kind: "row", row: 2 });
    assert.equal(all?.kind === "row" && all.suppressed, true);
  });
});

describe("[M85-04] selectionScope：越界回 null 不抛", () => {
  it("行、列、格三种越界都回 null", () => {
    assert.equal(selectionScope(view, { kind: "row", row: 99 }), null);
    assert.equal(selectionScope(view, { kind: "col", col: 99 }), null);
    assert.equal(selectionScope(view, { kind: "cell", row: 99, col: 0 }), null);
    assert.equal(selectionScope(view, { kind: "cell", row: 0, col: 99 }), null);
  });

  it("空表上也不抛", () => {
    const empty: MatrixView = { scenes: [], rows: [], note: "", turns: 0 };
    assert.equal(selectionScope(empty, { kind: "cell", row: 0, col: 0 }), null);
  });
});
