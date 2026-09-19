/**
 * 图标图文向量索引仓储（施工单 M71-03，ACR-025）。
 *
 * `embedding` 是 Prisma 的 `Unsupported("vector(2560)")`，生成的 Client 不认识它，
 * 所以读写全走 `$queryRawUnsafe` / `$executeRawUnsafe`，向量以 `'[…]'::vector` 字面量传参。
 *
 * # 形状对齐 @carlife/rag 的 IconStore
 *
 * rag 不依赖 db（避免 tools → rag → db → … 的环），它只声明一个结构相同的 `IconStore` 接口；
 * 本仓储按那个形状实现，调用方（`kb:icons` 脚本、评测 runner）把它当 store 传进去。
 * 改任何一边的方法签名，另一边也要改——TypeScript 的结构类型会在调用处报错，不会静默。
 */

import { PrismaClient } from "@prisma/client";

export interface IconEmbeddingRow {
  id: string;
  vehicleModel: string;
  symbolId: string;
  side: "manual" | "user";
  kind: "image" | "text";
  descriptor: unknown;
  sourceAsset: string;
  manualAnchor: string | null;
}

export interface IconEmbeddingInput extends Omit<IconEmbeddingRow, "id"> {
  embedding: number[];
}

export interface IconNearestQuery {
  vector: number[];
  k: number;
  vehicleModel?: string;
  side?: "manual" | "user";
  kind?: "image" | "text";
}

export interface IconNearestRow extends IconEmbeddingRow {
  /** 余弦距离（`<=>`），相似度 = 1 − distance。 */
  distance: number;
}

export interface IconEmbeddingRepository {
  upsertMany(rows: readonly IconEmbeddingInput[]): Promise<number>;
  nearest(q: IconNearestQuery): Promise<IconNearestRow[]>;
  countByVehicle(vehicleModel: string): Promise<number>;
  deleteByVehicle(vehicleModel: string): Promise<number>;
  /** 按 symbol_id 取手册侧那一行（语义在 descriptor 里）；车型不给就取任一车型的。M80-15 给检测器的类别名找语义用。 */
  getBySymbol(q: { symbolId: string; vehicleModel?: string }): Promise<IconEmbeddingRow | null>;
}

const toLiteral = (v: readonly number[]): string => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

type RawRow = {
  id: string;
  vehicle_model: string;
  symbol_id: string;
  side: string;
  kind: string;
  descriptor: unknown;
  source_asset: string;
  manual_anchor: string | null;
  distance?: number;
};

const fromRaw = (r: RawRow): IconEmbeddingRow => ({
  id: r.id,
  vehicleModel: r.vehicle_model,
  symbolId: r.symbol_id,
  side: r.side as IconEmbeddingRow["side"],
  kind: r.kind as IconEmbeddingRow["kind"],
  descriptor: r.descriptor,
  sourceAsset: r.source_asset,
  manualAnchor: r.manual_anchor,
});

export function createIconEmbeddingRepository(prisma: PrismaClient): IconEmbeddingRepository {
  return {
    async upsertMany(rows) {
      let n = 0;
      for (const r of rows) {
        // 一行一条 INSERT：几十到几百条图标，可读性优先于批量；ON CONFLICT 让重建索引幂等。
        n += await prisma.$executeRawUnsafe(
          `INSERT INTO "icon_embeddings" ("id","vehicle_model","symbol_id","side","kind","descriptor","embedding","source_asset","manual_anchor","created_at")
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::vector,$8,$9,NOW())
           ON CONFLICT ("vehicle_model","symbol_id","side","kind","source_asset")
           DO UPDATE SET "embedding" = EXCLUDED."embedding", "descriptor" = EXCLUDED."descriptor", "manual_anchor" = EXCLUDED."manual_anchor"`,
          `icon_${r.vehicleModel}_${r.symbolId}_${r.side}_${r.kind}_${r.sourceAsset || "text"}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120),
          r.vehicleModel,
          r.symbolId,
          r.side,
          r.kind,
          JSON.stringify(r.descriptor ?? null),
          toLiteral(r.embedding),
          r.sourceAsset ?? "",
          r.manualAnchor ?? null,
        );
      }
      return n;
    },

    async nearest(q) {
      const side = q.side ?? "manual";
      const rows = await prisma.$queryRawUnsafe<RawRow[]>(
        `SELECT "id","vehicle_model","symbol_id","side","kind","descriptor","source_asset","manual_anchor",
                ("embedding" <=> $1::vector)::float8 AS "distance"
           FROM "icon_embeddings"
          WHERE "side" = $2
            AND ($3::text IS NULL OR "vehicle_model" = $3)
            AND ($4::text IS NULL OR "kind" = $4)
          ORDER BY "embedding" <=> $1::vector
          LIMIT $5`,
        toLiteral(q.vector),
        side,
        q.vehicleModel ?? null,
        q.kind ?? null,
        Math.max(1, Math.min(200, q.k)),
      );
      return rows.map((r) => ({ ...fromRaw(r), distance: Number(r.distance) }));
    },

    async getBySymbol(q) {
      const rows = await prisma.$queryRawUnsafe<RawRow[]>(
        `SELECT "id","vehicle_model","symbol_id","side","kind","descriptor","source_asset","manual_anchor"
           FROM "icon_embeddings"
          WHERE "symbol_id" = $1 AND "side" = 'manual'
            AND ($2::text IS NULL OR "vehicle_model" = $2)
          ORDER BY "kind" = 'image' DESC
          LIMIT 1`,
        q.symbolId,
        q.vehicleModel ?? null,
      );
      return rows[0] ? fromRaw(rows[0]) : null;
    },

    async countByVehicle(vehicleModel) {
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "icon_embeddings" WHERE "vehicle_model" = $1`, vehicleModel);
      return Number(rows[0]?.n ?? 0);
    },

    async deleteByVehicle(vehicleModel) {
      return prisma.$executeRawUnsafe(`DELETE FROM "icon_embeddings" WHERE "vehicle_model" = $1`, vehicleModel);
    },
  };
}
