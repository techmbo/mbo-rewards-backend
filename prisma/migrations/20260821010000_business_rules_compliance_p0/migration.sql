-- Business rules compliance P0/P1:
-- Attribution REVIEW_REQUIRED, coupon RESERVED, client deliveryMethod.

-- AttributionStatus.REVIEW_REQUIRED
ALTER TYPE "AttributionStatus" ADD VALUE IF NOT EXISTS 'REVIEW_REQUIRED';

-- CouponAssignmentStatus.RESERVED
ALTER TYPE "CouponAssignmentStatus" ADD VALUE IF NOT EXISTS 'RESERVED';

-- ClientDeliveryMethod + Client.deliveryMethod
DO $$ BEGIN
  CREATE TYPE "ClientDeliveryMethod" AS ENUM ('PORTAL_ONLY', 'API_ONLY', 'API_AND_PORTAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "deliveryMethod" "ClientDeliveryMethod" NOT NULL DEFAULT 'API_AND_PORTAL';
