-- Sprint 3 Ticket 7: add explicit manual retry requested timestamp tracking
ALTER TABLE "Claim"
ADD COLUMN IF NOT EXISTS "vinLookupRetryRequestedAt" TIMESTAMP(3);
