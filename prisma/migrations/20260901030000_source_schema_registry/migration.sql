-- Pointer 5: Source Schema Registry — observed paths with samples, occurrence, fingerprint.

ALTER TABLE "FieldRegistry" ADD COLUMN IF NOT EXISTS "sourceObject" TEXT NOT NULL DEFAULT '';
ALTER TABLE "FieldRegistry" ADD COLUMN IF NOT EXISTS "nullable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FieldRegistry" ADD COLUMN IF NOT EXISTS "isArray" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FieldRegistry" ADD COLUMN IF NOT EXISTS "isObject" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FieldRegistry" ADD COLUMN IF NOT EXISTS "sampleValue" TEXT;
ALTER TABLE "FieldRegistry" ADD COLUMN IF NOT EXISTS "occurrenceCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FieldRegistry" ADD COLUMN IF NOT EXISTS "schemaFingerprint" TEXT;
ALTER TABLE "FieldRegistry" ADD COLUMN IF NOT EXISTS "apiVersion" TEXT;
ALTER TABLE "FieldRegistry" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "FieldRegistry"
SET "sourceObject" = CASE "entityType"
  WHEN 'campaign' THEN 'campaigns'
  WHEN 'coupon' THEN 'coupons'
  WHEN 'conversion' THEN 'conversions'
  WHEN 'payment' THEN 'payments'
  WHEN 'invoice' THEN 'invoices'
  WHEN 'product' THEN 'products'
  WHEN 'click' THEN 'clicks'
  WHEN 'performance' THEN 'reporting'
  WHEN 'link' THEN 'links'
  ELSE LOWER("entityType")
END
WHERE "sourceObject" = '';

UPDATE "FieldRegistry"
SET "occurrenceCount" = GREATEST("occurrenceCount", 1)
WHERE "occurrenceCount" = 0;

DROP INDEX IF EXISTS "FieldRegistry_fieldPath_source_entityType_key";

CREATE UNIQUE INDEX IF NOT EXISTS "FieldRegistry_fieldPath_source_sourceObject_key"
  ON "FieldRegistry"("fieldPath", "source", "sourceObject");

CREATE INDEX IF NOT EXISTS "FieldRegistry_source_sourceObject_idx"
  ON "FieldRegistry"("source", "sourceObject");

CREATE TABLE IF NOT EXISTS "SourceSchemaStats" (
  "id" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "sourceObject" TEXT NOT NULL,
  "totalPayloadsObserved" INTEGER NOT NULL DEFAULT 0,
  "schemaFingerprint" TEXT,
  "apiVersion" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SourceSchemaStats_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SourceSchemaStats_network_sourceObject_key"
  ON "SourceSchemaStats"("network", "sourceObject");

CREATE INDEX IF NOT EXISTS "SourceSchemaStats_network_idx"
  ON "SourceSchemaStats"("network");
