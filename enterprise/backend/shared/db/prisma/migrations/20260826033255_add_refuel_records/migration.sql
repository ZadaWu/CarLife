-- CreateTable
CREATE TABLE "refuel_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "vin" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "liters" DOUBLE PRECISION NOT NULL,
    "odometer_km" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refuel_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refuel_records_user_id_at_idx" ON "refuel_records"("user_id", "at");

-- CreateIndex
CREATE INDEX "refuel_records_vin_odometer_km_idx" ON "refuel_records"("vin", "odometer_km");
