-- Wave 1.1 — performance indexes (additive, zero-downtime)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "supplier_campaigns_campaignName_trgm_idx"
  ON "supplier_campaigns" USING gin ("campaignName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "supplier_campaigns_merchantNameRaw_trgm_idx"
  ON "supplier_campaigns" USING gin ("merchantNameRaw" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "supplier_campaigns_supplier_campaignStatus_lastSyncedAt_idx"
  ON "supplier_campaigns" ("supplier", "campaignStatus", "lastSyncedAt" DESC);

CREATE INDEX IF NOT EXISTS "supplier_coupons_couponEndDate_idx"
  ON "supplier_coupons" ("couponEndDate");
