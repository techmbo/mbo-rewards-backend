-- Epic 9 Phase 1 — additive OrderItem validation (VAL-006)
-- Nullable: existing rows remain NULL (historical / no item-level decision).
-- No backfill. No drops. Reuses existing ValidationStatus enum.

ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "validationStatus" "ValidationStatus";
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "validationChangedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "order_items_validationStatus_idx" ON "order_items"("validationStatus");
