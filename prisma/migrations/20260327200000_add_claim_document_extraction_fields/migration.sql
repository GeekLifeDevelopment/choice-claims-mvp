-- Add extraction metadata fields to uploaded claim documents.
ALTER TABLE "ClaimDocument"
ADD COLUMN "extractionStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN "extractedAt" TIMESTAMP(3),
ADD COLUMN "extractedData" JSONB,
ADD COLUMN "extractionWarnings" JSONB;

CREATE INDEX "ClaimDocument_extractionStatus_idx" ON "ClaimDocument"("extractionStatus");
