-- Align migration-history expectations for performance-only objects with the intended
-- production state.
--
-- Production was rebuilt from schema.prisma and never received the twelve performance
-- indexes below nor the pg_trgm extension. None of them is required by a current runtime
-- access path. This migration makes a database built from full history end in the same
-- state as production. On production every statement is a no-op (IF EXISTS on absent
-- objects). On fresh, local and CI databases the historical migrations create these objects
-- and this migration intentionally removes them.
--
-- Plain DROP ... IF EXISTS statements only: no online-build clause, no cascading drop, no CREATE,
-- no ALTER, no DML.

-- ---------------------------------------------------------------------------------------
-- PERMANENTLY RETIRED / currently unnecessary (8)
-- ---------------------------------------------------------------------------------------
-- Redundant with current schema.prisma indexes: SupplierCampaign declares
-- @@index([supplier, campaignStatus]) and @@index([lastSyncedAt(sort: Desc)]), and no query
-- filters or sorts on lastSyncedAt in a way that needs the three-column composite.
DROP INDEX IF EXISTS "supplier_campaigns_supplier_campaignStatus_lastSyncedAt_idx";
-- No current filter, sort, job or raw SQL reads couponEndDate; it is only selected and mapped.
DROP INDEX IF EXISTS "supplier_coupons_couponEndDate_idx";
-- Alias lookups use the unique (aliasValue, supplier) pair or normalizedAlias equality, both
-- covered by current btree indexes; no substring search runs on aliasValue.
DROP INDEX IF EXISTS "merchant_aliases_aliasValue_trgm_idx";
-- normalizedName equality lookups use the unique btree; the two substring searches on it are
-- always paired with a displayName search on the same row.
DROP INDEX IF EXISTS "merchants_normalizedName_trgm_idx";
-- clients.name substring search exists but the current access paths (client list, global
-- search, admin reporting filter) run against the tenant list without a trigram index; no
-- measured need has been recorded.
DROP INDEX IF EXISTS "clients_name_trgm_idx";
-- Every click and conversion query is a date-range filter plus ORDER BY on the same column,
-- which the current btree indexes clicks_clickedAt_idx, conversions_conversionDate_idx and
-- their composite indexes already serve; BRIN cannot serve the ORDER BY.
DROP INDEX IF EXISTS "clicks_clickedAt_brin_idx";
DROP INDEX IF EXISTS "conversions_conversionDate_brin_idx";
-- No query reads conversions by clickId and no current code path deletes clicks, so the FK
-- ON DELETE SET NULL never scans conversions. If a click purge or retention path is ever
-- introduced, add @@index([clickId]) to Conversion (and Order) in schema.prisma first.
DROP INDEX IF EXISTS "conversions_clickId_idx";

-- ---------------------------------------------------------------------------------------
-- DEFERRED PENDING MEASUREMENT (4) — not obsolete
-- ---------------------------------------------------------------------------------------
-- These back real ILIKE '%term%' search paths: the admin campaign list, brand search, global
-- search and the client portal campaign search. The current intended production state is
-- ABSENT because production has served those paths without them since the rebuild and no
-- runtime measurement has shown a need. A future forward migration may run
--   CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- and recreate only the indexes justified by measured evidence such as table growth,
-- observed search latency, EXPLAIN / EXPLAIN ANALYZE plans, and pg_stat_statements where
-- available.
DROP INDEX IF EXISTS "supplier_campaigns_campaignName_trgm_idx";
DROP INDEX IF EXISTS "supplier_campaigns_merchantNameRaw_trgm_idx";
DROP INDEX IF EXISTS "merchants_displayName_trgm_idx";
DROP INDEX IF EXISTS "canonical_campaigns_displayName_trgm_idx";

-- ---------------------------------------------------------------------------------------
-- Extension expectation from 20260710153000_wave1_1_performance_indexes
-- ---------------------------------------------------------------------------------------
-- Last, and only because every gin_trgm_ops index in history has been dropped above in this
-- same migration: retire the pg_trgm expectation. Deliberately without a cascading drop, so an
-- unexpected dependent would fail this migration rather than be removed silently.
DROP EXTENSION IF EXISTS pg_trgm;
