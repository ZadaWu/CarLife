/**
 * 手册图文索引：向量化、入库、召回（ACR-029 第 3 / 4 步）。
 *
 * # 与图标索引（icon-index.ts，ACR-025）的关系
 *
 * 同一个向量空间（DashScope `qwen3-vl-embedding`，图-文同空间）、同一种存储（库内 pgvector）、同一套 RRF 融合。
 * **不是同一张表、不是同一个真相源**：图标目录是人写的 27 条（名称 / 级别只能来自它），图示索引是手册里的几百张图
 * 加它们锚定到的段落——它回答的是"手册哪里有讲这个的图"，不回答"这枚灯叫什么"。两者并行，互不覆盖。
 *
 * # 一张图几行
 *
 * - `text`  面包屑 + 图注 + 锚段的文本向量——文字提问（「充电口在哪」）主要靠它。
 * - `image` 整图图像向量——照片提问时用户的 crop 对它做近邻；文字提问也能跨模态命中。
 * - `crop`  指示灯类插图经观察层（YOLO 定位 → 代码定色 → 描述）切出的逐图标 crop：图像向量一行，描述子文本向量一行。
 *   这一步复用 ACR-024/025 已经上线的构件，`observe` 由调用方注入（本包不依赖 @carlife/tools）。
 *
 * # 向量只召回不裁决
 *
 * 出来的是候选与相似度；要不要给车主看由调用方按相似度与锚定置信度决定。
 */

import { fuseByRrf, type Embedder } from "./icon-index";
import { normalizeDescriptor, type IconDescriptor } from "./icon-catalog";
import { figureText, type ManualFigure } from "./figures";

export interface FigureStoreRow {
  doc: string;
  figureId: string;
  page: number;
  location: string;
  breadcrumb: string;
  kind: "image" | "text" | "crop";
  imgPath: string;
  anchorText: string;
  caption: string;
  confidence: number;
  rule: string;
  sourceAsset: string;
  descriptor: unknown;
}

export interface FigureStore {
  upsertMany(rows: readonly (FigureStoreRow & { embedding: number[] })[]): Promise<number>;
  nearest(q: { vector: number[]; k: number; doc?: string; kind?: FigureStoreRow["kind"]; minConfidence?: number }): Promise<Array<FigureStoreRow & { distance: number }>>;
  deleteByDoc(doc: string): Promise<number>;
}

/** 观察层的注入形状：整图进，逐图标 crop 与描述子出。空数组 = 没找到图标（那张图只索引整图）。 */
export type FigureObserver = (image: Buffer) => Promise<Array<{ crop: Buffer; descriptor: IconDescriptor }>>;

