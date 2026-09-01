-- Phase 2 Wave 5 — Attribution & Reporting foundation (additive)

CREATE TYPE "ConversionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID', 'UNKNOWN');
CREATE TYPE "DeviceType" AS ENUM ('DESKTOP', 'MOBILE', 'TABLET', 'APP', 'OTHER', 'UNKNOWN');
CREATE TYPE "AttributionStatus" AS ENUM ('PENDING', 'ATTRIBUTED', 'ORPHAN', 'REATTRIBUTED');

CREATE TABLE "clicks" (
    "id" TEXT NOT NULL,
    "trackingLinkId" TEXT NOT NULL,
    "campaignSourceId" TEXT,
    "clientAssignmentId" TEXT NOT NULL,
    "subId" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgentHash" TEXT,
    "country" CHAR(2),
    "device" "DeviceType" NOT NULL DEFAULT 'UNKNOWN',
    "referrer" TEXT,
    "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "clicks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "conversions" (
    "id" TEXT NOT NULL,
    "clickId" TEXT,
    "supplier" "SupplierKey" NOT NULL DEFAULT 'UNKNOWN',
    "supplierConversionId" TEXT NOT NULL,
    "sourceAccountLabel" TEXT NOT NULL DEFAULT 'default',
    "trackingLinkId" TEXT,
    "campaignSourceId" TEXT,
    "clientAssignmentId" TEXT,
    "commissionRuleId" TEXT,
    "subId" TEXT,
    "supplierCommission" DECIMAL(18,4) NOT NULL,
    "approvedCommission" DECIMAL(18,4),
    "clientCommission" DECIMAL(18,4),
    "mboCommission" DECIMAL(18,4),
    "currency" CHAR(3),
    "status" "ConversionStatus" NOT NULL DEFAULT 'PENDING',
    "attributionStatus" "AttributionStatus" NOT NULL DEFAULT 'PENDING',
    "conversionDate" TIMESTAMP(3) NOT NULL,
    "approvedDate" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "daily_reports" (
    "id" TEXT NOT NULL,
    "reportDate" DATE NOT NULL,
    "clientId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "canonicalCampaignId" TEXT NOT NULL,
    "campaignSourceId" TEXT,
    "country" CHAR(2),
    "currency" CHAR(3),
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "conversionCount" INTEGER NOT NULL DEFAULT 0,
    "approvedConversionCount" INTEGER NOT NULL DEFAULT 0,
    "grossCommission" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "clientCommission" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "mboCommission" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "conversionRate" DECIMAL(8,6),
    "epc" DECIMAL(18,4),
    "ctr" DECIMAL(8,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "daily_reports_dimension_key"
  ON "daily_reports"(
    "clientId",
    "canonicalCampaignId",
    COALESCE("campaignSourceId", ''),
    COALESCE("country", ''),
    "reportDate"
  );

CREATE INDEX "clicks_trackingLinkId_clickedAt_idx" ON "clicks"("trackingLinkId", "clickedAt");
CREATE INDEX "clicks_clientAssignmentId_clickedAt_idx" ON "clicks"("clientAssignmentId", "clickedAt");
CREATE INDEX "clicks_subId_clickedAt_idx" ON "clicks"("subId", "clickedAt");
CREATE INDEX "clicks_clickedAt_idx" ON "clicks"("clickedAt");
CREATE INDEX "clicks_clickedAt_brin_idx" ON "clicks" USING BRIN ("clickedAt");

CREATE UNIQUE INDEX "conversions_supplier_supplierConversionId_sourceAccountLabel_key"
  ON "conversions"("supplier", "supplierConversionId", "sourceAccountLabel");
CREATE INDEX "conversions_trackingLinkId_idx" ON "conversions"("trackingLinkId");
CREATE INDEX "conversions_clientAssignmentId_conversionDate_idx" ON "conversions"("clientAssignmentId", "conversionDate");
CREATE INDEX "conversions_status_idx" ON "conversions"("status");
CREATE INDEX "conversions_conversionDate_idx" ON "conversions"("conversionDate");
CREATE INDEX "conversions_conversionDate_brin_idx" ON "conversions" USING BRIN ("conversionDate");
CREATE INDEX "conversions_attributionStatus_idx" ON "conversions"("attributionStatus");
CREATE INDEX "conversions_clickId_idx" ON "conversions"("clickId");

CREATE INDEX "daily_reports_clientId_reportDate_idx" ON "daily_reports"("clientId", "reportDate");
CREATE INDEX "daily_reports_merchantId_reportDate_idx" ON "daily_reports"("merchantId", "reportDate");
CREATE INDEX "daily_reports_canonicalCampaignId_reportDate_idx" ON "daily_reports"("canonicalCampaignId", "reportDate");
CREATE INDEX "daily_reports_campaignSourceId_reportDate_idx" ON "daily_reports"("campaignSourceId", "reportDate");
CREATE INDEX "daily_reports_reportDate_idx" ON "daily_reports"("reportDate");

ALTER TABLE "clicks" ADD CONSTRAINT "clicks_trackingLinkId_fkey"
  FOREIGN KEY ("trackingLinkId") REFERENCES "tracking_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_campaignSourceId_fkey"
  FOREIGN KEY ("campaignSourceId") REFERENCES "campaign_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "clicks" ADD CONSTRAINT "clicks_clientAssignmentId_fkey"
  FOREIGN KEY ("clientAssignmentId") REFERENCES "client_campaign_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversions" ADD CONSTRAINT "conversions_trackingLinkId_fkey"
  FOREIGN KEY ("trackingLinkId") REFERENCES "tracking_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_campaignSourceId_fkey"
  FOREIGN KEY ("campaignSourceId") REFERENCES "campaign_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_clientAssignmentId_fkey"
  FOREIGN KEY ("clientAssignmentId") REFERENCES "client_campaign_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_commissionRuleId_fkey"
  FOREIGN KEY ("commissionRuleId") REFERENCES "client_commission_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_canonicalCampaignId_fkey"
  FOREIGN KEY ("canonicalCampaignId") REFERENCES "canonical_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_campaignSourceId_fkey"
  FOREIGN KEY ("campaignSourceId") REFERENCES "campaign_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
