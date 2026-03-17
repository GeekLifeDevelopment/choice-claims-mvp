-- AlterTable
ALTER TABLE "Claim" ADD COLUMN "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Claim_dedupeKey_key" ON "Claim"("dedupeKey");
