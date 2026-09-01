const fs = require('fs');

const path = 'prisma/schema.prisma';
const text = fs.readFileSync(path, 'utf8');

const replacement = `/// Normalized supplier-side commission facts (MBO SupplierCommissionRule).
/// One row = one distinct payable supplier outcome. Campaign summaries are display-only.
model SupplierCommissionRule {
  id                     String                        @id @default(uuid())
  campaignSourceId       String?
  campaignSource         CampaignSource?               @relation(fields: [campaignSourceId], references: [id], onDelete: SetNull)
  supplierCampaignId     String?
  supplierCampaign       SupplierCampaign?             @relation(fields: [supplierCampaignId], references: [id], onDelete: SetNull)
  supplier               SupplierKey
  sourceAccountLabel     String                        @default("default")

  /// Source lineage. Source groups/rules never replace MBO outcome identity.
  sourceGroupId          String?
  sourceGroupName        String?
  sourceRuleId           String?
  sourceRuleName         String?

  /// Stable MBO identity for one payable outcome under the source rule/group.
  outcomeKey             String
  /// UI ordering only: Commission 1...N. Never a financial identity.
  commissionSequence     Int?

  commissionModel        String?
  commissionType         String?
  /// Supplier-facing type label (CPS/CPA/PERCENT/FIXED/TIERED/etc.) — informational.
  supplierRuleType       String?
  /// Canonical payout basis such as PERCENT_OF_SALE, FIXED_AMOUNT, CPA, CPL, CPI, CPC, CPM.
  basis                  String                        @default("UNKNOWN")
  ratePercent            Decimal?                      @db.Decimal(8, 4)
  fixedAmount            Decimal?                      @db.Decimal(18, 4)
  currency               String?                       @db.Char(3)
  actionType             String?

  /// Verified supplier precedence only. Null means no verified source precedence.
  priority               Int?
  rank                   Int?

  /// Legacy/convenience display fields. Conditions relation is authoritative for matching.
  customerType           String?
  country                String?
  categoryProductGoal    String?
  couponOrTier           String?

  networkSource          String?
  sourceObject           String?
  sourcePath             String?
  mappingStatus          String?
  fieldMappingOutcome    String?
  ruleVersion            String?
  effectiveFrom          DateTime                      @default(now())
  effectiveUntil         DateTime?
  rawPayloadId           String?
  rawPayloadRecord       RawPayload?                   @relation(fields: [rawPayloadId], references: [id], onDelete: SetNull)
  /// Complete source rule/group fragment retained as evidence in addition to immutable RawPayload lineage.
  rawRuleReference       Json?
  metadata               Json?
  createdAt              DateTime                      @default(now())
  updatedAt              DateTime                      @updatedAt

  conditions             SupplierCommissionCondition[]

  @@unique([supplier, sourceAccountLabel, outcomeKey, effectiveFrom], map: "supplier_commission_rules_outcome_identity_key")
  @@index([campaignSourceId, effectiveFrom])
  @@index([supplierCampaignId])
  @@index([supplier, sourceAccountLabel])
  @@index([networkSource])
  @@index([sourceRuleId])
  @@index([sourceGroupId])
  @@index([supplierCampaignId, commissionSequence])
  @@map("supplier_commission_rules")
}

/// Conditions attached to one SupplierCommissionRule payable outcome.
/// Multiple rows on one rule are AND conditions unless verified source semantics explicitly say otherwise.
model SupplierCommissionCondition {
  id                       String                  @id @default(uuid())
  commissionRuleId         String
  commissionRule           SupplierCommissionRule @relation(fields: [commissionRuleId], references: [id], onDelete: Cascade)
  conditionType            String
  operator                 String?
  value                    String
  sourceConditionType      String?
  sourceConditionValue     Json?
  metadata                 Json?
  createdAt                DateTime                @default(now())
  updatedAt                DateTime                @updatedAt

  @@index([commissionRuleId], map: "supplier_commission_conditions_rule_idx")
  @@index([conditionType, value], map: "supplier_commission_conditions_type_value_idx")
  @@map("supplier_commission_conditions")
}`;

const pattern = /\/\/\/ Normalized supplier-side commission facts \(v15 SupplierCommissionRule\)\.[\s\S]*?model SupplierCommissionRule \{[\s\S]*?@@map\("supplier_commission_rules"\)\n\}/;

if (!pattern.test(text)) {
  throw new Error('SupplierCommissionRule block not found; refusing to guess schema edit.');
}

const next = text.replace(pattern, replacement);
if (next === text) {
  throw new Error('Schema replacement produced no change.');
}

fs.writeFileSync(path, next);
console.log('Aligned SupplierCommissionRule and SupplierCommissionCondition in prisma/schema.prisma');
