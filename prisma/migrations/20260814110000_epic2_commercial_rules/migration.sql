-- Epic 2: Commercial Rules Engine (additive)
-- Extends CommissionRuleType; adds ClientCommissionRule engine fields; SupplierCommissionRule.

ALTER TYPE "CommissionRuleType" ADD VALUE IF NOT EXISTS 'PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION';
ALTER TYPE "CommissionRuleType" ADD VALUE IF NOT EXISTS 'FIXED_CLIENT_PERCENT_OF_ORDER_VALUE';
ALTER TYPE "CommissionRuleType" ADD VALUE IF NOT EXISTS 'FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER';
ALTER TYPE "CommissionRuleType" ADD VALUE IF NOT EXISTS 'MANUAL_APPROVED_CLIENT_COMMISSION';
ALTER TYPE "CommissionRuleType" ADD VALUE IF NOT EXISTS 'DISPLAY_RANGE_WITH_ACTUAL_SPLIT';

ALTER TABLE "client_commission_rules"
  ADD COLUMN IF NOT EXISTS "orderValuePercent" DECIMAL(8,4),
  ADD COLUMN IF NOT EXISTS "fixedAmount" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "manualAmount" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "manualApproved" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "manualApprovedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "manualApprovedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "displayRangeMin" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "displayRangeMax" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "displayLabel" TEXT;

CREATE TABLE IF NOT EXISTS "supplier_commission_rules" (
  "id" TEXT NOT NULL,
  "campaignSourceId" TEXT,
  "supplier" "SupplierKey" NOT NULL,
  "sourceAccountLabel" TEXT NOT NULL DEFAULT 'default',
  "supplierRuleType" TEXT,
  "basis" TEXT NOT NULL DEFAULT 'UNKNOWN',
  "ratePercent" DECIMAL(8,4),
  "fixedAmount" DECIMAL(18,4),
  "currency" CHAR(3),
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effectiveUntil" TIMESTAMP(3),
  "rawPayloadId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_commission_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "supplier_commission_rules_campaignSourceId_effectiveFrom_idx"
  ON "supplier_commission_rules"("campaignSourceId", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "supplier_commission_rules_supplier_sourceAccountLabel_idx"
  ON "supplier_commission_rules"("supplier", "sourceAccountLabel");

DO $$ BEGIN
  ALTER TABLE "supplier_commission_rules"
    ADD CONSTRAINT "supplier_commission_rules_campaignSourceId_fkey"
    FOREIGN KEY ("campaignSourceId") REFERENCES "campaign_sources"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "supplier_commission_rules"
    ADD CONSTRAINT "supplier_commission_rules_rawPayloadId_fkey"
    FOREIGN KEY ("rawPayloadId") REFERENCES "raw_payloads"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
