-- CreateTable
CREATE TABLE "guard_audit_logs" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "session_id" TEXT NOT NULL,
    "turn_id" TEXT,
    "layer" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "rule" TEXT,
    "tool" TEXT,
    "reason" TEXT,
    "duration_ms" INTEGER,
    "detail" JSONB,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "guard_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guard_audit_logs_session_id_at_idx" ON "guard_audit_logs"("session_id", "at");

-- CreateIndex
CREATE INDEX "guard_audit_logs_decision_at_idx" ON "guard_audit_logs"("decision", "at");

-- CreateIndex
CREATE INDEX "guard_audit_logs_layer_at_idx" ON "guard_audit_logs"("layer", "at");
