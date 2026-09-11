/**
 * [F-24-02][AC-24-8] 图标目录解析、描述子规范化、RRF 融合、两道闸门与成对核验的三态——全部离线，
 * embedder / store / verifyPair 用测试内的桩。[F-16-03][AC-16-2] 真目录文件能解析且级别表自洽。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { normalizeDescriptor, parseIconCatalog, severityFor } from "../src/icon-catalog";
import { buildIconIndex, fuseByRrf, recallCandidates, type Candidate, type Embedder, type IconStore, type IconStoreRow } from "../src/icon-index";
import { DEFAULT_DELTA, DEFAULT_TAU, decideMatch, gate } from "../src/icon-verify";

const CATALOG = readFileSync(new URL("../../../../../data/kb-src/icons/tesla-model3-indicators.md", import.meta.url), "utf8");

describe("[F-24-02][AC-24-8] 图标目录", () => {
  it("真目录解析无错、27 条、symbol_id 唯一、级别与类别×颜色表自洽", () => {
    const { vehicleModel, entries, errors } = parseIconCatalog(CATALOG);
    assert.deepEqual(errors, []);
    assert.equal(vehicleModel, "Tesla Model 3/Y");
    assert.equal(entries.length, 28, "27 条有效 + 1 条废弃占位");
    assert.equal(new Set(entries.map((e) => e.symbolId)).size, 28);
    for (const e of entries) assert.equal(e.severity, severityFor(e.class, e.descriptor.color), e.symbolId);
  });
  it("2026-09-09 对图之后：有效条目全部 manual-image 且带图片；废弃条目只有 fog_lamp_front 且无图", () => {
    const { entries } = parseIconCatalog(CATALOG);
    const dead = entries.filter((e) => e.descriptorSource === "deprecated");
    assert.deepEqual(dead.map((e) => e.symbolId), ["fog_lamp_front"], "Model 3 手册里没有前雾灯指示灯");
    assert.deepEqual(dead.map((e) => e.imageFile), [""]);
    const live = entries.filter((e) => e.descriptorSource !== "deprecated");
    assert.equal(live.length, 27);
    // 对完图就不该再有 standard-symbol：留一条没对图的，匹配出来的名称就仍然只能说「疑似」
    assert.deepEqual(live.filter((e) => e.descriptorSource !== "manual-image").map((e) => e.symbolId), []);
    assert.deepEqual(live.filter((e) => !e.imageFile.endsWith(".png")).map((e) => e.symbolId), []);
  });
  it("级别二维表：红色故障 stop、琥珀故障 check_soon、红色提醒 info", () => {
    assert.equal(severityFor("fault", "red"), "stop");
    assert.equal(severityFor("fault", "amber"), "check_soon");
    assert.equal(severityFor("reminder", "red"), "info");
    assert.equal(severityFor("status", "green"), "info");
  });
  it("解析拦：severity 与表不符、class 越界、symbol_id 重复", () => {
    const bad = `vehicle: X\n| symbol_id | 名称 | class | severity | shape | color | elements | text | 手册锚点 | 原文说明 | 描述子来源 | 图片 |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n| a_1 | 甲 | fault | info | circle | red | - | - | § | 说明 | standard-symbol | - |\n| a_1 | 乙 | weird | info | circle | red | - | - | § | 说明 | standard-symbol | - |`;
    const { errors } = parseIconCatalog(bad);
    assert.ok(errors.some((e) => e.includes("severity")));
    assert.ok(errors.some((e) => e.includes("class 越界")));
    assert.ok(errors.some((e) => e.includes("重复")));
  });
  it("normalizeDescriptor：固定顺序的中文串，literal 不参与，unknown 跳过", () => {
    assert.equal(normalizeDescriptor({ shape: "person", color: "red", elements: ["diagonal_band"], text: [], state: "lit" }), "红色 人形 斜带 点亮");
    assert.equal(normalizeDescriptor({ shape: "lamp", color: "gray", elements: ["straight_lines"], text: ["A"], state: "unknown" }), "灰色 灯形 直线 字 A");
  });
});

// ── 桩 ──
const row = (symbolId: string, distance: number, kind: "image" | "text" = "text", extra: Record<string, unknown> = {}): IconStoreRow & { distance: number } => ({
  vehicleModel: "V",
  symbolId,
  side: "manual",
  kind,
  descriptor: { name: `名-${symbolId}`, class: "reminder", severity: "info", ...extra },
  sourceAsset: kind === "image" ? `${symbolId}.png` : "",
  manualAnchor: `§${symbolId}`,
  distance,
});

describe("[F-24-02][AC-24-8] RRF 与闸门", () => {
  it("两路都靠前的符号排最前；同一路同一符号只计一次；各路相似度取最高", () => {
    const image = [row("a", 0.6, "image"), row("b", 0.7, "image"), row("a", 0.65, "image")];
    const text = [row("b", 0.5), row("c", 0.55), row("a", 0.8)];
    const fused = fuseByRrf([image, text]);
    // b：图像路第 2、文本路第 1 → 1/62 + 1/61；a：图像路第 1、文本路第 3 → 1/61 + 1/63。b 略高于 a，c 只在一路。
    assert.deepEqual(fused.map((c) => c.symbolId), ["b", "a", "c"]);
    const a = fused.find((c) => c.symbolId === "a")!;
    assert.ok(Math.abs(a.imageSim! - 0.4) < 1e-9, "a 的图像相似度取两行里最高的 1-0.6");
    assert.ok(Math.abs(a.textSim! - 0.2) < 1e-9);
    assert.equal(fused.find((c) => c.symbolId === "c")!.imageSim, null);
  });
  it("gate：无候选 / 低于 τ / 边际不足 各自的拒绝理由；通过时带 sim 与 margin", () => {
    assert.equal(gate([]).pass, false);
    const low: Candidate = { symbolId: "x", fused: 0.03, imageSim: DEFAULT_TAU - 0.01, textSim: null, row: row("x", 0.9) };
    assert.equal((gate([low]) as { reason: string }).reason, "below_tau");
    const a: Candidate = { symbolId: "a", fused: 0.0320, imageSim: 0.5, textSim: null, row: row("a", 0.5) };
    const b: Candidate = { symbolId: "b", fused: 0.0300, imageSim: 0.5 - DEFAULT_DELTA / 2, textSim: null, row: row("b", 0.51) };
    // 边际量的是相似度差，不是 RRF 融合分差——融合分两名之差只有 0.0003 量不出东西
    assert.equal((gate([a, b]) as { reason: string }).reason, "below_delta");
    const g = gate([a, { ...b, imageSim: 0.35 }]);
    assert.ok(g.pass && g.sim === 0.5 && Math.abs(g.margin - 0.15) < 1e-9);
  });

  it("sim 与 margin 在同一条路上算：分不开的那条路不能盖掉分得开的那条（2026-09-09 实测回归）", () => {
    // tesla-01 上手册图标图片入库后的真实数字：驻车灯 vs 近光灯，图像分得开、文本分不开（描述子同形）。
    // 旧写法对每个候选先跨模态取 max（都取到文本的 0.96）再相减，margin=0 被拦——融合路反而比只用图像路差。
    const park: Candidate = { symbolId: "parking_lights", fused: 0.032, imageSim: 0.70, textSim: 0.96, row: row("parking_lights", 0.7) };
    const low: Candidate = { symbolId: "low_beam", fused: 0.031, imageSim: 0.57, textSim: 0.96, row: row("low_beam", 0.57) };
    const g = gate([park, low]);
    assert.ok(g.pass, "图像路 0.70 vs 0.57 拉得开，应当通过");
    assert.ok(Math.abs(g.margin - 0.13) < 1e-9, "证据取边际更大的那一路（图像）");
    assert.ok(Math.abs(g.sim - 0.70) < 1e-9);
    // 两条路都拉不开时照样拦住——这道门存在的理由不能被上面那条放松掉
    const flat = gate([{ ...park, imageSim: 0.96 }, { ...low, imageSim: 0.96 }]);
    assert.equal((flat as { reason: string }).reason, "below_delta");
  });
});

describe("[F-24-02][AC-24-8] decideMatch 三态", () => {
  const a: Candidate = { symbolId: "a", fused: 0.05, imageSim: 0.5, textSim: 0.4, row: row("a", 0.5, "text", { name: "甲灯", class: "fault", severity: "stop" }) };
  const crop = Buffer.from("crop");
  it("核验 same → matched + verified，语义来自手册行", async () => {
    const r = await decideMatch([a], crop, { iconImage: () => Buffer.from("icon"), verifyPair: async () => "same" });
    assert.ok(r.matched && r.verified);
    assert.equal(r.semantics.name, "甲灯");
    assert.equal(r.semantics.severity, "stop");
  });
  it("核验 unsure / different → 未匹配，但把 top 语义带出去供「疑似」措辞", async () => {
    const r = await decideMatch([a], crop, { iconImage: () => Buffer.from("icon"), verifyPair: async () => "unsure" });
    assert.ok(!r.matched && r.reason === "verify_unsure" && r.top?.symbolId === "a");
  });
  it("手册没有该图标图片 → matched 但 verified=false，evidence 写明未核验", async () => {
    const r = await decideMatch([a], crop, { iconImage: () => null, verifyPair: async () => "same" });
    assert.ok(r.matched && !r.verified && r.evidence.includes("未核验"));
  });
  it("闸门不过 → 未匹配", async () => {
    const r = await decideMatch([{ ...a, imageSim: 0.1, textSim: 0.1 }], crop, {});
    assert.ok(!r.matched && r.reason === "below_tau");
  });
});

describe("[F-16-03][AC-16-2] 建索引与双路召回（桩）", () => {
  function fakes(): { embedder: Embedder; store: IconStore; rows: Array<IconStoreRow & { embedding: number[] }>; calls: string[] } {
    const rows: Array<IconStoreRow & { embedding: number[] }> = [];
    const calls: string[] = [];
    const embedder: Embedder = {
      model: "fake",
      dimension: 3,
      embedImage: async () => {
        calls.push("image");
        return [1, 0, 0];
      },
      embedText: async (t) => {
        calls.push(`text:${t}`);
        return t.includes("红色") ? [1, 0, 0] : [0, 1, 0];
      },
    };
    const store: IconStore = {
      async upsertMany(xs) {
        rows.push(...xs);
        return xs.length;
      },
      async nearest(q) {
        const cos = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i], 0);
        return rows
          .filter((r) => (q.kind ? r.kind === q.kind : true))
          .map((r) => ({ ...r, distance: 1 - cos(r.embedding, q.vector) }))
          .sort((x, y) => x.distance - y.distance)
          .slice(0, q.k);
      },
    };
    return { embedder, store, rows, calls };
  }
  it("每条一条文本向量；有图片再加图像向量；无图片文件记 skipped", async () => {
    const { embedder, store, rows } = fakes();
    const { entries } = parseIconCatalog(CATALOG);
    const withImage = entries.slice(0, 2).map((e, i) => ({ ...e, imageFile: i === 0 ? "a.png" : "missing.png" }));
    const r = await buildIconIndex(withImage, { embedder, store, readImage: (f) => (f === "a.png" ? Buffer.from("x") : null) });
    assert.equal(r.textRows, 2);
    assert.equal(r.imageRows, 1);
    assert.deepEqual(r.skippedImages, ["missing.png"]);
    assert.equal(rows.length, 3);
    assert.ok((rows[0].descriptor as { text_query: string }).text_query.length > 0);
  });
  it("召回：有 crop 走图像路、有描述子走文本路，都有就两路融合", async () => {
    const { embedder, store, calls } = fakes();
    const { entries } = parseIconCatalog(CATALOG);
    await buildIconIndex(entries, { embedder, store });
    const r = await recallCandidates({ crop: Buffer.from("c"), descriptor: { shape: "person", color: "red", elements: ["diagonal_band"], text: [] } }, { embedder, store });
    assert.deepEqual(r.paths, ["image", "text"]);
    assert.ok(r.candidates.length > 0);
    assert.ok(calls.some((c) => c === "image") && calls.some((c) => c.startsWith("text:红色")));
    const only = await recallCandidates({ descriptor: { shape: "lamp", color: "green", elements: [], text: [] } }, { embedder, store });
    assert.deepEqual(only.paths, ["text"]);
  });
});
