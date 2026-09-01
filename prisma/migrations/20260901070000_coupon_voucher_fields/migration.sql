ALTER TABLE "supplier_coupons" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "supplier_coupons" ADD COLUMN IF NOT EXISTS "promotionDescription" TEXT;
ALTER TABLE "supplier_coupons" ADD COLUMN IF NOT EXISTS "discountType" TEXT;
ALTER TABLE "supplier_coupons" ADD COLUMN IF NOT EXISTS "customerType" TEXT;
ALTER TABLE "supplier_coupons" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "supplier_coupons" ADD COLUMN IF NOT EXISTS "networkSource" TEXT;
ALTER TABLE "supplier_coupons" ADD COLUMN IF NOT EXISTS "sourceObject" TEXT;
ALTER TABLE "supplier_coupons" ADD COLUMN IF NOT EXISTS "sourcePath" TEXT;
ALTER TABLE "supplier_coupons" ADD COLUMN IF NOT EXISTS "mappingStatus" TEXT;
ALTER TABLE "supplier_coupons" ADD COLUMN IF NOT EXISTS "fieldMappingOutcome" TEXT;
ALTER TABLE "supplier_coupons" ADD COLUMN IF NOT EXISTS "mappingVersion" TEXT;

CREATE INDEX IF NOT EXISTS "supplier_coupons_networkSource_idx"
  ON "supplier_coupons"("networkSource");
CREATE INDEX IF NOT EXISTS "supplier_coupons_sourceObject_idx"
  ON "supplier_coupons"("sourceObject");
CREATE INDEX IF NOT EXISTS "supplier_coupons_supplierCouponId_idx"
  ON "supplier_coupons"("supplierCouponId");
