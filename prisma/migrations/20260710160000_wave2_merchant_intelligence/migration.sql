-- Phase 2 Wave 2 — Merchant Intelligence foundation (additive)

CREATE TYPE "MerchantStatus" AS ENUM ('DRAFT', 'ACTIVE', 'MERGED', 'ARCHIVED');
CREATE TYPE "MerchantVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE "MerchantAliasStatus" AS ENUM ('CANDIDATE', 'CONFIRMED', 'REJECTED');
CREATE TYPE "MerchantAliasSource" AS ENUM ('MATCHING', 'MANUAL', 'IMPORT', 'MERGE');
CREATE TYPE "MerchantReviewStatus" AS ENUM ('AUTO_MATCHED', 'PENDING_REVIEW', 'MANUALLY_MATCHED', 'REJECTED', 'MERGED');

CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "website" TEXT,
    "logoUrl" TEXT,
    "country" CHAR(2),
    "status" "MerchantStatus" NOT NULL DEFAULT 'DRAFT',
    "verificationStatus" "MerchantVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_aliases" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "supplier" "SupplierKey" NOT NULL,
    "aliasValue" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "confidence" DECIMAL(5,4),
    "source" "MerchantAliasSource" NOT NULL DEFAULT 'MATCHING',
    "status" "MerchantAliasStatus" NOT NULL DEFAULT 'CANDIDATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_aliases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_reviews" (
    "id" TEXT NOT NULL,
    "supplierCampaignId" TEXT NOT NULL,
    "merchantId" TEXT,
    "merchantNameRaw" TEXT NOT NULL,
    "supplier" "SupplierKey" NOT NULL,
    "status" "MerchantReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "confidence" DECIMAL(5,4),
    "matchMethod" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_reviews_pkey" PRIMARY KEY ("id")
);

-- SupplierCampaign merchant linking columns
ALTER TABLE "supplier_campaigns" ADD COLUMN IF NOT EXISTS "matchedAt" TIMESTAMP(3);
ALTER TABLE "supplier_campaigns" ADD COLUMN IF NOT EXISTS "matchedBy" TEXT;
ALTER TABLE "supplier_campaigns" ADD COLUMN IF NOT EXISTS "matchConfidence" DECIMAL(5,4);

-- Unique / indexes
CREATE UNIQUE INDEX "merchants_normalizedName_key" ON "merchants"("normalizedName");
CREATE UNIQUE INDEX "merchants_slug_key" ON "merchants"("slug");
CREATE INDEX "merchants_status_idx" ON "merchants"("status");
CREATE INDEX "merchants_verificationStatus_idx" ON "merchants"("verificationStatus");
CREATE INDEX "merchants_deletedAt_idx" ON "merchants"("deletedAt");

CREATE UNIQUE INDEX "merchant_aliases_aliasValue_supplier_key" ON "merchant_aliases"("aliasValue", "supplier");
CREATE INDEX "merchant_aliases_merchantId_idx" ON "merchant_aliases"("merchantId");
CREATE INDEX "merchant_aliases_status_idx" ON "merchant_aliases"("status");
CREATE INDEX "merchant_aliases_normalizedAlias_idx" ON "merchant_aliases"("normalizedAlias");

CREATE UNIQUE INDEX "merchant_reviews_supplierCampaignId_key" ON "merchant_reviews"("supplierCampaignId");
CREATE INDEX "merchant_reviews_status_createdAt_idx" ON "merchant_reviews"("status", "createdAt");
CREATE INDEX "merchant_reviews_merchantId_idx" ON "merchant_reviews"("merchantId");
CREATE INDEX "merchant_reviews_supplier_idx" ON "merchant_reviews"("supplier");

-- Trigram search (requires pg_trgm from W1.1)
CREATE INDEX IF NOT EXISTS "merchants_displayName_trgm_idx"
  ON "merchants" USING gin ("displayName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "merchants_normalizedName_trgm_idx"
  ON "merchants" USING gin ("normalizedName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "merchant_aliases_aliasValue_trgm_idx"
  ON "merchant_aliases" USING gin ("aliasValue" gin_trgm_ops);

-- Foreign keys
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_mergedIntoId_fkey"
  FOREIGN KEY ("mergedIntoId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_aliases" ADD CONSTRAINT "merchant_aliases_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_reviews" ADD CONSTRAINT "merchant_reviews_supplierCampaignId_fkey"
  FOREIGN KEY ("supplierCampaignId") REFERENCES "supplier_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "merchant_reviews" ADD CONSTRAINT "merchant_reviews_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "supplier_campaigns" ADD CONSTRAINT "supplier_campaigns_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
