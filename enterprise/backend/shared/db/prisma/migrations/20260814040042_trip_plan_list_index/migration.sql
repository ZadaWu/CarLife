-- CreateIndex
CREATE INDEX "trip_plans_user_id_status_start_date_idx" ON "trip_plans"("user_id", "status", "start_date");
