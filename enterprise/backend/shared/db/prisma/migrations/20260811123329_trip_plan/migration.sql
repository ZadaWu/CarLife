-- CreateTable
CREATE TABLE "trip_plans" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "start_date" TEXT,
    "days" INTEGER NOT NULL,
    "plan" JSONB NOT NULL,
    "committed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trip_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trip_plans_user_id_committed_at_idx" ON "trip_plans"("user_id", "committed_at");
