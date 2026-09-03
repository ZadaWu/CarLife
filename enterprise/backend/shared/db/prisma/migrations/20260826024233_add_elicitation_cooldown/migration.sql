-- CreateTable
CREATE TABLE "elicitation_cooldowns" (
    "vin" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "declined_at" TIMESTAMP(3) NOT NULL,
    "decline_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "elicitation_cooldowns_pkey" PRIMARY KEY ("vin","kind")
);

-- CreateIndex
CREATE INDEX "elicitation_cooldowns_owner_id_idx" ON "elicitation_cooldowns"("owner_id");
