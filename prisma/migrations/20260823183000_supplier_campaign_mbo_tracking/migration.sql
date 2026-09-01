-- Pre-provision brand-level MBO tracking links when supplier campaigns sync.
ALTER TABLE "supplier_campaigns"
  ADD COLUMN IF NOT EXISTS "mboTrackingSlug" TEXT,
  ADD COLUMN IF NOT EXISTS "mboTrackingToken" TEXT,
  ADD COLUMN IF NOT EXISTS "mboTrackingUrl" TEXT;
