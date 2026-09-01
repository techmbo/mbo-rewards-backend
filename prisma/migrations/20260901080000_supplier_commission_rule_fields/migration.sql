ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "supplierCampaignId" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "sourceRuleId" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "customerType" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "categoryProductGoal" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "couponOrTier" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "networkSource" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "sourceObject" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "sourcePath" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "mappingStatus" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "fieldMappingOutcome" TEXT;
ALTER TABLE "supplier_commission_rules" ADD COLUMN IF NOT EXISTS "ruleVersion" TEXT;

CREATE INDEX IF NOT EXISTS "supplier_commission_rules_supplierCampaignId_idx"
  ON "supplier_commission_rules"("supplierCampaignId");
CREATE INDEX IF NOT EXISTS "supplier_commission_rules_sourceRuleId_idx"
  ON "supplier_commission_rules"("sourceRuleId");
CREATE INDEX IF NOT EXISTS "supplier_commission_rules_networkSource_idx"
  ON "supplier_commission_rules"("networkSource");
