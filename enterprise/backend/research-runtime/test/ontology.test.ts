/**
 * 嵌入、主题聚类、行为分群（施工单 M82-05）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EMBED_BATCH, embedTexts } from "../src/ontology/embed";
import { buildThemeClusters, clusterCountFor, type ThemeCandidate } from "../src/ontology/themes";
import {
  SEGMENT_FEATURES,
  buildVehicleFeatures,
  centroidSimilarity,
  kmeans,
  verdictOf,
  zScore,
} from "../src/ontology/segments";

// ── 嵌入 ───────────────────────────────────────────────

/** 假 fetch：记下请求，按 `dimensions` 造一批向量。 */
function fakeEmbedFetch(opts: { dims?: number; failFirst?: boolean } = {}) {
  const calls: Array<{ input: string[]; dimensions: number }> = [];
  let n = 0;
  const impl: typeof fetch = async (_url, init) => {
    n += 1;
    const body = JSON.parse(String((init as RequestInit).body)) as { input: string[]; dimensions: number };
    calls.push(body);
    if (opts.failFirst && n === 1) return new Response("boom", { status: 500 });
    const dims = opts.dims ?? body.dimensions;
    return new Response(
      JSON.stringify({
        data: body.input.map((_, i) => ({ index: i, embedding: new Array<number>(dims).fill(0.1) })),
        usage: { prompt_tokens: body.input.length * 8 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { impl, calls: () => calls, requests: () => n };
}

const cfg = (fetchImpl: typeof fetch) => ({
  apiKey: "k",
  model: "text-embedding-v4",
  dimensions: 1024,
  fetchImpl,
});

describe("[M82-05] 嵌入", () => {
  /**
   * 供应商硬上限。DashScope 的 `text-embedding-v4` 超过 10 段就回
   * `batch size is invalid, it should not be larger than 10`。
   * 这个数字属于供应商，不属于我们——单独立一条断言，让「顺手调大批量提速」
   * 这个念头在改代码的当下就被拦住，而不是等到线上 30 个任务全红。
   */
  const VENDOR_MAX_BATCH = 10;

  it(`批量不得超过供应商上限 ${VENDOR_MAX_BATCH}——2026-09-13 真跑到 400 才发现原值 50 从没走通过`, () => {
    assert.ok(
      EMBED_BATCH <= VENDOR_MAX_BATCH,
      `EMBED_BATCH=${EMBED_BATCH} > ${VENDOR_MAX_BATCH}：DashScope 会回 400 InvalidParameter`,
    );
  });

  it("按 EMBED_BATCH 切批，dimensions 传出去", async () => {
    const f = fakeEmbedFetch();
    // 刻意取「两整批 + 一个零头」，这样批次边界与余数都被覆盖到。
    const total = EMBED_BATCH * 2 + 3;
    const texts = Array.from({ length: total }, (_, i) => `句子 ${i}`);
    const r = await embedTexts(texts, cfg(f.impl));

    assert.equal(r.vectors.length, total);
    assert.equal(f.calls().length, 3, `${total} / ${EMBED_BATCH} 应切 3 批`);
    // 期望从常量算出来，不写死——写死正是上一版漏掉这个 bug 的原因。
    assert.deepEqual(f.calls().map((c) => c.input.length), [EMBED_BATCH, EMBED_BATCH, 3]);
    for (const c of f.calls()) assert.equal(c.dimensions, 1024);
  });

  it("维度不符直接抛——列是 vector(1024)，让 PG 报错会离根因很远", async () => {
    const f = fakeEmbedFetch({ dims: 512 });
    await assert.rejects(() => embedTexts(["a"], cfg(f.impl)), /research_embed_dim/);
  });

  it("失败重试一次", async () => {
    const f = fakeEmbedFetch({ failFirst: true });
    const r = await embedTexts(["a"], cfg(f.impl));
    assert.equal(r.vectors.length, 1);
    assert.equal(f.requests(), 2);
  });

  it("乱序返回按 index 排回原序——否则向量会挂到别的单元上", async () => {
    const impl: typeof fetch = async (_u, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { input: string[] };
      const data = body.input.map((_, i) => ({ index: i, embedding: new Array<number>(1024).fill(i) }));
      return new Response(JSON.stringify({ data: data.reverse(), usage: {} }), { status: 200 });
    };
    const r = await embedTexts(["a", "b", "c"], cfg(impl));
    assert.equal(r.vectors[0][0], 0);
    assert.equal(r.vectors[2][0], 2);
  });

  it("回来的条数对不上就抛", async () => {
    const impl: typeof fetch = async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array<number>(1024).fill(0) }] }), { status: 200 });
    await assert.rejects(() => embedTexts(["a", "b"], cfg(impl)), /research_embed_count/);
  });

  it("token 数累加，供 llm_usage 记账", async () => {
    const f = fakeEmbedFetch();
    const r = await embedTexts(Array.from({ length: 60 }, (_, i) => `s${i}`), cfg(f.impl));
    assert.equal(r.promptTokens, 60 * 8);
  });
});

// ── 主题聚类 ─────────────────────────────────────────────

const candidate = (i: number, code: string, isCounter = false): ThemeCandidate => ({
  unitId: `u${i}`,
  needPainCode: code,
  isCounter,
  text: `句子 ${i}`,
  // 两簇：偶数在 [1,0]，奇数在 [0,1]。
  embedding: i % 2 === 0 ? [1, 0] : [0, 1],
});

