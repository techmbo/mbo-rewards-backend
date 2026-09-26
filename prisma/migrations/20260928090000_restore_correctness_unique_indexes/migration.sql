-- Restore the two correctness unique indexes that production never received.
--
-- Production was rebuilt from schema.prisma, and Prisma 5.22 cannot express a partial
-- predicate or a COALESCE expression, so these two indexes exist only as migration SQL.
-- Both were originally defined in 20260713120000_wave3_client_distribution and
-- 20260713140000_wave5_attribution_reporting; the definitions below have the same shape with
-- IF NOT EXISTS added.
--
-- Production receives each index separately, built online by an operator before this file is
-- ever considered there. This repository migration records the same final state with ordinary,
-- idempotent statements, so on production both statements become no-ops. Fresh, local and CI
-- databases built from this history get the indexes from this file.

-- One non-revoked assignment per client + catalog campaign. REVOKED rows are outside the
-- predicate on purpose: a client may be re-assigned after a revocation. The application's
-- read-then-create ALREADY_ASSIGNED check is not race-safe without this index.
CREATE UNIQUE INDEX IF NOT EXISTS "client_campaign_assignments_client_campaign_active_key"
  ON "client_campaign_assignments"("clientId", "canonicalCampaignId")
  WHERE "status" IN ('ASSIGNED', 'ACTIVE', 'PAUSED');

-- One daily_reports row per reporting dimension. NULL campaignSourceId and NULL country are
-- folded to '' so that "no source" and "no country" are single identities; a plain unique over
-- the nullable columns would treat every NULL as distinct and let duplicates through.
CREATE UNIQUE INDEX IF NOT EXISTS "daily_reports_dimension_key"
  ON "daily_reports"(
    "clientId",
    "canonicalCampaignId",
    COALESCE("campaignSourceId", ''),
    COALESCE("country", ''),
    "reportDate"
  );
