/**
 * 手册图文索引仓储（ACR-029 第 3 步）。照 `icon-embedding.ts`：`embedding` 是 `Unsupported("vector(2560)")`，
 * 生成的 Client 不认识它，读写全走 `$queryRawUnsafe` / `$executeRawUnsafe`，向量以 `'[…]'::vector` 字面量传参。
 *
 * 形状对齐 @carlife/rag 的 `FigureStore`——rag 不依赖 db，只声明接口；改任一边的签名另一边在调用处报错。
 */

import { PrismaClient } from "@prisma/client";

export interface ManualFigureRow {
  id: string;
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

export interface ManualFigureInput extends Omit<ManualFigureRow, "id"> {
  embedding: number[];
}

export interface ManualFigureNearestQuery {
  vector: number[];
  k: number;
  doc?: string;
  kind?: "image" | "text" | "crop";
  /** 只要锚定置信度不低于此的行——锚错段比没图更糟。 */
  minConfidence?: number;
}

export interface ManualFigureNearestRow extends ManualFigureRow {
  /** 余弦距离（`<=>`），相似度 = 1 − distance。 */
  distance: number;
}

export interface ManualFigureRepository {
  upsertMany(rows: readonly ManualFigureInput[]): Promise<number>;
  nearest(q: ManualFigureNearestQuery): Promise<ManualFigureNearestRow[]>;
  countByDoc(doc: string): Promise<number>;
  deleteByDoc(doc: string): Promise<number>;
  /** 库里有哪些文档、各多少行——启动日志与 kb:figures 打印用。 */
  docs(): Promise<Array<{ doc: string; rows: number }>>;
}

const toLiteral = (v: readonly number[]): string => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

type RawRow = {
  id: string;
  doc: string;
  figure_id: string;
  page: number;
  location: string;
  breadcrumb: string;
  kind: string;
  img_path: string;
  anchor_text: string;
  caption: string;
  confidence: number;
  rule: string;
  source_asset: string;
  descriptor: unknown;
  distance?: number;
};

const fromRaw = (r: RawRow): ManualFigureRow => ({
  id: r.id,
  doc: r.doc,
  figureId: r.figure_id,
  page: Number(r.page),
  location: r.location,
  breadcrumb: r.breadcrumb,
  kind: r.kind as ManualFigureRow["kind"],
  imgPath: r.img_path,
  anchorText: r.anchor_text,
  caption: r.caption,
  confidence: Number(r.confidence),
  rule: r.rule,
  sourceAsset: r.source_asset,
  descriptor: r.descriptor,
});

const COLS = `"id","doc","figure_id","page","location","breadcrumb","kind","img_path","anchor_text","caption","confidence","rule","source_asset","descriptor"`;

export function createManualFigureRepository(prisma: PrismaClient): ManualFigureRepository {
  return {
    async upsertMany(rows) {
      let n = 0;
      for (const r of rows) {
        // 一行一条 INSERT：一本手册几百到上千行，可读性优先；ON CONFLICT 让重建幂等。
        n += await prisma.$executeRawUnsafe(
          `INSERT INTO "manual_figures" (${COLS},"embedding","created_at")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::vector,NOW())
           ON CONFLICT ("doc","figure_id","kind","source_asset")
           DO UPDATE SET "embedding" = EXCLUDED."embedding", "descriptor" = EXCLUDED."descriptor", "anchor_text" = EXCLUDED."anchor_text",
                         "caption" = EXCLUDED."caption", "confidence" = EXCLUDED."confidence", "rule" = EXCLUDED."rule",
                         "breadcrumb" = EXCLUDED."breadcrumb", "location" = EXCLUDED."location", "page" = EXCLUDED."page", "img_path" = EXCLUDED."img_path"`,
          `fig_${r.doc}_${r.figureId}_${r.kind}_${r.sourceAsset || "text"}`.replace(/[^A-Za-z0-9_.#-]/g, "_").slice(0, 160),
          r.doc,
          r.figureId,
          Math.trunc(r.page),
          r.location,
          r.breadcrumb,
          r.kind,
          r.imgPath,
          r.anchorText,
          r.caption ?? "",
          r.confidence,
          r.rule,
          r.sourceAsset ?? "",
          JSON.stringify(r.descriptor ?? null),
          toLiteral(r.embedding),
        );
      }
      return n;
    },

    async nearest(q) {
      const rows = await prisma.$queryRawUnsafe<RawRow[]>(
        `SELECT ${COLS}, ("embedding" <=> $1::vector)::float8 AS "distance"
           FROM "manual_figures"
          WHERE ($2::text IS NULL OR "doc" = $2)
            AND ($3::text IS NULL OR "kind" = $3)
            AND "confidence" >= $4
          ORDER BY "embedding" <=> $1::vector
          LIMIT $5`,
        toLiteral(q.vector),
        q.doc ?? null,
        q.kind ?? null,
        q.minConfidence ?? 0,
        Math.max(1, Math.min(200, q.k)),
      );
      return rows.map((r) => ({ ...fromRaw(r), distance: Number(r.distance) }));
    },

    async countByDoc(doc) {
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "manual_figures" WHERE "doc" = $1`, doc);
      return Number(rows[0]?.n ?? 0);
    },

    async deleteByDoc(doc) {
      return prisma.$executeRawUnsafe(`DELETE FROM "manual_figures" WHERE "doc" = $1`, doc);
    },

    async docs() {
      const rows = await prisma.$queryRawUnsafe<Array<{ doc: string; n: bigint }>>(`SELECT "doc", COUNT(*)::bigint AS n FROM "manual_figures" GROUP BY "doc" ORDER BY "doc"`);
      return rows.map((r) => ({ doc: r.doc, rows: Number(r.n) }));
    },
  };
}
