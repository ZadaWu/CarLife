-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "turn_id" TEXT,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "filename" TEXT,
    "object_key" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attachments_idempotency_key_key" ON "attachments"("idempotency_key");

-- CreateIndex
CREATE INDEX "attachments_session_id_created_at_idx" ON "attachments"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "attachments_turn_id_idx" ON "attachments"("turn_id");
