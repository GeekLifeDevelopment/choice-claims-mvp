-- Add minimal VIN lookup retry/failure tracking fields to Claim.
ALTER TABLE "Claim"
ADD COLUMN "vinLookupAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "vinLookupLastError" TEXT,
ADD COLUMN "vinLookupLastFailedAt" TIMESTAMP(3),
ADD COLUMN "vinLookupLastJobId" TEXT,
ADD COLUMN "vinLookupLastJobName" TEXT,
ADD COLUMN "vinLookupLastQueueName" TEXT;
