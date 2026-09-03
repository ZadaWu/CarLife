CREATE TABLE IF NOT EXISTS "vehicles" (
    "vin" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "model_year" INTEGER NOT NULL,
    "purchased_at" TIMESTAMP(3) NOT NULL,
    "odometer_km" DOUBLE PRECISION NOT NULL,
    "maintenance_interval_km" INTEGER,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("vin")
);
CREATE INDEX IF NOT EXISTS "vehicles_owner_id_idx" ON "vehicles"("owner_id");

CREATE TABLE IF NOT EXISTS "maintenance_records" (
    "id" TEXT NOT NULL,
    "vin" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "odometer_km" DOUBLE PRECISION NOT NULL,
    "items" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "maintenance_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "maintenance_records_vin_at_idx" ON "maintenance_records"("vin", "at");

CREATE TABLE IF NOT EXISTS "repair_records" (
    "id" TEXT NOT NULL,
    "vin" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "odometer_km" DOUBLE PRECISION NOT NULL,
    "symptom" TEXT NOT NULL,
    "resolution" TEXT,
    "source" TEXT NOT NULL,
    "session_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repair_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "repair_records_vin_at_idx" ON "repair_records"("vin", "at");

DO $$ BEGIN
  ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_vin_fkey"
    FOREIGN KEY ("vin") REFERENCES "vehicles"("vin") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "repair_records" ADD CONSTRAINT "repair_records_vin_fkey"
    FOREIGN KEY ("vin") REFERENCES "vehicles"("vin") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
