CREATE TABLE IF NOT EXISTS "ClaimDocument" (
  "id" TEXT NOT NULL,
  "claimId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "uploadedBy" TEXT,
  "processingStatus" TEXT NOT NULL DEFAULT 'uploaded',
  "documentType" TEXT,
  "matchStatus" TEXT,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ClaimDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ClaimDocument_claimId_idx" ON "ClaimDocument"("claimId");
CREATE INDEX IF NOT EXISTS "ClaimDocument_processingStatus_idx" ON "ClaimDocument"("processingStatus");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ClaimDocument_claimId_fkey'
  ) THEN
    ALTER TABLE "ClaimDocument"
    ADD CONSTRAINT "ClaimDocument_claimId_fkey"
    FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
