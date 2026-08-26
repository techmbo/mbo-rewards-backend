-- Wave B: append-only RawPayload + lineage FKs (non-destructive).
-- Does NOT drop Entity, couponEntityId API fields, or existing assignment columns.

CREATE TYPE "RawPayloadStatus" AS ENUM ('RECEIVED', 'STAGED', 'PROMOTED', 'FAILED', 'DUPLICATE');

CREATE TABLE "raw_payloads" (
    "id" TEXT NOT NULL,
    "supplier" "SupplierKey" NOT NULL,
    "supplierRegion" "SupplierRegion" NOT NULL DEFAULT 'UNKNOWN',
    "sourceAccountLabel" TEXT NOT NULL DEFAULT 'default',
    "resourceKey" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mapperVersion" TEXT,
    "processingStatus" "RawPayloadStatus" NOT NULL DEFAULT 'RECEIVED',
    "networkSource" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_payloads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "raw_payloads_supplier_sourceAccountLabel_resourceKey_exter_key"
  ON "raw_payloads"("supplier", "sourceAccountLabel", "resourceKey", "externalId", "payloadHash");

CREATE INDEX "raw_payloads_supplier_entityType_receivedAt_idx"
  ON "raw_payloads"("supplier", "entityType", "receivedAt" DESC);

CREATE INDEX "raw_payloads_payloadHash_idx" ON "raw_payloads"("payloadHash");
CREATE INDEX "raw_payloads_entityId_idx" ON "raw_payloads"("entityId");
CREATE INDEX "raw_payloads_networkSource_entityType_idx" ON "raw_payloads"("networkSource", "entityType");

ALTER TABLE "raw_payloads"
  ADD CONSTRAINT "raw_payloads_entityId_fkey"
  FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Optional lineage on promoted supplier models / conversions
ALTER TABLE "supplier_campaigns" ADD COLUMN IF NOT EXISTS "rawPayloadId" TEXT;
ALTER TABLE "supplier_coupons" ADD COLUMN IF NOT EXISTS "rawPayloadId" TEXT;
ALTER TABLE "conversions" ADD COLUMN IF NOT EXISTS "rawPayloadId" TEXT;

CREATE INDEX IF NOT EXISTS "supplier_campaigns_rawPayloadId_idx" ON "supplier_campaigns"("rawPayloadId");
CREATE INDEX IF NOT EXISTS "supplier_coupons_rawPayloadId_idx" ON "supplier_coupons"("rawPayloadId");
CREATE INDEX IF NOT EXISTS "conversions_rawPayloadId_idx" ON "conversions"("rawPayloadId");

ALTER TABLE "supplier_campaigns"
  ADD CONSTRAINT "supplier_campaigns_rawPayloadId_fkey"
  FOREIGN KEY ("rawPayloadId") REFERENCES "raw_payloads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "supplier_coupons"
  ADD CONSTRAINT "supplier_coupons_rawPayloadId_fkey"
  FOREIGN KEY ("rawPayloadId") REFERENCES "raw_payloads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversions"
  ADD CONSTRAINT "conversions_rawPayloadId_fkey"
  FOREIGN KEY ("rawPayloadId") REFERENCES "raw_payloads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
