-- Phase 2 Wave 2B — Catalog Intelligence foundation (additive)

CREATE TYPE "CanonicalCampaignStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'PAUSED', 'ARCHIVED');
CREATE TYPE "CatalogVisibility" AS ENUM ('INTERNAL', 'ASSIGNABLE', 'HIDDEN');
CREATE TYPE "CampaignSourceStatus" AS ENUM ('LINKED', 'ACTIVE', 'PREFERRED', 'DEPRECATED');
CREATE TYPE "CampaignSourceRelationshipStatus" AS ENUM ('JOINED', 'NOT_JOINED', 'PENDING', 'UNKNOWN');

CREATE TABLE "canonical_campaigns" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "CanonicalCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "CatalogVisibility" NOT NULL DEFAULT 'INTERNAL',
    "category" TEXT,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultCurrency" CHAR(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "canonical_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "campaign_sources" (
    "id" TEXT NOT NULL,
    "canonicalCampaignId" TEXT NOT NULL,
    "supplierCampaignId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "relationshipStatus" "CampaignSourceRelationshipStatus" NOT NULL DEFAULT 'UNKNOWN',
    "supportsLink" BOOLEAN NOT NULL DEFAULT false,
    "supportsCoupon" BOOLEAN NOT NULL DEFAULT false,
    "grossCommission" DECIMAL(18,4),
    "channelSupport" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" "CampaignSourceStatus" NOT NULL DEFAULT 'LINKED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_sources_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "canonical_campaigns_merchantId_idx" ON "canonical_campaigns"("merchantId");
CREATE INDEX "canonical_campaigns_status_idx" ON "canonical_campaigns"("status");
CREATE INDEX "canonical_campaigns_visibility_idx" ON "canonical_campaigns"("visibility");
CREATE INDEX "canonical_campaigns_status_merchantId_idx" ON "canonical_campaigns"("status", "merchantId");
CREATE INDEX "canonical_campaigns_deletedAt_idx" ON "canonical_campaigns"("deletedAt");

CREATE UNIQUE INDEX "campaign_sources_canonicalCampaignId_supplierCampaignId_key"
  ON "campaign_sources"("canonicalCampaignId", "supplierCampaignId");
CREATE INDEX "campaign_sources_canonicalCampaignId_isActive_priority_idx"
  ON "campaign_sources"("canonicalCampaignId", "isActive", "priority");
CREATE INDEX "campaign_sources_supplierCampaignId_idx" ON "campaign_sources"("supplierCampaignId");
CREATE INDEX "campaign_sources_status_idx" ON "campaign_sources"("status");

CREATE INDEX IF NOT EXISTS "canonical_campaigns_displayName_trgm_idx"
  ON "canonical_campaigns" USING gin ("displayName" gin_trgm_ops);

ALTER TABLE "canonical_campaigns" ADD CONSTRAINT "canonical_campaigns_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "campaign_sources" ADD CONSTRAINT "campaign_sources_canonicalCampaignId_fkey"
  FOREIGN KEY ("canonicalCampaignId") REFERENCES "canonical_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "campaign_sources" ADD CONSTRAINT "campaign_sources_supplierCampaignId_fkey"
  FOREIGN KEY ("supplierCampaignId") REFERENCES "supplier_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
