-- ProductTrackingLink ACTIVE uniqueness is a PostgreSQL partial unique index.
-- Prisma 5.22 cannot represent the WHERE predicate in schema.prisma.
-- Production may already contain this index from the verified concurrent
-- installation performed before this recording migration.
-- Keep IF NOT EXISTS so fresh/local/CI databases create it and production
-- remains idempotent if this migration is ever intentionally reconciled later.

CREATE UNIQUE INDEX IF NOT EXISTS
  "product_tracking_links_clientId_productId_active_key"
ON "product_tracking_links" ("clientId", "productId")
WHERE "status" = 'ACTIVE';
