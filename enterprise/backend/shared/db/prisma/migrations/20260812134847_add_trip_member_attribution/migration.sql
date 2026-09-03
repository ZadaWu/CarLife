-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "driver_member_id" TEXT,
ADD COLUMN     "passenger_member_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "trips_driver_member_id_ended_at_idx" ON "trips"("driver_member_id", "ended_at");
