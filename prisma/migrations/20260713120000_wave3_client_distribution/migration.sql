-- Phase 2 Wave 3 — Client Distribution foundation (additive)

CREATE TYPE "ClientStatus" AS ENUM ('PROSPECT', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED');
CREATE TYPE "BrandRequestStatus" AS ENUM ('REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'FULFILLED');
CREATE TYPE "AssignmentStatus" AS ENUM ('ASSIGNED', 'ACTIVE', 'PAUSED', 'REVOKED');

CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "industry" TEXT,
    "country" CHAR(2),
    "currency" CHAR(3),
    "timezone" TEXT,
    "logoUrl" TEXT,
    "status" "ClientStatus" NOT NULL DEFAULT 'PROSPECT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "client_brand_requests" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "merchantId" TEXT,
    "requestedBrandName" TEXT NOT NULL,
    "requestedBy" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "status" "BrandRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "notes" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "fulfilledAssignmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_brand_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "client_campaign_assignments" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "canonicalCampaignId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "unpublishedAt" TIMESTAMP(3),
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "channel" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_campaign_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clients_slug_key" ON "clients"("slug");
CREATE INDEX "clients_status_idx" ON "clients"("status");
CREATE INDEX "clients_deletedAt_idx" ON "clients"("deletedAt");

CREATE UNIQUE INDEX "client_brand_requests_fulfilledAssignmentId_key"
  ON "client_brand_requests"("fulfilledAssignmentId");
CREATE INDEX "client_brand_requests_clientId_status_idx"
  ON "client_brand_requests"("clientId", "status");
CREATE INDEX "client_brand_requests_merchantId_idx" ON "client_brand_requests"("merchantId");
CREATE INDEX "client_brand_requests_status_requestedAt_idx"
  ON "client_brand_requests"("status", "requestedAt");

CREATE INDEX "client_campaign_assignments_clientId_status_idx"
  ON "client_campaign_assignments"("clientId", "status");
CREATE INDEX "client_campaign_assignments_canonicalCampaignId_status_idx"
  ON "client_campaign_assignments"("canonicalCampaignId", "status");
CREATE INDEX "client_campaign_assignments_published_status_idx"
  ON "client_campaign_assignments"("published", "status");

-- One non-revoked assignment per client + catalog campaign
CREATE UNIQUE INDEX "client_campaign_assignments_client_campaign_active_key"
  ON "client_campaign_assignments"("clientId", "canonicalCampaignId")
  WHERE "status" IN ('ASSIGNED', 'ACTIVE', 'PAUSED');

CREATE INDEX IF NOT EXISTS "clients_name_trgm_idx"
  ON "clients" USING gin ("name" gin_trgm_ops);

ALTER TABLE "client_brand_requests" ADD CONSTRAINT "client_brand_requests_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "client_brand_requests" ADD CONSTRAINT "client_brand_requests_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "client_brand_requests" ADD CONSTRAINT "client_brand_requests_fulfilledAssignmentId_fkey"
  FOREIGN KEY ("fulfilledAssignmentId") REFERENCES "client_campaign_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "client_campaign_assignments" ADD CONSTRAINT "client_campaign_assignments_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "client_campaign_assignments" ADD CONSTRAINT "client_campaign_assignments_canonicalCampaignId_fkey"
  FOREIGN KEY ("canonicalCampaignId") REFERENCES "canonical_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
