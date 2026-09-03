-- CreateTable
CREATE TABLE "vehicle_reminders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "vin" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "due_at" TIMESTAMP(3),
    "remaining_km" INTEGER,
    "message" TEXT NOT NULL,
    "basis" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_settings" (
    "user_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "dedupe_days" INTEGER NOT NULL DEFAULT 7,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminder_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE INDEX "vehicle_reminders_user_id_vin_kind_created_at_idx" ON "vehicle_reminders"("user_id", "vin", "kind", "created_at");
