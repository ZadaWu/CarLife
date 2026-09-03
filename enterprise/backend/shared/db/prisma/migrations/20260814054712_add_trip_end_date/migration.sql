-- AlterTable
ALTER TABLE "trip_plans" ADD COLUMN     "end_date" TEXT;

-- CreateIndex
CREATE INDEX "trip_plans_user_id_status_end_date_idx" ON "trip_plans"("user_id", "status", "end_date");