describe("[M82-05] 主题聚类", () => {
  it("反例成员进 counter_unit_ids，不进 member_unit_ids", () => {
    const cands = [
      ...Array.from({ length: 8 }, (_, i) => candidate(i * 2, "cold-range-loss")),
      candidate(101, "cold-range-loss", true),
    ];
    const clusters = buildThemeClusters(cands);
    const all = clusters.flatMap((c) => c.memberUnitIds);
    assert.ok(!all.includes("u101"), "反例不该出现在 member_unit_ids 里");
    assert.ok(clusters.some((c) => c.counterUnitIds.includes("u101")));
  });

  it("按需求码分组——不同码不会聚进同一簇", () => {
    const cands = [
      ...Array.from({ length: 6 }, (_, i) => candidate(i, "cold-range-loss")),
      ...Array.from({ length: 6 }, (_, i) => candidate(i + 100, "range-anxiety")),
    ];
    const clusters = buildThemeClusters(cands);
    for (const c of clusters) {
      assert.ok(["cold-range-loss", "range-anxiety"].includes(c.needPainCode));
    }
    assert.ok(clusters.some((c) => c.needPainCode === "cold-range-loss"));
    assert.ok(clusters.some((c) => c.needPainCode === "range-anxiety"));
  });

  it("`none` 不参与聚类", () => {
    const clusters = buildThemeClusters(Array.from({ length: 8 }, (_, i) => candidate(i, "none")));
    assert.equal(clusters.length, 0);
  });

  it("条数太少不细分", () => {
    assert.equal(clusterCountFor(3), 1);
    assert.ok(clusterCountFor(40) >= 2);
    assert.ok(clusterCountFor(400) <= 4, "码内簇数有上限，超过只会切出噪声");
  });

  it("同输入两次结果相同——k-means 不许随机初始化", () => {
    const cands = Array.from({ length: 12 }, (_, i) => candidate(i, "cold-range-loss"));
    const a = JSON.stringify(buildThemeClusters(cands));
    const b = JSON.stringify(buildThemeClusters(cands));
    assert.equal(a, b);
  });

  it("代表句取离质心最近的，最多 5 条", () => {
    const clusters = buildThemeClusters(Array.from({ length: 20 }, (_, i) => candidate(i, "cold-range-loss")));
    for (const c of clusters) assert.ok(c.examples.length <= 5);
  });
});

// ── 行为分群 ─────────────────────────────────────────────

describe("[M82-05] 行为分群", () => {
  const trip = (vin: string, over: Record<string, unknown> = {}) => ({
    vin,
    distanceKm: 30,
    roadType: "city",
    ambientTempC: 20,
    observedRangeKm: 450,
    socDelta: null,
    ...over,
  });

  it("八个变量都算得出来", () => {
    const rows = buildVehicleFeatures(
      [trip("V1"), trip("V1", { distanceKm: 300, roadType: "highway" })],
      [{ vin: "V1", source: "voice" }, { vin: "V1", source: "text" }],
      { V1: 2 },
      30,
    );
    assert.equal(rows.length, 1);
    const v = rows[0].values;
    for (const f of SEGMENT_FEATURES) assert.ok(Number.isFinite(v[f]), `${f} 不是有限数`);
    assert.ok(Math.abs(v.longTripRatio - 0.5) < 1e-9);
    assert.ok(Math.abs(v.cityRatio - 0.5) < 1e-9);
    assert.ok(Math.abs(v.voiceRatio - 0.5) < 1e-9);
    assert.equal(v.memberCount, 2);
  });

  it("低温行程比例按 < 5℃ 判", () => {
    const rows = buildVehicleFeatures(
      [trip("V1", { ambientTempC: -5 }), trip("V1", { ambientTempC: 20 }), trip("V1", { ambientTempC: 4 })],
      [],
      {},
      30,
    );
    assert.ok(Math.abs(rows[0].values.coldTripRatio - 2 / 3) < 1e-9);
  });

  it("z-score 对零方差维度给 0，不产生 NaN", () => {
    const rows = buildVehicleFeatures([trip("V1"), trip("V2")], [], {}, 30);
    const z = zScore(rows);
    for (const row of z) for (const x of row) assert.ok(Number.isFinite(x), "出现了 NaN——除零没挡住");
  });

  it("k-means 确定性：同输入两次同结果", () => {
    const pts = Array.from({ length: 20 }, (_, i) => [i % 5, Math.floor(i / 5)]);
    assert.deepEqual(kmeans(pts, 3).assignments, kmeans(pts, 3).assignments);
  });

  it("k 大于点数时退化到点数，不抛", () => {
    const r = kmeans([[1, 1], [2, 2]], 5);
    assert.equal(r.centroids.length, 2);
  });

  it("外部验证：差 ≥ 0.1 且 n ≥ 10 才算过", () => {
    assert.equal(verdictOf({ metric: "m", value: 0.8, overall: 0.5, n: 12 }), "validated");
    assert.equal(verdictOf({ metric: "m", value: 0.55, overall: 0.5, n: 12 }), "insufficient", "差不够");
    assert.equal(verdictOf({ metric: "m", value: 0.8, overall: 0.5, n: 4 }), "insufficient", "样本不够");
    assert.equal(verdictOf(null), "insufficient", "没有外部变量就不能是 validated");
  });

  it("质心相似度：同向 1，正交 0", () => {
    assert.ok(Math.abs(centroidSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
    assert.ok(Math.abs(centroidSimilarity([1, 0], [0, 1])) < 1e-9);
    assert.equal(centroidSimilarity([0, 0], [1, 0]), 0, "零向量不该产生 NaN");
  });
});
