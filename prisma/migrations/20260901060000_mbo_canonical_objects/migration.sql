-- Pointer 8: normalize legacy informal mboTargetObject labels to canonical taxonomy.

UPDATE "MappingRegistryRule" SET "mboTargetObject" = 'OrderConversion' WHERE "mboTargetObject" IN ('Order', 'Conversion');
UPDATE "MappingRegistryRule" SET "mboTargetObject" = 'SupplierCommissionRule' WHERE "mboTargetObject" = 'Commission';
UPDATE "MappingRegistryRule" SET "mboTargetObject" = 'ClientCampaignAssignment' WHERE "mboTargetObject" = 'Attribution';
UPDATE "MappingRegistryRule" SET "mboTargetObject" = 'CouponVoucher' WHERE "mboTargetObject" IN ('Coupon', 'Voucher');
UPDATE "MappingRegistryRule" SET "mboTargetObject" = 'TrackingLink' WHERE "mboTargetObject" IN ('Tracking', 'Link');
UPDATE "MappingRegistryRule" SET "mboTargetObject" = 'PerformanceRecord' WHERE "mboTargetObject" = 'Performance';
UPDATE "MappingRegistryRule" SET "mboTargetObject" = 'NetworkPayment' WHERE "mboTargetObject" = 'Payment';
UPDATE "MappingRegistryRule" SET "mboTargetObject" = 'NetworkInvoiceBilling' WHERE "mboTargetObject" IN ('Invoice', 'Billing');
UPDATE "MappingRegistryRule" SET "mboTargetObject" = 'NetworkCampaign' WHERE "mboTargetObject" = 'Campaign';
UPDATE "MappingRegistryRule" SET "mboTargetObject" = 'Exception' WHERE "mboTargetObject" IN ('Entity', 'Assets', 'Asset');

CREATE INDEX IF NOT EXISTS "MappingRegistryRule_mboTargetObject_idx"
  ON "MappingRegistryRule"("mboTargetObject");
