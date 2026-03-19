-- Sprint 3 Ticket 6: separate raw provider payload from normalized result and persist provider metadata
ALTER TABLE "Claim"
ADD COLUMN "vinDataRawPayload" JSONB,
ADD COLUMN "vinDataProviderResultCode" INTEGER,
ADD COLUMN "vinDataProviderResultMessage" TEXT;
