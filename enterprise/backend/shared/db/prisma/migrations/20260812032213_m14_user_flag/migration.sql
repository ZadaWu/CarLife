-- CreateTable
CREATE TABLE "user_flags" (
    "user_id" TEXT NOT NULL,
    "flag" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_flags_pkey" PRIMARY KEY ("user_id","flag")
);
