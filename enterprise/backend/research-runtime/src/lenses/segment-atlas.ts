/**
 * 镜头四·分群图谱（施工单 M82-05）。
 *
 * 聚类在 `ontology/segments.ts`（先行为后语义）；本文件只把结果**摆成快照**，
 * 并在落库前做小单元抑制——被抑制的群 `rows` 为空，不是前端隐藏。
 */

import { suppressCells, suppressionReason, type MaybeSuppressed } from "@carlife/research";
import type { SegmentAtlasData, SegmentRows, SuppressedRef } from "@carlife/research";

import { centroidSimilarity, verdictOf, type ExternalMetric } from "../ontology/segments";

/** 一个群在摆成快照之前的样子。 */
export interface SegmentDraft {
  id: string;
  name: string;
  vins: string[];
  centroid: number[];
  rows: SegmentRows;
  external: ExternalMetric | null;
  tags: string[];
}

export interface SegmentAtlasOptions {
  minCellVehicles: number;
  /** 全体车辆数，算占比用。 */
  totalVehicles: number;
}

/** 抑制态下的空六行——`rows` 必须在场（类型要求），但一个字都不能有。 */
const BLANK_ROWS: SegmentRows = {
  task: "",
  constraint: "",
  alternative: "",
  value: "",
  behavior: "",
  reach: { value: 0, kind: "estimated" },
};

export function buildSegmentAtlas(drafts: readonly SegmentDraft[], opts: SegmentAtlasOptions): SegmentAtlasData {
  const suppressed: SuppressedRef[] = [];

  const shaped = drafts.map((d) => {
    const size = d.vins.length;
    const verdict = verdictOf(d.external, opts.minCellVehicles);
    const cell = {
      id: d.id,
      name: d.name,
      size,
      pct: opts.totalVehicles === 0 ? 0 : size / opts.totalVehicles,
      // 群的状态有三档，`validated` 只给"在没参与聚类的变量上也不一样"的群。
      status: (size < opts.minCellVehicles ? "suppressed" : verdict === "validated" ? "validated" : "draft") as
        | "draft"
        | "validated"
        | "suppressed",
      rows: d.rows,
      externalValidation: d.external
        ? { metric: d.external.metric, value: d.external.value, n: d.external.n, verdict }
        : null,
      tags: d.tags,
    };
    return { cell, vehicles: size };
  });

  const segments: Array<MaybeSuppressed<(typeof shaped)[number]["cell"]>> = shaped.map(({ cell, vehicles }) => {
    if (vehicles >= opts.minCellVehicles) return { ...cell, suppressed: false };
    /*
     * 抑制的群仍然要在图上占一个位置——**它存在这件事本身不是秘密**，
     * 秘密的是它里面有谁、他们的行为长什么样。所以留 id / size / status，
     * 清空 rows 与外部验证。
     */
    suppressed.push({
      key: cell.id,
      reason: suppressionReason(vehicles, opts.minCellVehicles),
      vehicles,
    });
    return {
      ...cell,
      status: "suppressed" as const,
      rows: BLANK_ROWS,
      externalValidation: null,
      tags: [],
      suppressed: false,
    };
  });

  const similarity: SegmentAtlasData["similarity"] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    for (let j = i + 1; j < drafts.length; j += 1) {
      similarity.push({
        a: drafts[i].id,
        b: drafts[j].id,
        score: centroidSimilarity(drafts[i].centroid, drafts[j].centroid),
      });
    }
  }
  similarity.sort((a, b) => b.score - a.score);

  // suppressCells 在这一页不直接用（群要留位置），但阈值口径同源，引用它避免两处漂移。
  void suppressCells;

  return { method: "behavior-kmeans-k5", segments, similarity, suppressed };
}
