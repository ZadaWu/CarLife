CREATE TABLE IF NOT EXISTS "trips" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "vin" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "distance_km" DOUBLE PRECISION NOT NULL,
    "road_type" TEXT,
    "ambient_temp_c" DOUBLE PRECISION,
    "observed_range_km" DOUBLE PRECISION,
    "charge_start_soc" DOUBLE PRECISION,
    "charge_end_soc" DOUBLE PRECISION,
    "charge_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "trips_user_id_ended_at_idx" ON "trips"("user_id", "ended_at");
CREATE INDEX IF NOT EXISTS "trips_vin_ended_at_idx" ON "trips"("vin", "ended_at");
