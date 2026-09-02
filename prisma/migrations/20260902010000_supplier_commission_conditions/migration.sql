-- MBO Rewards — Supplier Commission Rule normalization + child conditions.
-- Existing rule rows are preserved and receive a deterministic legacy outcome key.

ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "sourceGroupId" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "sourceGroupName" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "sourceRuleName" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "outcomeKey" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "commissionSequence" INTEGER;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "commissionModel" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "commissionType" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "actionType" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "priority" INTEGER;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "rank" INTEGER;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "rawRuleReference" JSONB;

-- Never collapse existing historical rows. Give each legacy row its own deterministic identity.
UPDATE "supplier_commission_rules"
SET "outcomeKey" = 'legacy:' || "id"
WHERE "outcomeKey" IS NULL OR BTRIM("outcomeKey") = '';

-- Prisma declares outcomeKey non-null. Backfill first, then enforce the same contract
-- at the database layer so application/schema/migration cannot disagree.
ALTER TABLE "supplier_commission_rules"
  ALTER COLUMN "outcomeKey" SET NOT NULL;

-- History is part of identity: the same logical outcome may legitimately have multiple
-- effective versions, but the same version may not be inserted twice.
DROP INDEX IF EXISTS "supplier_commission_rules_outcome_identity_key";
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_commission_rules_outcome_identity_key"
  ON "supplier_commission_rules"("supplier", "sourceAccountLabel", "outcomeKey", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "supplier_commission_rules_sourceGroupId_idx"
  ON "supplier_commission_rules"("sourceGroupId");
CREATE INDEX IF NOT EXISTS "supplier_commission_rules_commissionSequence_idx"
  ON "supplier_commission_rules"("supplierCampaignId", "commissionSequence");

CREATE TABLE IF NOT EXISTS "supplier_commission_conditions" (
    "id" TEXT NOT NULL,
    "commissionRuleId" TEXT NOT NULL,
    "conditionType" TEXT NOT NULL,
    "operator" TEXT,
    "value" TEXT NOT NULL,
    "sourceConditionType" TEXT,
    "sourceConditionValue" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_commission_conditions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "supplier_commission_conditions_rule_idx"
  ON "supplier_commission_conditions"("commissionRuleId");
CREATE INDEX IF NOT EXISTS "supplier_commission_conditions_type_value_idx"
  ON "supplier_commission_conditions"("conditionType", "value");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'supplier_commission_conditions_rule_fkey'
  ) THEN
    ALTER TABLE "supplier_commission_conditions"
      ADD CONSTRAINT "supplier_commission_conditions_rule_fkey"
      FOREIGN KEY ("commissionRuleId") REFERENCES "supplier_commission_rules"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
