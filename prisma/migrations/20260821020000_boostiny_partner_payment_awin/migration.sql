-- Boostiny Partner Payment aggregate settlement + Awin supplier key + exception types.

-- SupplierKey.AWIN
ALTER TYPE "SupplierKey" ADD VALUE IF NOT EXISTS 'AWIN';

-- Exception types
ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'BOOSTINY_SOURCE_MAPPING_MISSING';
ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'BOOSTINY_PARTNER_PAYMENT_INVALID';

DO $$ BEGIN
  CREATE TYPE "BoostinySettlementStatus" AS ENUM ('PENDING_REVIEW', 'SETTLED', 'BLOCKED', 'SUPERSEDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "boostiny_payment_source_mappings" (
  "id" TEXT NOT NULL,
  "paymentSource" TEXT NOT NULL,
  "sourceAccountLabel" TEXT NOT NULL DEFAULT 'default',
  "clientId" TEXT NOT NULL,
  "clientAssignmentId" TEXT,
  "notes" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "boostiny_payment_source_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "boostiny_payment_source_mappings_paymentSource_sourceAccountLabel_key"
  ON "boostiny_payment_source_mappings"("paymentSource", "sourceAccountLabel");
CREATE INDEX IF NOT EXISTS "boostiny_payment_source_mappings_clientId_isActive_idx"
  ON "boostiny_payment_source_mappings"("clientId", "isActive");

DO $$ BEGIN
  ALTER TABLE "boostiny_payment_source_mappings"
    ADD CONSTRAINT "boostiny_payment_source_mappings_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "boostiny_partner_payment_settlements" (
  "id" TEXT NOT NULL,
  "settlementKey" TEXT NOT NULL,
  "sourceAccountLabel" TEXT NOT NULL DEFAULT 'default',
  "paymentSource" TEXT NOT NULL,
  "cycle" TEXT NOT NULL,
  "legalEntityName" TEXT,
  "ordersCount" INTEGER,
  "revenue" DECIMAL(18,4),
  "salesAmountUsd" DECIMAL(18,4),
  "extra" DECIMAL(18,4),
  "deduction" DECIMAL(18,4),
  "delayed" DECIMAL(18,4),
  "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "confirmationGranularity" TEXT NOT NULL DEFAULT 'PAYMENT_SOURCE_CYCLE',
  "status" "BoostinySettlementStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "clientId" TEXT,
  "mappingId" TEXT,
  "uploadBatchId" TEXT,
  "rawRow" JSONB,
  "rawPayloadId" TEXT,
  "blockReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "boostiny_partner_payment_settlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "boostiny_partner_payment_settlements_settlementKey_key"
  ON "boostiny_partner_payment_settlements"("settlementKey");
CREATE INDEX IF NOT EXISTS "boostiny_partner_payment_settlements_paymentSource_cycle_idx"
  ON "boostiny_partner_payment_settlements"("paymentSource", "cycle");
CREATE INDEX IF NOT EXISTS "boostiny_partner_payment_settlements_clientId_cycle_idx"
  ON "boostiny_partner_payment_settlements"("clientId", "cycle");
CREATE INDEX IF NOT EXISTS "boostiny_partner_payment_settlements_uploadBatchId_idx"
  ON "boostiny_partner_payment_settlements"("uploadBatchId");
CREATE INDEX IF NOT EXISTS "boostiny_partner_payment_settlements_status_idx"
  ON "boostiny_partner_payment_settlements"("status");

DO $$ BEGIN
  ALTER TABLE "boostiny_partner_payment_settlements"
    ADD CONSTRAINT "boostiny_partner_payment_settlements_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "boostiny_partner_payment_settlements"
    ADD CONSTRAINT "boostiny_partner_payment_settlements_mappingId_fkey"
    FOREIGN KEY ("mappingId") REFERENCES "boostiny_payment_source_mappings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
