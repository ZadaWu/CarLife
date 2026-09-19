-- AlterTable
ALTER TABLE "research_themes" ADD COLUMN     "need_pain_code" TEXT;

-- CreateIndex
CREATE INDEX "research_themes_codebook_version_need_pain_code_idx" ON "research_themes"("codebook_version", "need_pain_code");
