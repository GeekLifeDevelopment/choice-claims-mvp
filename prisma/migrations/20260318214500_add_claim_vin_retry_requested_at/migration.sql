-- Track most recent manual VIN retry request timestamp on claims.
ALTER TABLE "Claim"
ADD COLUMN "vinLookupRetryRequestedAt" TIMESTAMP(3);
