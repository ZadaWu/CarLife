-- CreateTable
CREATE TABLE "trip_plan_reviews" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reviewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature" TEXT NOT NULL,
    "days" JSONB NOT NULL,
    "route" JSONB,
    "changes" JSONB NOT NULL,
    "severity" TEXT NOT NULL,
    "acked_at" TIMESTAMP(3),

    CONSTRAINT "trip_plan_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trip_plan_reviews_plan_id_reviewed_at_idx" ON "trip_plan_reviews"("plan_id", "reviewed_at");

-- CreateIndex
CREATE INDEX "trip_plan_reviews_user_id_reviewed_at_idx" ON "trip_plan_reviews"("user_id", "reviewed_at");
