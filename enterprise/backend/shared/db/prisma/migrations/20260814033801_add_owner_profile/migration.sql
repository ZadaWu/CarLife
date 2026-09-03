-- CreateTable
CREATE TABLE "owner_profiles" (
    "user_id" TEXT NOT NULL,
    "home_city" TEXT NOT NULL,
    "home_lat" DOUBLE PRECISION NOT NULL,
    "home_lon" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owner_profiles_pkey" PRIMARY KEY ("user_id")
);
