-- CreateTable
CREATE TABLE "research_contracts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "population_target" TEXT NOT NULL,
    "population_observed" JSONB NOT NULL,
    "object" TEXT NOT NULL,
    "horizon" TEXT NOT NULL,
    "evidence_bar" TEXT NOT NULL,
    "exclusions" JSONB NOT NULL,
    "freshness" TEXT NOT NULL,
    "action_rule" TEXT NOT NULL,
    "window_from" BIGINT NOT NULL,
    "window_to" BIGINT NOT NULL,
    "codebook_version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_sources" (
    "id" TEXT NOT NULL,
    "control" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "access" TEXT NOT NULL,
    "collect" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "analyze" TEXT NOT NULL,
    "share" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "retention_days" INTEGER,
    "provenance" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_evidence_units" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT,
    "kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "vin" TEXT,
    "session_id" TEXT,
    "turn_id" TEXT,
    "message_id" TEXT,
    "trip_id" TEXT,
    "occurred_at" BIGINT NOT NULL,
    "text_redacted" TEXT,
    "features" JSONB,
    "context" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "display_level" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "withdrawn_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_evidence_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_links" (
    "id" TEXT NOT NULL,
    "utterance_unit_id" TEXT NOT NULL,
    "behavior_unit_id" TEXT NOT NULL,
    "linkability" TEXT NOT NULL DEFAULT 'deterministic',
    "basis" TEXT NOT NULL,
    "window_days" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_codebooks" (
    "version" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "locked_at" TIMESTAMP(3),
    "axes" JSONB NOT NULL,
    "file_path" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_codebooks_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "research_codings" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT NOT NULL,
    "codebook_version" TEXT NOT NULL,
    "axis" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT NOT NULL,
    "competing_code" TEXT,
    "uncertain" BOOLEAN NOT NULL DEFAULT false,
    "coder" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_codings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_themes" (
    "id" TEXT NOT NULL,
    "codebook_version" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" TEXT NOT NULL,
    "include" TEXT NOT NULL,
    "exclude" TEXT NOT NULL,
    "member_unit_ids" TEXT[],
    "counter_unit_ids" TEXT[],
    "centroid_embedding_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_themes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_segments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "member_vins" TEXT[],
    "size" INTEGER NOT NULL,
    "external_validation" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "min_cell" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_embeddings" (
    "id" TEXT NOT NULL,
    "unit_id" TEXT,
    "theme_id" TEXT,
    "model" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_lens_snapshots" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "lens" TEXT NOT NULL,
    "window_from" BIGINT NOT NULL,
    "window_to" BIGINT NOT NULL,
    "codebook_version" TEXT NOT NULL,
    "inputs_hash" TEXT NOT NULL,
    "population" JSONB NOT NULL,
    "gates" JSONB NOT NULL,
    "data" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_lens_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_insights" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "theme_id" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'signal',
    "card" JSONB NOT NULL,
    "confidence" JSONB NOT NULL,
    "upgrade_needs" TEXT[],
    "owner" TEXT NOT NULL,
    "review_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_opportunities" (
    "id" TEXT NOT NULL,
    "insight_id" TEXT NOT NULL,
    "hypothesis" JSONB NOT NULL,
    "ods" JSONB NOT NULL,
    "profile_version" TEXT NOT NULL,
    "outlet" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_challenges" (
    "id" TEXT NOT NULL,
    "insight_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "contradicted_unit_ids" TEXT[],
    "verdict" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_decisions" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "decided_by" TEXT NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rationale" TEXT NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "research_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_system_events" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" BIGINT NOT NULL,
    "key" TEXT,
    "summary" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_system_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "research_contracts_status_created_at_idx" ON "research_contracts"("status", "created_at");

-- CreateIndex
CREATE INDEX "research_sources_provenance_idx" ON "research_sources"("provenance");

-- CreateIndex
CREATE INDEX "research_evidence_units_kind_occurred_at_idx" ON "research_evidence_units"("kind", "occurred_at");

-- CreateIndex
CREATE INDEX "research_evidence_units_user_id_occurred_at_idx" ON "research_evidence_units"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "research_evidence_units_vin_occurred_at_idx" ON "research_evidence_units"("vin", "occurred_at");

-- CreateIndex
CREATE INDEX "research_evidence_units_contract_id_occurred_at_idx" ON "research_evidence_units"("contract_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "research_evidence_units_fingerprint_key" ON "research_evidence_units"("fingerprint");

-- CreateIndex
CREATE INDEX "research_links_behavior_unit_id_idx" ON "research_links"("behavior_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_links_utterance_unit_id_behavior_unit_id_key" ON "research_links"("utterance_unit_id", "behavior_unit_id");

-- CreateIndex
CREATE INDEX "research_codebooks_locked_at_idx" ON "research_codebooks"("locked_at");

-- CreateIndex
CREATE INDEX "research_codings_unit_id_codebook_version_idx" ON "research_codings"("unit_id", "codebook_version");

-- CreateIndex
CREATE INDEX "research_codings_axis_code_idx" ON "research_codings"("axis", "code");

-- CreateIndex
CREATE INDEX "research_codings_coder_created_at_idx" ON "research_codings"("coder", "created_at");

-- CreateIndex
CREATE INDEX "research_themes_codebook_version_status_idx" ON "research_themes"("codebook_version", "status");

-- CreateIndex
CREATE INDEX "research_segments_status_idx" ON "research_segments"("status");

-- CreateIndex
CREATE INDEX "research_embeddings_model_idx" ON "research_embeddings"("model");

-- CreateIndex
CREATE UNIQUE INDEX "research_embeddings_unit_id_model_key" ON "research_embeddings"("unit_id", "model");

-- CreateIndex
CREATE UNIQUE INDEX "research_embeddings_theme_id_model_key" ON "research_embeddings"("theme_id", "model");

-- CreateIndex
CREATE INDEX "research_lens_snapshots_lens_computed_at_idx" ON "research_lens_snapshots"("lens", "computed_at");

-- CreateIndex
CREATE UNIQUE INDEX "research_lens_snapshots_contract_id_lens_window_from_window_key" ON "research_lens_snapshots"("contract_id", "lens", "window_from", "window_to", "codebook_version", "inputs_hash");

-- CreateIndex
CREATE INDEX "research_insights_contract_id_level_idx" ON "research_insights"("contract_id", "level");

-- CreateIndex
CREATE INDEX "research_insights_theme_id_idx" ON "research_insights"("theme_id");

-- CreateIndex
CREATE INDEX "research_opportunities_outlet_status_idx" ON "research_opportunities"("outlet", "status");

-- CreateIndex
CREATE INDEX "research_opportunities_insight_id_idx" ON "research_opportunities"("insight_id");

-- CreateIndex
CREATE INDEX "research_challenges_insight_id_kind_idx" ON "research_challenges"("insight_id", "kind");

-- CreateIndex
CREATE INDEX "research_decisions_kind_decided_at_idx" ON "research_decisions"("kind", "decided_at");

-- CreateIndex
CREATE INDEX "research_decisions_subject_id_idx" ON "research_decisions"("subject_id");

-- CreateIndex
CREATE INDEX "research_system_events_at_idx" ON "research_system_events"("at");

-- CreateIndex
CREATE INDEX "research_system_events_kind_at_idx" ON "research_system_events"("kind", "at");

-- CreateIndex
CREATE UNIQUE INDEX "research_system_events_source_ref_key" ON "research_system_events"("source_ref");

-- AddForeignKey
ALTER TABLE "research_links" ADD CONSTRAINT "research_links_utterance_unit_id_fkey" FOREIGN KEY ("utterance_unit_id") REFERENCES "research_evidence_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_links" ADD CONSTRAINT "research_links_behavior_unit_id_fkey" FOREIGN KEY ("behavior_unit_id") REFERENCES "research_evidence_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_codings" ADD CONSTRAINT "research_codings_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "research_evidence_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_embeddings" ADD CONSTRAINT "research_embeddings_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "research_evidence_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_embeddings" ADD CONSTRAINT "research_embeddings_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "research_themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_lens_snapshots" ADD CONSTRAINT "research_lens_snapshots_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "research_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_insights" ADD CONSTRAINT "research_insights_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "research_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_insights" ADD CONSTRAINT "research_insights_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "research_themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_opportunities" ADD CONSTRAINT "research_opportunities_insight_id_fkey" FOREIGN KEY ("insight_id") REFERENCES "research_insights"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_challenges" ADD CONSTRAINT "research_challenges_insight_id_fkey" FOREIGN KEY ("insight_id") REFERENCES "research_insights"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 手工补：向量近邻索引（施工单 M82-01）─────────────────────────
--
-- Prisma 的 `@@index(type: …)` 没有 Hnsw 这一档，`Unsupported("vector(1024)")`
-- 列也不进它的索引模型，所以这一句只能手写在迁移里。
--
-- ⚠️ 维度必须 ≤ 2000：pgvector 的 ANN 索引上限就是这个数，`icon_embeddings`
-- 的 2560 维正是因此建不了索引、只能顺序扫（ACR-030）。研究嵌入取
-- `text-embedding-v4` 的 1024 维（该模型支持 64–2048 可选维度）就是为了留在上限内。
--
-- 余弦距离（`<=>`，`vector_cosine_ops`）与 `manual-figure.ts` / `icon-embedding.ts`
-- 的检索算子一致——换成 L2 会让"相似度 = 1 − distance"这条换算在研究面失效。
CREATE INDEX "research_embeddings_hnsw" ON "research_embeddings" USING hnsw ("embedding" vector_cosine_ops);
