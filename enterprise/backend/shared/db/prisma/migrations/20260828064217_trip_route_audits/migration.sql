-- CreateTable
CREATE TABLE "trip_route_audits" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "turn_id" TEXT,
    "agent" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_route_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trip_route_audits_session_id_created_at_idx" ON "trip_route_audits"("session_id", "created_at");
