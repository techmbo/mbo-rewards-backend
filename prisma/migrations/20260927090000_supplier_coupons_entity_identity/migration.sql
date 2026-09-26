-- SupplierCoupon identity: one row per staged Entity (SupplierCoupon.entityId @unique).
--
-- The application resolves an existing coupon by entityId first and uses the
-- (parent, couponType, couponCode | couponLink) natural key only to adopt legacy rows that no
-- entity owns (src/modules/supplier/services/supplierCouponPromotion.service.js). Production data
-- proved the two partial unique indexes from 20260710140000_wave1_supplier_foundation encode a
-- false invariant: distinct supplier offers legitimately share one couponLink (Awin code-less
-- promotions carry the advertiser's generic tracking link) or one couponCode. They are retired
-- here and must never be recreated. Both DROPs are IF EXISTS because production never had them;
-- fresh, local and CI databases built from this history do.
DROP INDEX IF EXISTS "supplier_coupons_campaign_code_unique";
DROP INDEX IF EXISTS "supplier_coupons_campaign_link_unique";

-- Exactly the index `prisma migrate diff` generates for entityId @unique, under its default name.
-- PostgreSQL UNIQUE treats NULLs as distinct, so rows whose Entity was deleted (onDelete: SetNull)
-- are unconstrained; no partial predicate is needed. IF NOT EXISTS: production received this
-- index by a verified online (non-blocking) build before this file is applied there, so the
-- statement is a no-op where it already exists. Plain CREATE INDEX only: Prisma runs a migration
-- inside one transaction, and a non-blocking index build cannot run in a transaction block.
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_coupons_entityId_key" ON "supplier_coupons"("entityId");
