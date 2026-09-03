-- CreateTable
CREATE TABLE "config_item_revisions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by" TEXT NOT NULL,
    "is_secret" BOOLEAN NOT NULL,
    "prev_value" TEXT,
    "prev_verified_at" TIMESTAMP(3),

    CONSTRAINT "config_item_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_usage" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "session_id" TEXT NOT NULL,
    "turn_id" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL,
    "completion_tokens" INTEGER NOT NULL,
    "cost_estimate" DOUBLE PRECISION NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "llm_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "config_item_revisions_key_changed_at_idx" ON "config_item_revisions"("key", "changed_at");

-- CreateIndex
CREATE INDEX "llm_usage_at_idx" ON "llm_usage"("at");

-- CreateIndex
CREATE INDEX "llm_usage_session_id_idx" ON "llm_usage"("session_id");

-- CreateIndex
CREATE INDEX "llm_usage_model_at_idx" ON "llm_usage"("model", "at");
