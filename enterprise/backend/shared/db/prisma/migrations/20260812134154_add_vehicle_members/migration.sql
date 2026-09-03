-- CreateTable
CREATE TABLE "vehicle_members" (
    "id" TEXT NOT NULL,
    "vin" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "relation" TEXT,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "age_band" TEXT,
    "needs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_members_vin_idx" ON "vehicle_members"("vin");

-- CreateIndex
CREATE INDEX "vehicle_members_owner_id_idx" ON "vehicle_members"("owner_id");

-- AddForeignKey
ALTER TABLE "vehicle_members" ADD CONSTRAINT "vehicle_members_vin_fkey" FOREIGN KEY ("vin") REFERENCES "vehicles"("vin") ON DELETE CASCADE ON UPDATE CASCADE;
