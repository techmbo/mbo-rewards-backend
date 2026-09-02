import fs from "node:fs";

const path = "prisma/schema.prisma";
let schema = fs.readFileSync(path, "utf8");

if (schema.includes("model ClientCommercialCondition") && schema.includes("model ClientCommercialTier")) {
  console.log("Client commercial persistence schema already present.");
  process.exit(0);
}

const relationNeedle = `  commissionRules          ClientCommissionRule[]\n  clicks                   Click[]`;
if (!schema.includes(relationNeedle)) {
  throw new Error("Could not find ClientCampaignAssignment commissionRules relation anchor.");
}
schema = schema.replace(
  relationNeedle,
  `  commissionRules          ClientCommissionRule[]\n  commercialConditions     ClientCommercialCondition[]\n  commercialTiers          ClientCommercialTier[]\n  clicks                   Click[]`,
);

const ruleNeedle = `  displayRangeMax   Decimal?                 @db.Decimal(18, 4)\n  displayLabel      String?\n  effectiveFrom     DateTime`;
if (!schema.includes(ruleNeedle)) {
  throw new Error("Could not find ClientCommissionRule display/effective anchor.");
}
schema = schema.replace(
  ruleNeedle,
  `  displayRangeMax   Decimal?                 @db.Decimal(18, 4)\n  displayLabel      String?\n\n  /// Deterministic client commercial precedence. Only honored when priorityVerified=true.\n  priority          Int?\n  priorityVerified  Boolean                  @default(false)\n\n  /// Agreement / IO / SOW / approved commercial lineage.\n  agreementRef      String?\n  agreementApprovedAt DateTime?\n  agreementApprovedBy String?\n\n  /// Optional explicit subsidy/negative-margin approval attached to the rule.\n  subsidyApproved   Boolean                  @default(false)\n  subsidyApprovalRef String?\n  subsidyApprovedAt DateTime?\n  subsidyApprovedBy String?\n\n  /// Tier configuration is normalized into ClientCommercialTier rows.\n  tierMetric        String?\n  tierPeriod        String?\n  metadata          Json?\n\n  effectiveFrom     DateTime`,
);

const ruleRelationsNeedle = `  conversions           Conversion[]\n  financialTransactions FinancialTransaction[]`;
if (!schema.includes(ruleRelationsNeedle)) {
  throw new Error("Could not find ClientCommissionRule relation anchor.");
}
schema = schema.replace(
  ruleRelationsNeedle,
  `  conditions             ClientCommercialCondition[]\n  tiers                  ClientCommercialTier[]\n  conversions           Conversion[]\n  financialTransactions FinancialTransaction[]`,
);

const insertionNeedle = `\n/// Normalized supplier-side commission facts (MBO SupplierCommissionRule).`;
if (!schema.includes(insertionNeedle)) {
  throw new Error("Could not find supplier commission model insertion anchor.");
}

const models = `

model ClientCommercialCondition {
  id             String                   @id @default(uuid())
  commissionRuleId String
  commissionRule  ClientCommissionRule     @relation(fields: [commissionRuleId], references: [id], onDelete: Cascade)
  assignmentId    String
  assignment      ClientCampaignAssignment @relation(fields: [assignmentId], references: [id], onDelete: Cascade)
  conditionType   String
  operator        String                   @default("EQ")
  value           Json?
  field           String?
  metadata        Json?
  createdAt       DateTime                 @default(now())
  updatedAt       DateTime                 @updatedAt

  @@index([commissionRuleId])
  @@index([assignmentId])
  @@index([conditionType])
  @@map("client_commercial_conditions")
}

model ClientCommercialTier {
  id                String                   @id @default(uuid())
  commissionRuleId  String
  commissionRule    ClientCommissionRule     @relation(fields: [commissionRuleId], references: [id], onDelete: Cascade)
  assignmentId      String
  assignment        ClientCampaignAssignment @relation(fields: [assignmentId], references: [id], onDelete: Cascade)
  sequence          Int
  minInclusive      Decimal                  @db.Decimal(18, 4)
  maxExclusive      Decimal?                 @db.Decimal(18, 4)
  payoutType        String
  sharePercent      Decimal?                 @db.Decimal(8, 4)
  orderValuePercent Decimal?                 @db.Decimal(8, 4)
  fixedAmount       Decimal?                 @db.Decimal(18, 4)
  metadata          Json?
  createdAt         DateTime                 @default(now())
  updatedAt         DateTime                 @updatedAt

  @@unique([commissionRuleId, sequence])
  @@index([assignmentId])
  @@index([commissionRuleId])
  @@map("client_commercial_tiers")
}
`;
schema = schema.replace(insertionNeedle, `${models}${insertionNeedle}`);

fs.writeFileSync(path, schema);
console.log("Client commercial persistence schema patch applied.");
