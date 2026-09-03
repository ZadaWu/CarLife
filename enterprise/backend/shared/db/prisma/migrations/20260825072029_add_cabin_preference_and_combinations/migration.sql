-- AlterTable
ALTER TABLE "vehicle_members" ADD COLUMN     "cabin_preference" JSONB;

-- CreateTable
CREATE TABLE "member_combinations" (
    "id" TEXT NOT NULL,
    "vin" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "member_ids" TEXT[],
    "member_key" TEXT NOT NULL,
    "override" JSONB NOT NULL,
    "invalidated_at" TIMESTAMP(3),
    "invalid_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_combinations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "member_combinations_owner_id_idx" ON "member_combinations"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_combinations_vin_member_key_key" ON "member_combinations"("vin", "member_key");

-- AddForeignKey
ALTER TABLE "member_combinations" ADD CONSTRAINT "member_combinations_vin_fkey" FOREIGN KEY ("vin") REFERENCES "vehicles"("vin") ON DELETE CASCADE ON UPDATE CASCADE;
