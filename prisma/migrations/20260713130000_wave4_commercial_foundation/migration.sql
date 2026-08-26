-- Phase 2 Wave 4 — Commercial foundation (additive)

CREATE TYPE "TrackingLinkStatus" AS ENUM ('GENERATED', 'ACTIVE', 'REVOKED');
CREATE TYPE "TrackingType" AS ENUM ('STANDARD', 'DEEPLINK', 'HYBRID', 'UNKNOWN');
CREATE TYPE "CouponAssignmentStatus" AS ENUM ('ASSIGNED', 'ACTIVE', 'EXPIRED', 'REVOKED');
CREATE TYPE "CommissionRuleStatus" AS ENUM ('DRAFT', 'EFFECTIVE', 'SUPERSEDED');
CREATE TYPE "CommissionRuleType" AS ENUM ('PERCENT', 'FIXED', 'TIERED', 'UNKNOWN');

CREATE TABLE "tracking_links" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "campaignSourceId" TEXT,
    "subId" TEXT NOT NULL,
    "supplierTrackingUrl" TEXT,
    "mboTrackingUrl" TEXT NOT NULL,
    "deeplinkTemplate" TEXT,
    "trackingType" "TrackingType" NOT NULL DEFAULT 'STANDARD',
    "status" "TrackingLinkStatus" NOT NULL DEFAULT 'GENERATED',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "tracking_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "client_coupon_assignments" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "supplierCouponId" TEXT,
    "supplierCouponCode" TEXT,
    "clientCouponCode" TEXT,
    "couponType" "CouponType" NOT NULL DEFAULT 'UNKNOWN',
    "status" "CouponAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_coupon_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "client_commission_rules" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "grossCommission" DECIMAL(18,4) NOT NULL,
    "clientCommission" DECIMAL(18,4) NOT NULL,
    "mboCommission" DECIMAL(18,4) NOT NULL,
    "commissionType" "CommissionRuleType" NOT NULL DEFAULT 'UNKNOWN',
    "currency" CHAR(3),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "status" "CommissionRuleStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_commission_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tracking_links_subId_key" ON "tracking_links"("subId");
CREATE INDEX "tracking_links_assignmentId_status_idx" ON "tracking_links"("assignmentId", "status");
CREATE INDEX "tracking_links_campaignSourceId_idx" ON "tracking_links"("campaignSourceId");
CREATE INDEX "tracking_links_deletedAt_idx" ON "tracking_links"("deletedAt");

CREATE INDEX "client_coupon_assignments_assignmentId_status_idx"
  ON "client_coupon_assignments"("assignmentId", "status");
CREATE INDEX "client_coupon_assignments_supplierCouponId_idx"
  ON "client_coupon_assignments"("supplierCouponId");

CREATE UNIQUE INDEX "client_commission_rules_assignmentId_effectiveFrom_key"
  ON "client_commission_rules"("assignmentId", "effectiveFrom");
CREATE INDEX "client_commission_rules_assignmentId_status_idx"
  ON "client_commission_rules"("assignmentId", "status");
CREATE INDEX "client_commission_rules_assignmentId_effectiveFrom_idx"
  ON "client_commission_rules"("assignmentId", "effectiveFrom");

ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "client_campaign_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_campaignSourceId_fkey"
  FOREIGN KEY ("campaignSourceId") REFERENCES "campaign_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "client_coupon_assignments" ADD CONSTRAINT "client_coupon_assignments_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "client_campaign_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "client_coupon_assignments" ADD CONSTRAINT "client_coupon_assignments_supplierCouponId_fkey"
  FOREIGN KEY ("supplierCouponId") REFERENCES "supplier_coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "client_commission_rules" ADD CONSTRAINT "client_commission_rules_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "client_campaign_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
