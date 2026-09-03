-- CreateTable
CREATE TABLE "guard_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guard_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "guard_setting_revisions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "prev_value" JSONB,
    "next_value" JSONB NOT NULL,
    "actor" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guard_setting_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guard_setting_revisions_key_at_idx" ON "guard_setting_revisions"("key", "at");
