-- AlterTable
ALTER TABLE "research_insights" ADD COLUMN     "inputs_hash" TEXT;

-- CreateIndex
CREATE INDEX "research_insights_contract_id_inputs_hash_idx" ON "research_insights"("contract_id", "inputs_hash");
