-- Network Operation Portal — schema extensions (CouponCodeMaster, NetworkPerformanceFact, mapping certification, health stamps)

-- MarketplaceAccount health stamps
ALTER TABLE "MarketplaceAccount" ADD COLUMN IF NOT EXISTS "lastOrderSyncAt" TIMESTAMP(3);
ALTER TABLE "MarketplaceAccount" ADD COLUMN IF NOT EXISTS "lastPaymentSyncAt" TIMESTAMP(3);
ALTER TABLE "MarketplaceAccount" ADD COLUMN IF NOT EXISTS "syncFrequencyMinutes" INTEGER;
ALTER TABLE "MarketplaceAccount" ADD COLUMN IF NOT EXISTS "lastAuthCheckAt" TIMESTAMP(3);
ALTER TABLE "MarketplaceAccount" ADD COLUMN IF NOT EXISTS "lastSyncError" TEXT;

-- CouponStatus DISABLED
DO $$ BEGIN
  ALTER TYPE "CouponStatus" ADD VALUE IF NOT EXISTS 'DISABLED';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- New enums
DO $$ BEGIN
  CREATE TYPE "CouponCodeSource" AS ENUM ('NETWORK_API', 'MANUAL_EMAIL', 'EXCEL', 'ACCOUNT_MANAGER', 'BRAND', 'MANUAL', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CouponCodeScope" AS ENUM ('SHARED_LIMITED', 'UNIQUE_TO_CLIENT', 'UNLIMITED', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MappingCertificationStatus" AS ENUM ('PENDING', 'CERTIFIED', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CampaignChannelType" AS ENUM ('AFFILIATE_LINK_ONLY', 'COUPON_CODE_ONLY', 'COUPON_AND_LINK', 'DEEPLINK', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "NetworkReconStatus" AS ENUM ('MATCHED', 'PENDING', 'PARTIAL', 'MISMATCH', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ExceptionCaseType network values
DO $$ BEGIN
  ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'NETWORK_AUTH_FAILURE';
  ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'NETWORK_CAMPAIGN_SYNC_FAILURE';
  ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'NETWORK_COUPON_SYNC_FAILURE';
  ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'NETWORK_ORDER_SYNC_FAILURE';
  ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'NETWORK_PAYMENT_SYNC_FAILURE';
  ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'NETWORK_NEW_COUPON_ALERT';
  ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'NETWORK_RECONCILIATION_VARIANCE';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "coupon_code_masters" (
  "id" TEXT NOT NULL,
  "supplier" "SupplierKey" NOT NULL,
  "sourceAccountLabel" TEXT NOT NULL DEFAULT 'default',
  "supplierCampaignId" TEXT NOT NULL,
  "campaignSourceId" TEXT,
  "supplierCouponId" TEXT,
  "supplierCouponExtId" TEXT,
  "couponCode" TEXT NOT NULL,
  "source" "CouponCodeSource" NOT NULL DEFAULT 'UNKNOWN',
  "scope" "CouponCodeScope" NOT NULL DEFAULT 'UNKNOWN',
  "totalQuantity" INTEGER,
  "assignedQuantity" INTEGER NOT NULL DEFAULT 0,
  "status" "CouponStatus" NOT NULL DEFAULT 'UNKNOWN',
  "validFrom" TIMESTAMP(3),
  "validUntil" TIMESTAMP(3),
  "newCodeAlert" BOOLEAN NOT NULL DEFAULT false,
  "alertReviewedAt" TIMESTAMP(3),
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL,
  "rawPayloadId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coupon_code_masters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "coupon_code_masters_supplierCouponId_key" ON "coupon_code_masters"("supplierCouponId");
CREATE UNIQUE INDEX IF NOT EXISTS "coupon_code_masters_supplier_sourceAccountLabel_supplierCampaignId_couponCode_key"
  ON "coupon_code_masters"("supplier", "sourceAccountLabel", "supplierCampaignId", "couponCode");
CREATE INDEX IF NOT EXISTS "coupon_code_masters_supplier_newCodeAlert_status_idx" ON "coupon_code_masters"("supplier", "newCodeAlert", "status");
CREATE INDEX IF NOT EXISTS "coupon_code_masters_campaignSourceId_idx" ON "coupon_code_masters"("campaignSourceId");
CREATE INDEX IF NOT EXISTS "coupon_code_masters_detectedAt_idx" ON "coupon_code_masters"("detectedAt" DESC);

ALTER TABLE "coupon_code_masters"
  DROP CONSTRAINT IF EXISTS "coupon_code_masters_supplierCampaignId_fkey";
ALTER TABLE "coupon_code_masters"
  ADD CONSTRAINT "coupon_code_masters_supplierCampaignId_fkey"
  FOREIGN KEY ("supplierCampaignId") REFERENCES "supplier_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "coupon_code_masters"
  DROP CONSTRAINT IF EXISTS "coupon_code_masters_supplierCouponId_fkey";
ALTER TABLE "coupon_code_masters"
  ADD CONSTRAINT "coupon_code_masters_supplierCouponId_fkey"
  FOREIGN KEY ("supplierCouponId") REFERENCES "supplier_coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "mapping_certifications" (
  "id" TEXT NOT NULL,
  "supplierCampaignId" TEXT NOT NULL,
  "status" "MappingCertificationStatus" NOT NULL DEFAULT 'PENDING',
  "checklist" JSONB NOT NULL,
  "certifiedAt" TIMESTAMP(3),
  "certifiedBy" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokedBy" TEXT,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mapping_certifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mapping_certifications_supplierCampaignId_key" ON "mapping_certifications"("supplierCampaignId");
CREATE INDEX IF NOT EXISTS "mapping_certifications_status_idx" ON "mapping_certifications"("status");

ALTER TABLE "mapping_certifications"
  DROP CONSTRAINT IF EXISTS "mapping_certifications_supplierCampaignId_fkey";
ALTER TABLE "mapping_certifications"
  ADD CONSTRAINT "mapping_certifications_supplierCampaignId_fkey"
  FOREIGN KEY ("supplierCampaignId") REFERENCES "supplier_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "network_performance_facts" (
  "id" TEXT NOT NULL,
  "grainKey" TEXT NOT NULL,
  "supplier" "SupplierKey" NOT NULL,
  "sourceAccountLabel" TEXT NOT NULL DEFAULT 'default',
  "reportDate" DATE NOT NULL,
  "reportExternalId" TEXT,
  "campaignSourceId" TEXT,
  "supplierCampaignDbId" TEXT,
  "supplierCampaignId" TEXT,
  "brandName" TEXT,
  "campaignName" TEXT,
  "category" TEXT,
  "country" CHAR(2),
  "currency" CHAR(3),
  "campaignTypeCommercial" TEXT,
  "campaignChannelType" "CampaignChannelType" NOT NULL DEFAULT 'UNKNOWN',
  "couponId" TEXT,
  "couponCode" TEXT,
  "couponSource" TEXT,
  "couponScope" TEXT,
  "networkTrackingLink" TEXT,
  "mboTrackingLink" TEXT,
  "trackingLinkId" TEXT,
  "networkClickId" TEXT,
  "mboClickId" TEXT,
  "subId1" TEXT,
  "subId2" TEXT,
  "subId3" TEXT,
  "impressions" INTEGER,
  "networkClicks" INTEGER,
  "mboLinkClicks" INTEGER,
  "uniqueClicks" INTEGER,
  "grossOrders" INTEGER,
  "pendingOrders" INTEGER,
  "confirmedOrders" INTEGER,
  "cancelledOrders" INTEGER,
  "rejectedOrders" INTEGER,
  "paidOrders" INTEGER,
  "grossOrderValue" DECIMAL(18,4),
  "pendingOrderValue" DECIMAL(18,4),
  "confirmedOrderValue" DECIMAL(18,4),
  "cancelledOrderValue" DECIMAL(18,4),
  "rejectedOrderValue" DECIMAL(18,4),
  "paidOrderValue" DECIMAL(18,4),
  "grossCommission" DECIMAL(18,4),
  "pendingCommission" DECIMAL(18,4),
  "confirmedCommission" DECIMAL(18,4),
  "cancelledCommission" DECIMAL(18,4),
  "rejectedCommission" DECIMAL(18,4),
  "payableCommission" DECIMAL(18,4),
  "paidCommission" DECIMAL(18,4),
  "mboReceivable" DECIMAL(18,4),
  "mboActuallyReceived" DECIMAL(18,4),
  "discountPercent" DECIMAL(8,4),
  "customerType" TEXT,
  "devicePlatform" TEXT,
  "conversionRate" DECIMAL(12,6),
  "aov" DECIMAL(18,4),
  "epc" DECIMAL(18,4),
  "attributionStatus" TEXT,
  "reconciliationStatus" TEXT,
  "rawPayloadId" TEXT,
  "sourceEndpoint" TEXT,
  "reportGranularity" TEXT,
  "lastSyncedAt" TIMESTAMP(3),
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "network_performance_facts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "network_performance_facts_grainKey_key" ON "network_performance_facts"("grainKey");
CREATE INDEX IF NOT EXISTS "network_performance_facts_supplier_reportDate_idx" ON "network_performance_facts"("supplier", "reportDate");
CREATE INDEX IF NOT EXISTS "network_performance_facts_campaignSourceId_reportDate_idx" ON "network_performance_facts"("campaignSourceId", "reportDate");
CREATE INDEX IF NOT EXISTS "network_performance_facts_supplierCampaignDbId_reportDate_idx" ON "network_performance_facts"("supplierCampaignDbId", "reportDate");

ALTER TABLE "network_performance_facts"
  DROP CONSTRAINT IF EXISTS "network_performance_facts_supplierCampaignDbId_fkey";
ALTER TABLE "network_performance_facts"
  ADD CONSTRAINT "network_performance_facts_supplierCampaignDbId_fkey"
  FOREIGN KEY ("supplierCampaignDbId") REFERENCES "supplier_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "network_reconciliation_rows" (
  "id" TEXT NOT NULL,
  "grainKey" TEXT NOT NULL,
  "supplier" "SupplierKey" NOT NULL,
  "sourceAccountLabel" TEXT NOT NULL DEFAULT 'default',
  "billingMonth" INTEGER NOT NULL,
  "billingYear" INTEGER NOT NULL,
  "campaignSourceId" TEXT,
  "supplierCampaignId" TEXT,
  "brandName" TEXT,
  "campaignName" TEXT,
  "reportedCommission" DECIMAL(18,4),
  "confirmedCommission" DECIMAL(18,4),
  "paidCommission" DECIMAL(18,4),
  "reportedVsConfirmed" DECIMAL(18,4),
  "confirmedVsPaid" DECIMAL(18,4),
  "status" "NetworkReconStatus" NOT NULL DEFAULT 'UNKNOWN',
  "currency" CHAR(3),
  "reconciledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "orderDrilldown" JSONB,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "network_reconciliation_rows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "network_reconciliation_rows_grainKey_key" ON "network_reconciliation_rows"("grainKey");
CREATE INDEX IF NOT EXISTS "network_reconciliation_rows_billingYear_billingMonth_supplier_idx"
  ON "network_reconciliation_rows"("billingYear", "billingMonth", "supplier");
CREATE INDEX IF NOT EXISTS "network_reconciliation_rows_status_idx" ON "network_reconciliation_rows"("status");
