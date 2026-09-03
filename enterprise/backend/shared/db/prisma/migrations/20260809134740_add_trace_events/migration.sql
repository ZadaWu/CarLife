CREATE TABLE IF NOT EXISTS "trace_events" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "turn_id" TEXT,
    "kind" TEXT NOT NULL,
    "at" BIGINT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trace_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "trace_events_session_id_at_idx" ON "trace_events"("session_id", "at");
CREATE INDEX IF NOT EXISTS "trace_events_created_at_idx" ON "trace_events"("created_at");
