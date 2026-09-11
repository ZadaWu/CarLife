-- CreateTable
CREATE TABLE "manual_figures" (
    "id" TEXT NOT NULL,
    "doc" TEXT NOT NULL,
    "figure_id" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "location" TEXT NOT NULL,
    "breadcrumb" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "img_path" TEXT NOT NULL,
    "anchor_text" TEXT NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "confidence" DOUBLE PRECISION NOT NULL,
    "rule" TEXT NOT NULL,
    "source_asset" TEXT NOT NULL DEFAULT '',
    "descriptor" JSONB NOT NULL,
    "embedding" vector(2560) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_figures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "manual_figures_doc_kind_idx" ON "manual_figures"("doc", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "manual_figures_doc_figure_id_kind_source_asset_key" ON "manual_figures"("doc", "figure_id", "kind", "source_asset");