export interface BuildFigureIndexOptions {
  /** 锚定置信度低于此的图不进索引（缺省 0.5：`previous-page` 与 `none` 出局）。锚错段比没图更糟。 */
  minConfidence?: number;
  /** 哪些图要过观察层。缺省：插图且面包屑或锚段里有「指示灯 / 警告灯 / 车辆状态 / 仪表」。 */
  observeWhen?: (f: ManualFigure) => boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface BuildFigureIndexResult {
  doc: string;
  figures: number;
  skippedLowConfidence: number;
  textRows: number;
  imageRows: number;
  cropRows: number;
  observed: number;
  /** 读不到图片文件的（只有 text 行） */
  missingImages: string[];
  /** 观察层抛错的图（只索引整图，不拖垮整本） */
  observeFailed: string[];
}

const DEFAULT_OBSERVE_WHEN = (f: ManualFigure): boolean => f.kind === "figure" && /指示灯|警告灯|车辆状态|仪表/.test(`${f.breadcrumb} ${f.anchor.text}`);

export async function buildFigureIndex(
  figs: readonly ManualFigure[],
  deps: { embedder: Embedder; store: FigureStore; readImage: (imgPath: string) => Buffer | null; observe?: FigureObserver },
  opts: BuildFigureIndexOptions = {},
): Promise<BuildFigureIndexResult> {
  const minConfidence = opts.minConfidence ?? 0.5;
  const observeWhen = opts.observeWhen ?? DEFAULT_OBSERVE_WHEN;
  const r: BuildFigureIndexResult = { doc: figs[0]?.doc ?? "", figures: 0, skippedLowConfidence: 0, textRows: 0, imageRows: 0, cropRows: 0, observed: 0, missingImages: [], observeFailed: [] };
  let done = 0;
  for (const f of figs) {
    done += 1;
    opts.onProgress?.(done, figs.length);
    if (f.anchor.confidence < minConfidence) {
      r.skippedLowConfidence += 1;
      continue;
    }
    r.figures += 1;
    const base: Omit<FigureStoreRow, "kind" | "sourceAsset" | "descriptor"> = {
      doc: f.doc,
      figureId: f.id,
      page: f.page,
      location: f.location,
      breadcrumb: f.breadcrumb,
      imgPath: f.imgPath,
      anchorText: f.anchor.text,
      caption: f.caption,
      confidence: f.anchor.confidence,
      rule: f.anchor.rule,
    };
    const meta = { figureKind: f.kind, headings: f.headings, imageKey: f.imageKey, rule: f.anchor.rule };
    const rows: Array<FigureStoreRow & { embedding: number[] }> = [];
    const text = figureText(f);
    rows.push({ ...base, kind: "text", sourceAsset: "", descriptor: { ...meta, text_query: text }, embedding: await deps.embedder.embedText(text) });
    r.textRows += 1;

    const image = f.imgPath ? deps.readImage(f.imgPath) : null;
    if (!image) {
      r.missingImages.push(f.imgPath || f.id);
    } else {
      rows.push({ ...base, kind: "image", sourceAsset: f.imgPath, descriptor: meta, embedding: await deps.embedder.embedImage(image) });
      r.imageRows += 1;
      if (deps.observe && observeWhen(f)) {
        try {
          const crops = await deps.observe(image);
          r.observed += 1;
          let n = 0;
          for (const c of crops) {
            n += 1;
            const q = normalizeDescriptor(c.descriptor);
            const asset = `${f.id}#crop${n}`;
            rows.push({ ...base, kind: "crop", sourceAsset: asset, descriptor: { ...meta, ...c.descriptor, text_query: q, crop: n }, embedding: await deps.embedder.embedImage(c.crop) });
            rows.push({ ...base, kind: "crop", sourceAsset: `${asset}#text`, descriptor: { ...meta, ...c.descriptor, text_query: q, crop: n, of: "text" }, embedding: await deps.embedder.embedText(q) });
            r.cropRows += 2;
          }
        } catch (e) {
          r.observeFailed.push(`${f.id}: ${(e as Error).message}`);
        }
      }
    }
    await deps.store.upsertMany(rows);
  }
  return r;
}

export interface FigureHit {
  figureId: string;
  doc: string;
  page: number;
  location: string;
  breadcrumb: string;
  imgPath: string;
  anchorText: string;
  caption: string;
  confidence: number;
  rule: string;
  /** RRF 融合分 */
  fused: number;
  /** 各路最高相似度（1 − 余弦距离）；没跑那一路为 null */
  textSim: number | null;
  imageSim: number | null;
  /** 命中的是哪一行（text / image / crop） */
  via: FigureStoreRow["kind"];
}

export interface RecallFiguresArgs {
  /** 文字提问：检索词的文本向量对全部行做近邻 */
  text?: string;
  /** 照片提问：观察层的 crop 图像向量对全部行做近邻（可多张） */
  crops?: Buffer[];
  doc?: string;
  k?: number;
  /** 锚定置信度下限，缺省 0.5 */
  minConfidence?: number;
}

/** 双路召回 → 按 figureId 做 RRF。任一路缺输入就只跑另一路；两路都没有返回空。 */
export async function recallFigures(args: RecallFiguresArgs, deps: { embedder: Embedder; store: FigureStore }): Promise<{ hits: FigureHit[]; paths: string[] }> {
  const k = args.k ?? 8;
  const minConfidence = args.minConfidence ?? 0.5;
  const textList: Array<FigureStoreRow & { distance: number }> = [];
  const imageList: Array<FigureStoreRow & { distance: number }> = [];
  const paths: string[] = [];
  if (args.text?.trim()) {
    const v = await deps.embedder.embedText(args.text.trim());
    textList.push(...(await deps.store.nearest({ vector: v, k, doc: args.doc, minConfidence })));
    paths.push("text");
  }
  for (const crop of args.crops ?? []) {
    const v = await deps.embedder.embedImage(crop);
    imageList.push(...(await deps.store.nearest({ vector: v, k, doc: args.doc, minConfidence })));
    if (!paths.includes("image")) paths.push("image");
  }
  if (paths.length === 0) return { hits: [], paths };
  // 复用图标索引的 RRF：它按 symbolId 融合，这里把 figureId 借道 symbolId 传进去。
  const asIcon = (rows: Array<FigureStoreRow & { distance: number }>) =>
    rows.sort((a, b) => a.distance - b.distance).map((r) => ({ vehicleModel: r.doc, symbolId: r.figureId, side: "manual" as const, kind: r.kind === "text" ? ("text" as const) : ("image" as const), descriptor: r, sourceAsset: r.sourceAsset, manualAnchor: null, distance: r.distance }));
  const fused = fuseByRrf([asIcon(imageList), asIcon(textList)]);
  const hits: FigureHit[] = fused.map((c) => {
    const row = c.row.descriptor as FigureStoreRow & { distance: number };
    return {
      figureId: row.figureId,
      doc: row.doc,
      page: row.page,
      location: row.location,
      breadcrumb: row.breadcrumb,
      imgPath: row.imgPath,
      anchorText: row.anchorText,
      caption: row.caption,
      confidence: row.confidence,
      rule: row.rule,
      fused: c.fused,
      textSim: c.textSim,
      imageSim: c.imageSim,
      via: row.kind,
    };
  });
  return { hits, paths };
}
