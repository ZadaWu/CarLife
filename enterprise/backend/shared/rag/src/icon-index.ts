/**
 * 图标图文索引：向量化、入库、双路召回（施工单 M71-03，ACR-025）。
 *
 * # 向量只召回不裁决
 *
 * 这里出来的是候选与分数；判断是不是同一个符号在 `icon-verify.ts`（闸门 + 成对核验）。
 *
 * # 图与文同空间
 *
 * DashScope `qwen3-vl-embedding`（2026-09-08 探针：维度 2560；同符号图-文 0.36–0.48，错配 0.09–0.15）。
 * 所以用户 crop 的**图像向量**可以直接对手册侧的**文本向量**做近邻——手册图标图片还没到位时
 * 文本路就能工作；图片到位后多一路图像向量，召回更稳。
 *
 * # 两路 → RRF
 *
 * 图像路：crop 图像向量 → 近邻；文本路：观察描述子规范化串的文本向量 → 近邻。
 * 两路各取 top-k，按 symbol_id 做 RRF（k=60）融合；同一符号在两路都靠前的排最前。
 *
 * 不依赖 @carlife/db：只声明 `IconStore` 形状，db 的仓储按它实现（避免 tools → rag → db 的环）。
 */

import { normalizeDescriptor, type IconCatalogEntry, type IconDescriptor } from "./icon-catalog";

export interface Embedder {
  readonly model: string;
  readonly dimension: number | null;
  embedImage(image: Buffer): Promise<number[]>;
  embedText(text: string): Promise<number[]>;
}

export interface IconStoreRow {
  vehicleModel: string;
  symbolId: string;
  side: "manual" | "user";
  kind: "image" | "text";
  descriptor: unknown;
  sourceAsset: string;
  manualAnchor: string | null;
}

export interface IconStore {
  upsertMany(rows: readonly (IconStoreRow & { embedding: number[] })[]): Promise<number>;
  nearest(q: { vector: number[]; k: number; vehicleModel?: string; side?: "manual" | "user"; kind?: "image" | "text" }): Promise<Array<IconStoreRow & { distance: number }>>;
}

export const DASHSCOPE_EMBED_URL = "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";
export const DEFAULT_EMBED_MODEL = "qwen3-vl-embedding";

export class IconEmbedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IconEmbedError";
  }
}

const dataUrl = (image: Buffer): string => {
  const isPng = image.length > 8 && image[0] === 0x89 && image[1] === 0x50;
  return `data:${isPng ? "image/png" : "image/jpeg"};base64,${image.toString("base64")}`;
};

/** DashScope 原生多模态向量接口（融合向量与独立向量都不走 OpenAI 兼容口）。 */
export function createDashScopeEmbedder(opts: { apiKey: string; model?: string; fetch?: typeof fetch; timeoutMs?: number }): Embedder {
  const model = opts.model ?? DEFAULT_EMBED_MODEL;
  const doFetch = opts.fetch ?? fetch;
  let dimension: number | null = null;
  async function embed(contents: Array<{ image: string } | { text: string }>): Promise<number[]> {
    const res = await doFetch(DASHSCOPE_EMBED_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ model, input: { contents }, parameters: {} }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const json = (await res.json().catch(() => ({}))) as { output?: { embeddings?: Array<{ embedding: number[] }> }; message?: string; code?: string };
    if (!res.ok) throw new IconEmbedError(`DashScope embedding HTTP ${res.status}: ${json.code ?? ""} ${json.message ?? ""}`.trim());
    const v = json.output?.embeddings?.[0]?.embedding;
    if (!v || v.length === 0) throw new IconEmbedError("DashScope embedding 返回空向量");
    dimension = v.length;
    return v;
  }
  return {
    model,
    get dimension() {
      return dimension;
    },
    embedImage: (image) => embed([{ image: dataUrl(image) }]),
    embedText: (text) => embed([{ text }]),
  };
}

export interface BuildIndexResult {
  vehicleModel: string;
  textRows: number;
  imageRows: number;
  skippedImages: string[];
  /** 目录里标了 `deprecated` 因而没进索引的条数（该车型手册里没有这个符号）。 */
  deprecatedSkipped: number;
}

