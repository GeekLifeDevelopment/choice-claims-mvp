-- Sprint 2 Ticket 7: store mocked VIN provider result on Claim
ALTER TABLE "Claim"
ADD COLUMN "vinDataResult" JSONB,
ADD COLUMN "vinDataProvider" TEXT,
ADD COLUMN "vinDataFetchedAt" TIMESTAMP(3);
