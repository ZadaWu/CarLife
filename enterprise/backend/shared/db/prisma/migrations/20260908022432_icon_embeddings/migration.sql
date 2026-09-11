-- pgvector 扩展必须先于本表存在（M72-01 修正）：
-- 原先只在 20260908090000_pgvector_extension 里建，时间戳排在本文件之后，
-- 开发库因 Mem0 早就建过扩展而侥幸通过，影子库 / CI / 新机器上 `migrate deploy` 与 `db:migrate:safe` 在这里死于 type "vector" does not exist。
-- 后面那份迁移 IF NOT EXISTS 保留不动（已应用的迁移不改名）。
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "icon_embeddings" (
    "id" TEXT NOT NULL,
    "vehicle_model" TEXT NOT NULL,
    "symbol_id" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "descriptor" JSONB NOT NULL,
    "embedding" vector(2560) NOT NULL,
    "source_asset" TEXT NOT NULL DEFAULT '',
    "manual_anchor" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "icon_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "icon_embeddings_vehicle_model_side_kind_idx" ON "icon_embeddings"("vehicle_model", "side", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "icon_embeddings_vehicle_model_symbol_id_side_kind_source_as_key" ON "icon_embeddings"("vehicle_model", "symbol_id", "side", "kind", "source_asset");
