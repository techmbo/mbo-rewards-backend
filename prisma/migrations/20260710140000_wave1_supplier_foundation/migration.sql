-- Phase 2 Wave 1 — Supplier Integration foundation (additive, zero-downtime)
-- Phase 1 Entity/User tables use TEXT ids; Wave 1 FKs to Entity match TEXT.

-- CreateEnum
CREATE TYPE "SupplierKey" AS ENUM ('BOOSTINY', 'OPTIMISE', 'TRACKIER', 'PARTNERIZE', 'UNKNOWN');
CREATE TYPE "SupplierRegion" AS ENUM ('GLOBAL', 'SEA', 'MENA', 'UK', 'UNKNOWN');
CREATE TYPE "SupplierStatus" AS ENUM ('PLANNED', 'ENABLED', 'DEPRECATED');
CREATE TYPE "CampaignStatus" AS ENUM ('ACTIVE', 'PAUSED', 'PENDING', 'RETIRED', 'UNKNOWN');
CREATE TYPE "ParticipationStatus" AS ENUM ('JOINED', 'NOT_JOINED', 'PENDING', 'UNKNOWN');
CREATE TYPE "PricingModel" AS ENUM ('CPA', 'CPC', 'CPL', 'CPS', 'HYBRID', 'UNKNOWN');
CREATE TYPE "CommissionUnit" AS ENUM ('PERCENT', 'FLAT', 'UNKNOWN');
CREATE TYPE "CouponType" AS ENUM ('CODE', 'LINK', 'UNKNOWN');
CREATE TYPE "CouponStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'SCHEDULED', 'UNKNOWN');
CREATE TYPE "EventOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "MapperErrorStatus" AS ENUM ('OPEN', 'RETRYING', 'RESOLVED', 'DISCARDED');

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "key" "SupplierKey" NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "SupplierStatus" NOT NULL DEFAULT 'ENABLED',
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "supplier_campaigns" (
    "id" TEXT NOT NULL,
    "supplier" "SupplierKey" NOT NULL,
    "supplierRegion" "SupplierRegion" NOT NULL DEFAULT 'GLOBAL',
    "supplierCampaignId" TEXT NOT NULL,
    "sourceAccountLabel" TEXT NOT NULL DEFAULT 'default',
    "campaignName" TEXT NOT NULL,
    "campaignDescription" TEXT,
    "campaignLogoUrl" TEXT,
    "merchantId" TEXT,
    "merchantNameRaw" TEXT,
    "merchantVertical" TEXT,
    "categoryName" TEXT,
    "campaignType" TEXT,
    "pricingModel" "PricingModel",
    "defaultCommissionValue" DECIMAL(18,4),
    "commissionUnit" "CommissionUnit",
    "commissionCurrency" CHAR(3),
    "commissionGroups" JSONB,
    "trackingUrl" TEXT,
    "destinationUrl" TEXT,
    "deepLinkingEnabled" BOOLEAN,
    "cookieDurationDays" INTEGER,
    "campaignStatus" "CampaignStatus" NOT NULL DEFAULT 'UNKNOWN',
    "participationStatus" "ParticipationStatus",
    "isJoined" BOOLEAN NOT NULL DEFAULT false,
    "countryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "currencyCode" CHAR(3),
    "campaignStartDate" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entityId" TEXT,
    "rawPayload" JSONB NOT NULL,
    "normalizedPayload" JSONB NOT NULL,
    "mapperVersion" TEXT NOT NULL,
    "syncConflict" BOOLEAN NOT NULL DEFAULT false,
    "adminOverrides" JSONB,
    "fieldPolicies" JSONB,
    "archivedAt" TIMESTAMP(3),
    "supplierRefId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "supplier_coupons" (
    "id" TEXT NOT NULL,
    "supplierCampaignId" TEXT NOT NULL,
    "entityId" TEXT,
    "supplierCouponId" TEXT,
    "couponType" "CouponType" NOT NULL DEFAULT 'UNKNOWN',
    "couponCode" TEXT,
    "couponLink" TEXT,
    "couponDescription" TEXT,
    "discountValue" TEXT,
    "couponStartDate" TIMESTAMP(3),
    "couponEndDate" TIMESTAMP(3),
    "couponStatus" "CouponStatus" NOT NULL DEFAULT 'UNKNOWN',
    "couponIsExclusive" BOOLEAN,
    "rawPayload" JSONB NOT NULL,
    "normalizedPayload" JSONB NOT NULL,
    "mapperVersion" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_coupons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "event_outbox" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "EventOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mapper_errors" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "supplier" "SupplierKey",
    "entityType" TEXT NOT NULL,
    "errorCode" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stackTrace" TEXT,
    "mapperVersion" TEXT,
    "status" "MapperErrorStatus" NOT NULL DEFAULT 'OPEN',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "mapper_errors_pkey" PRIMARY KEY ("id")
);

