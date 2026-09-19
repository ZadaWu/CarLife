-- CreateTable
CREATE TABLE "working_tasks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "base_ref" TEXT,
    "base_version" INTEGER,
    "pending" JSONB,
    "last_action" JSONB,
    "constraints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL,
    "touched_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "session_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "working_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "working_tasks_user_id_kind_closed_at_idx" ON "working_tasks"("user_id", "kind", "closed_at");

-- CreateIndex
CREATE INDEX "working_tasks_expires_at_idx" ON "working_tasks"("expires_at");
