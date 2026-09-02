-- MBO Rewards — Client Commercial Runtime persistence.
-- Additive migration: existing client commission rows are preserved.
-- Missing agreement/subsidy lineage remains NULL/false and therefore fails closed at runtime.

ALTER TABLE "client_commission_rules" ADD COLUMN IF NOT EXISTS "priority" INTEGER;
ALTER TABLE "client_commission_rules" ADD COLUMN IF NOT EXISTS "priorityVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "client_commission_rules" ADD COLUMN IF NOT EXISTS "agreementRef" TEXT;
ALTER TABLE "client_commission_rules" ADD COLUMN IF NOT EXISTS "agreementApprovedAt" TIMESTAMP(3);
ALTER TABLE "client_commission_rules" ADD COLUMN IF NOT EXISTS "agreementApprovedBy" TEXT;
ALTER TABLE "client_commission_rules" ADD COLUMN IF NOT EXISTS "subsidyApproved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "client_commission_rules" ADD COLUMN IF NOT EXISTS "subsidyApprovalRef" TEXT;
ALTER TABLE "client_commission_rules" ADD COLUMN IF NOT EXISTS "subsidyApprovedAt" TIMESTAMP(3);
ALTER TABLE "client_commission_rules" ADD COLUMN IF NOT EXISTS "subsidyApprovedBy" TEXT;
ALTER TABLE "client_commission_rules" ADD COLUMN IF NOT EXISTS "tierMetric" TEXT;
ALTER TABLE "client_commission_rules" ADD COLUMN IF NOT EXISTS "tierPeriod" TEXT;
ALTER TABLE "client_commission_rules" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- The former unique constraint allowed only one rule per assignment/effective date.
-- Conditional commercial rules must be able to coexist at the same effective boundary.
DROP INDEX IF EXISTS "client_commission_rules_assignmentId_effectiveFrom_key";
CREATE INDEX IF NOT EXISTS "client_commission_rules_assignmentId_effectiveFrom_idx"
  ON "client_commission_rules"("assignmentId", "effectiveFrom");

CREATE TABLE IF NOT EXISTS "client_commercial_conditions" (
  "id" TEXT NOT NULL,
  "commissionRuleId" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "conditionType" TEXT NOT NULL,
  "operator" TEXT NOT NULL DEFAULT 'EQ',
  "value" JSONB,
  "field" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "client_commercial_conditions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "client_commercial_conditions_commissionRuleId_idx"
  ON "client_commercial_conditions"("commissionRuleId");
CREATE INDEX IF NOT EXISTS "client_commercial_conditions_assignmentId_idx"
  ON "client_commercial_conditions"("assignmentId");
CREATE INDEX IF NOT EXISTS "client_commercial_conditions_conditionType_idx"
  ON "client_commercial_conditions"("conditionType");

CREATE TABLE IF NOT EXISTS "client_commercial_tiers" (
  "id" TEXT NOT NULL,
  "commissionRuleId" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "minInclusive" DECIMAL(18,4) NOT NULL,
  "maxExclusive" DECIMAL(18,4),
  "payoutType" TEXT NOT NULL,
  "sharePercent" DECIMAL(8,4),
  "orderValuePercent" DECIMAL(8,4),
  "fixedAmount" DECIMAL(18,4),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "client_commercial_tiers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_commercial_tiers_commissionRuleId_sequence_key"
  ON "client_commercial_tiers"("commissionRuleId", "sequence");
CREATE INDEX IF NOT EXISTS "client_commercial_tiers_assignmentId_idx"
  ON "client_commercial_tiers"("assignmentId");
CREATE INDEX IF NOT EXISTS "client_commercial_tiers_commissionRuleId_idx"
  ON "client_commercial_tiers"("commissionRuleId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'client_commercial_conditions_commissionRuleId_fkey'
  ) THEN
    ALTER TABLE "client_commercial_conditions"
      ADD CONSTRAINT "client_commercial_conditions_commissionRuleId_fkey"
      FOREIGN KEY ("commissionRuleId") REFERENCES "client_commission_rules"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'client_commercial_conditions_assignmentId_fkey'
  ) THEN
    ALTER TABLE "client_commercial_conditions"
      ADD CONSTRAINT "client_commercial_conditions_assignmentId_fkey"
      FOREIGN KEY ("assignmentId") REFERENCES "client_campaign_assignments"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'client_commercial_tiers_commissionRuleId_fkey'
  ) THEN
    ALTER TABLE "client_commercial_tiers"
      ADD CONSTRAINT "client_commercial_tiers_commissionRuleId_fkey"
      FOREIGN KEY ("commissionRuleId") REFERENCES "client_commission_rules"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'client_commercial_tiers_assignmentId_fkey'
  ) THEN
    ALTER TABLE "client_commercial_tiers"
      ADD CONSTRAINT "client_commercial_tiers_assignmentId_fkey"
      FOREIGN KEY ("assignmentId") REFERENCES "client_campaign_assignments"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
