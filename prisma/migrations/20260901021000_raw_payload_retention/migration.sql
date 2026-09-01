-- Full raw payload retention: pointer-3 run identity + immutable body metadata.
-- payload JSON may be null when the body is CSV/text/file (bodyRef / payloadText).

ALTER TABLE "raw_payloads" ALTER COLUMN "payload" DROP NOT NULL;

ALTER TABLE "raw_payloads" ADD COLUMN IF NOT EXISTS "network" TEXT;
ALTER TABLE "raw_payloads" ADD COLUMN IF NOT EXISTS "networkAccountId" TEXT;
ALTER TABLE "raw_payloads" ADD COLUMN IF NOT EXISTS "sourceObject" TEXT;
ALTER TABLE "raw_payloads" ADD COLUMN IF NOT EXISTS "endpointOrReport" TEXT;
ALTER TABLE "raw_payloads" ADD COLUMN IF NOT EXISTS "apiVersion" TEXT;
ALTER TABLE "raw_payloads" ADD COLUMN IF NOT EXISTS "syncRunId" TEXT;
ALTER TABLE "raw_payloads" ADD COLUMN IF NOT EXISTS "requestWindow" JSONB;
ALTER TABLE "raw_payloads" ADD COLUMN IF NOT EXISTS "httpStatus" INTEGER;
ALTER TABLE "raw_payloads" ADD COLUMN IF NOT EXISTS "bodyKind" TEXT NOT NULL DEFAULT 'JSON';
ALTER TABLE "raw_payloads" ADD COLUMN IF NOT EXISTS "bodyRef" TEXT;
ALTER TABLE "raw_payloads" ADD COLUMN IF NOT EXISTS "payloadText" TEXT;

UPDATE "raw_payloads"
SET "network" = "networkSource"
WHERE "network" IS NULL AND "networkSource" IS NOT NULL AND "networkSource" <> '';

CREATE INDEX IF NOT EXISTS "raw_payloads_syncRunId_idx" ON "raw_payloads"("syncRunId");
CREATE INDEX IF NOT EXISTS "raw_payloads_networkAccountId_sourceObject_idx"
  ON "raw_payloads"("networkAccountId", "sourceObject");
CREATE INDEX IF NOT EXISTS "raw_payloads_network_sourceObject_fetchedAt_idx"
  ON "raw_payloads"("network", "sourceObject", "fetchedAt");

ALTER TABLE "raw_payloads" DROP CONSTRAINT IF EXISTS "raw_payloads_networkAccountId_fkey";
ALTER TABLE "raw_payloads"
  ADD CONSTRAINT "raw_payloads_networkAccountId_fkey"
  FOREIGN KEY ("networkAccountId") REFERENCES "MarketplaceAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "raw_payloads" DROP CONSTRAINT IF EXISTS "raw_payloads_syncRunId_fkey";
ALTER TABLE "raw_payloads"
  ADD CONSTRAINT "raw_payloads_syncRunId_fkey"
  FOREIGN KEY ("syncRunId") REFERENCES "NetworkSyncRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
