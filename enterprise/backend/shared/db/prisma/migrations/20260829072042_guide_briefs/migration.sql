-- CreateTable
CREATE TABLE "guide_briefs" (
    "city" TEXT NOT NULL,
    "spot_name" TEXT NOT NULL,
    "brief" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guide_briefs_pkey" PRIMARY KEY ("city","spot_name")
);