/** 手册侧入库：每条一条文本向量；有图片文件的再加一条图像向量。 */
export async function buildIconIndex(
  entries: readonly IconCatalogEntry[],
  deps: { embedder: Embedder; store: IconStore; readImage?: (file: string) => Buffer | null },
): Promise<BuildIndexResult> {
  const rows: Array<IconStoreRow & { embedding: number[] }> = [];
  const skippedImages: string[] = [];
  let imageRows = 0;
  let deprecated = 0;
  for (const e of entries) {
    // 废弃条目（该车型手册里根本没有这个符号）不进索引：留在目录里是为了不让人再补一遍，
    // 但它一旦进了向量库就会被召回，等于把编造的东西又放回判定链上。
    if (e.descriptorSource === "deprecated") {
      deprecated += 1;
      continue;
    }
    const semantics = { name: e.name, class: e.class, severity: e.severity, manualAnchor: e.manualAnchor, descriptorSource: e.descriptorSource };
    const text = normalizeDescriptor(e.descriptor);
    rows.push({
      vehicleModel: e.vehicleModel,
      symbolId: e.symbolId,
      side: "manual",
      kind: "text",
      descriptor: { ...e.descriptor, text_query: text, ...semantics },
      sourceAsset: "",
      manualAnchor: e.manualAnchor,
      embedding: await deps.embedder.embedText(text),
    });
    if (e.imageFile && deps.readImage) {
      const img = deps.readImage(e.imageFile);
      if (!img) {
        skippedImages.push(e.imageFile);
        continue;
      }
      rows.push({
        vehicleModel: e.vehicleModel,
        symbolId: e.symbolId,
        side: "manual",
        kind: "image",
        descriptor: { ...e.descriptor, ...semantics },
        sourceAsset: e.imageFile,
        manualAnchor: e.manualAnchor,
        embedding: await deps.embedder.embedImage(img),
      });
      imageRows += 1;
    }
  }
  await deps.store.upsertMany(rows);
  return { vehicleModel: entries[0]?.vehicleModel ?? "", textRows: entries.length - deprecated, imageRows, skippedImages, deprecatedSkipped: deprecated };
}

export interface Candidate {
  symbolId: string;
  /** RRF 融合分（越大越靠前） */
  fused: number;
  /** 各路的最高余弦相似度（1 − 距离） */
  imageSim: number | null;
  textSim: number | null;
  /** 命中的手册行（取相似度最高的一行）——含名称 / 类别 / 级别 / 锚点 */
  row: IconStoreRow & { distance: number };
}

export const RRF_K = 60;

/** 按 symbol_id 做 RRF：每路按距离升序排名，score = Σ 1/(k + rank)。 */
export function fuseByRrf(lists: ReadonlyArray<ReadonlyArray<IconStoreRow & { distance: number }>>, k = RRF_K): Candidate[] {
  const acc = new Map<string, Candidate>();
  lists.forEach((list, li) => {
    const seen = new Set<string>();
    list.forEach((row, rank) => {
      // 同一符号在同一路只计最靠前的一行
      if (seen.has(row.symbolId)) return;
      seen.add(row.symbolId);
      const sim = 1 - row.distance;
      const cur = acc.get(row.symbolId) ?? { symbolId: row.symbolId, fused: 0, imageSim: null, textSim: null, row };
      cur.fused += 1 / (k + rank + 1);
      if (li === 0) cur.imageSim = Math.max(cur.imageSim ?? -1, sim);
      else cur.textSim = Math.max(cur.textSim ?? -1, sim);
      if (row.distance < cur.row.distance) cur.row = row;
      acc.set(row.symbolId, cur);
    });
  });
  return [...acc.values()].sort((a, b) => b.fused - a.fused);
}

export interface RecallArgs {
  crop?: Buffer;
  descriptor?: IconDescriptor;
  vehicleModel?: string;
  k?: number;
}

/** 双路召回：图像路（crop 向量）∪ 文本路（描述子串向量）→ RRF。任一路缺输入就只跑另一路。 */
export async function recallCandidates(args: RecallArgs, deps: { embedder: Embedder; store: IconStore }): Promise<{ candidates: Candidate[]; paths: string[] }> {
  const k = args.k ?? 8;
  const lists: Array<Array<IconStoreRow & { distance: number }>> = [];
  const paths: string[] = [];
  if (args.crop) {
    const v = await deps.embedder.embedImage(args.crop);
    lists.push(await deps.store.nearest({ vector: v, k, vehicleModel: args.vehicleModel, side: "manual" }));
    paths.push("image");
  } else {
    lists.push([]);
  }
  if (args.descriptor) {
    const v = await deps.embedder.embedText(normalizeDescriptor(args.descriptor));
    lists.push(await deps.store.nearest({ vector: v, k, vehicleModel: args.vehicleModel, side: "manual" }));
    paths.push("text");
  } else {
    lists.push([]);
  }
  return { candidates: fuseByRrf(lists), paths };
}
