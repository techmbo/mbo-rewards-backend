-- Partnerize manual supplier tracking-link lifecycle.
-- Additive only: no column is dropped, renamed or backfilled destructively.
-- The link value itself continues to live in the existing canonical column
-- "supplier_campaigns"."trackingUrl". "destinationUrl" is the advertiser landing
-- page and is never the supplier tracking link.

CREATE TYPE "SupplierTrackingLinkState" AS ENUM (
  'TRACKING_LINK_NOT_GENERATED',
  'TRACKING_LINK_AVAILABLE',
  'TRACKING_LINK_NEEDS_REVIEW',
  'TRACKING_LINK_REVOKED'
);

CREATE TYPE "SupplierTrackingLinkProvenance" AS ENUM (
  'MANUAL_ADMIN',
  'SUPPLIER_API'
);

ALTER TABLE "supplier_campaigns"
  ADD COLUMN "supplierTrackingLinkState" "SupplierTrackingLinkState" NOT NULL DEFAULT 'TRACKING_LINK_NOT_GENERATED',
  ADD COLUMN "supplierTrackingLinkProvenance" "SupplierTrackingLinkProvenance",
  ADD COLUMN "supplierTrackingLinkUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "supplierTrackingLinkUpdatedBy" TEXT;

-- Existing rows that already carry a supplier tracking link are AVAILABLE.
-- Provenance is intentionally left NULL for these: they predate provenance tracking
-- and must not be mislabelled as MANUAL_ADMIN (which would make them sync-protected).
UPDATE "supplier_campaigns"
   SET "supplierTrackingLinkState" = 'TRACKING_LINK_AVAILABLE'
 WHERE "trackingUrl" IS NOT NULL
   AND btrim("trackingUrl") <> '';

CREATE INDEX "supplier_campaigns_supplier_supplierTrackingLinkState_idx"
  ON "supplier_campaigns"("supplier", "supplierTrackingLinkState");
