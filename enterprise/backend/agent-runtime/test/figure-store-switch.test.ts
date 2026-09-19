/**
 * [F-20-03][AC-20-1] 图文索引按开关选后端（M81-03 / ACR-030）。
 *
 * 三条容易写错的分支各有一条断言：缺省要回 pgvector、Qdrant 连不上要**退回而不是崩**、
 * 不认识的值要告警而不是静默。留在 index.ts 的启动流程里只能靠真跑验证，
 * 而真跑验证不了"配了个不认识的值"这种分支——所以逻辑抽了出来，这里注入依赖测。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pickFigureStore, FIGURE_STORE_KINDS } from "../src/figure-store-pick";
import type { FigureStore } from "@carlife/rag";

/** 两个可分辨的桩：只要能认出选中的是哪一个就够。 */
const stub = (tag: string): FigureStore => ({
  async upsertMany() {
    return 0;
  },
  async nearest() {
    return [];
  },
  async deleteByDoc() {
    return 0;
  },
  // 打标记用，不在契约里
  ...({ __tag: tag } as object),
});

const pg = stub("pg");
const qd = stub("qdrant");
const tagOf = (s: FigureStore): string => (s as unknown as { __tag: string }).__tag;

describe("[F-20-03][AC-20-1] 选后端", () => {
  it("不设开关 → pgvector（缺省必须与历史行为相同）", async () => {
    const warns: string[] = [];
    const r = await pickFigureStore({ wanted: undefined, pg, probeQdrant: async () => ({ store: qd, points: 9 }), warn: (m) => warns.push(m) });
    assert.equal(r.kind, "pgvector");
    assert.equal(tagOf(r.store), "pg");
    assert.deepEqual(warns, [], "缺省路径不该有告警");
  });

  it("显式 pgvector → pgvector，且不去探 Qdrant", async () => {
    let probed = false;
    const r = await pickFigureStore({
      wanted: "pgvector",
      pg,
      probeQdrant: async () => {
        probed = true;
        return { store: qd, points: 9 };
      },
    });
    assert.equal(r.kind, "pgvector");
    assert.equal(probed, false, "选 pgvector 时不该去连 Qdrant");
  });

  it("qdrant 且探活成功 → qdrant，label 带 point 数", async () => {
    const r = await pickFigureStore({ wanted: "qdrant", pg, probeQdrant: async () => ({ store: qd, points: 1534 }) });
    assert.equal(r.kind, "qdrant");
    assert.equal(tagOf(r.store), "qdrant");
    assert.match(r.label, /1534/);
  });

  it("**qdrant 但连不上 → 退回 pgvector 并告警，不抛**——起不来是事故", async () => {
    const warns: string[] = [];
    const r = await pickFigureStore({ wanted: "qdrant", pg, probeQdrant: async () => null, warn: (m) => warns.push(m) });
    assert.equal(r.kind, "pgvector");
    assert.equal(tagOf(r.store), "pg");
    assert.equal(warns.length, 1);
    assert.match(warns[0], /连不上/);
    assert.match(r.label, /退回来的/, "日志里必须看得出是退回来的，不能与正常选 pgvector 混同");
  });

  it("探活函数自己抛也退回 pgvector，不把异常漏到启动流程", async () => {
    const warns: string[] = [];
    const r = await pickFigureStore({
      wanted: "qdrant",
      pg,
      probeQdrant: async () => {
        throw new Error("ECONNREFUSED");
      },
      warn: (m) => warns.push(m),
    });
    assert.equal(r.kind, "pgvector");
    assert.equal(warns.length, 1);
  });

  it("不认识的值 → 按 pgvector 处理并告警（不是静默）", async () => {
    const warns: string[] = [];
    const r = await pickFigureStore({ wanted: "milvus", pg, probeQdrant: async () => ({ store: qd, points: 1 }), warn: (m) => warns.push(m) });
    assert.equal(r.kind, "pgvector");
    assert.equal(warns.length, 1);
    assert.match(warns[0], /milvus/);
    assert.match(warns[0], /不认识/);
  });

  it("值两侧有空格也认（.env 里手写容易带空格）", async () => {
    const r = await pickFigureStore({ wanted: "  qdrant  ", pg, probeQdrant: async () => ({ store: qd, points: 3 }) });
    assert.equal(r.kind, "qdrant");
  });

  it("合法取值就这两个——与注册表的 options 同一份认知", () => {
    assert.deepEqual([...FIGURE_STORE_KINDS], ["pgvector", "qdrant"]);
  });
});