-- Unique indexes
CREATE UNIQUE INDEX "suppliers_key_key" ON "suppliers"("key");
CREATE UNIQUE INDEX "supplier_campaigns_supplier_supplierRegion_sourceAccountLabel_supplierCampaignId_key" ON "supplier_campaigns"("supplier", "supplierRegion", "sourceAccountLabel", "supplierCampaignId");
CREATE UNIQUE INDEX "event_outbox_eventId_key" ON "event_outbox"("eventId");

-- Partial unique indexes (Prisma cannot express; see PHASE2_DATABASE_VALIDATION.md §4.2)
CREATE UNIQUE INDEX "supplier_coupons_campaign_code_unique"
  ON "supplier_coupons" ("supplierCampaignId", "couponCode")
  WHERE "couponType" = 'CODE' AND "couponCode" IS NOT NULL;

CREATE UNIQUE INDEX "supplier_coupons_campaign_link_unique"
  ON "supplier_coupons" ("supplierCampaignId", "couponLink")
  WHERE "couponType" = 'LINK' AND "couponLink" IS NOT NULL;

-- Indexes
CREATE INDEX "supplier_campaigns_merchantId_idx" ON "supplier_campaigns"("merchantId");
CREATE INDEX "supplier_campaigns_campaignStatus_idx" ON "supplier_campaigns"("campaignStatus");
CREATE INDEX "supplier_campaigns_participationStatus_idx" ON "supplier_campaigns"("participationStatus");
CREATE INDEX "supplier_campaigns_lastSyncedAt_idx" ON "supplier_campaigns"("lastSyncedAt" DESC);
CREATE INDEX "supplier_campaigns_entityId_idx" ON "supplier_campaigns"("entityId");
CREATE INDEX "supplier_campaigns_supplier_campaignStatus_idx" ON "supplier_campaigns"("supplier", "campaignStatus");

CREATE INDEX "supplier_coupons_supplierCampaignId_idx" ON "supplier_coupons"("supplierCampaignId");
CREATE INDEX "supplier_coupons_couponStatus_idx" ON "supplier_coupons"("couponStatus");
CREATE INDEX "supplier_coupons_entityId_idx" ON "supplier_coupons"("entityId");

CREATE INDEX "event_outbox_status_createdAt_idx" ON "event_outbox"("status", "createdAt");
CREATE INDEX "event_outbox_eventType_createdAt_idx" ON "event_outbox"("eventType", "createdAt");

CREATE INDEX "mapper_errors_status_createdAt_idx" ON "mapper_errors"("status", "createdAt");
CREATE INDEX "mapper_errors_entityId_idx" ON "mapper_errors"("entityId");

-- Foreign keys
ALTER TABLE "supplier_campaigns" ADD CONSTRAINT "supplier_campaigns_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "supplier_campaigns" ADD CONSTRAINT "supplier_campaigns_supplierRefId_fkey" FOREIGN KEY ("supplierRefId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "supplier_coupons" ADD CONSTRAINT "supplier_coupons_supplierCampaignId_fkey" FOREIGN KEY ("supplierCampaignId") REFERENCES "supplier_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_coupons" ADD CONSTRAINT "supplier_coupons_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "mapper_errors" ADD CONSTRAINT "mapper_errors_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed supplier registry (idempotent via ON CONFLICT)
INSERT INTO "suppliers" ("id", "key", "displayName", "status", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'BOOSTINY', 'Boostiny', 'ENABLED', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'OPTIMISE', 'Optimise', 'ENABLED', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'TRACKIER', 'Trackier', 'ENABLED', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'PARTNERIZE', 'Partnerize', 'PLANNED', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
