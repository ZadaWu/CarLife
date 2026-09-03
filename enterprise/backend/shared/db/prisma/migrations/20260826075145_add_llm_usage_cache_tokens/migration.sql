-- AlterTable
ALTER TABLE "llm_usage" ADD COLUMN     "cache_hit_tokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cache_miss_tokens" INTEGER NOT NULL DEFAULT 0;
