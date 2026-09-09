/**
 * TEMPORARY — Preview-only, READ-ONLY Optimise persisted-identifier audit.
 *
 * REMOVE THIS FILE AND ITS ROUTE REGISTRATION once the identifier audit has
 * been captured. It exists because the production database is reachable only
 * from inside the Vercel runtime, and the audit must read the ACTUAL rows the
 * Preview runtime is connected to rather than a guess at which database that is.
 *
 * Guarantees:
 *   - Gated exactly like optimiseCertificationPreview.js: serves ONLY when
 *     VERCEL_ENV === "preview" AND the x-certification-token header matches
 *     CERTIFICATION_TOKEN in constant time. Unconfigured, missing and wrong
 *     tokens are all the same 404. The token is never logged or echoed.
 *   - The database layer is loaded lazily, AFTER both gates pass. A rejected
 *     request never touches Prisma.
 *   - READ ONLY. Every statement is a module constant beginning with SELECT or
 *     WITH, contains no data-modifying keyword, and is re-checked by
 *     assertReadOnlySql immediately before execution. No Prisma model method
 *     is called. Nothing is written, migrated or persisted.
 *   - No supplier API call of any kind. This is database only.
 *   - The response is an ALLOWLIST projection: aggregate counts plus identifier
 *     columns only. Raw payloads, tracking URLs, credentials and connection
 *     details are never selected, and database errors are replaced with a
 *     generic message so a driver error cannot echo the connection string.
 *
 * Identifier semantics mirror src/modules/supplier/optimiseCampaignIdentifiers.js:
 * a raw identifier is "present" when it is a non-empty trimmed string, and the
 * campaignId namespace falls back from rawPayload.campaignId to
 * rawPayload.campaign_id. A disagreement is counted ONLY when both values are
 * present and differ — a missing value is never a conflict (no IS DISTINCT FROM).
 */

import {
  CERTIFICATION_TOKEN_HEADER,
  isPreviewRuntime,
  tokenMatches,
} from "./optimiseCertificationPreview.js";

/** Temporary route path, mounted under the app's /api prefix. */
export const PREVIEW_IDENTIFIER_AUDIT_ROUTE = "/internal/certification/optimise-identifiers";

export const AUDITED_SUPPLIER = "OPTIMISE";
export const SAMPLE_ROW_LIMIT = 25;

/** The identifiers proven live by the corrected certification run. */
export const LIVE_CERTIFIED_PRODUCT_ID = "57316";
export const LIVE_CERTIFIED_CAMPAIGN_ID = "7340528";

/** The only per-row fields that can ever leave the runtime. */
export const IDENTIFIER_ROW_FIELDS = Object.freeze([
  "supplierCampaignId",
  "supplierRegion",
  "sourceAccountLabel",
  "raw_id",
  "raw_campaign_id",
  "raw_product_id",
]);

// ---------------------------------------------------------------------------
// Read-only SQL guard
// ---------------------------------------------------------------------------

const READ_ONLY_PREFIX = /^\s*(?:WITH|SELECT)\b/i;
const FORBIDDEN_SQL_KEYWORD =
  /\b(?:INSERT|UPDATE|DELETE|UPSERT|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|EXECUTE|SET|LOCK|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|COMMENT|DO|INTO|RETURNING|EXPLAIN)\b/i;

/**
 * Refuse anything that is not a single SELECT/CTE statement.
 * Applied to every statement at execution time, not only in tests.
 */
export function assertReadOnlySql(sql) {
  if (typeof sql !== "string" || !READ_ONLY_PREFIX.test(sql)) {
    throw new Error("Audit SQL must be a single statement beginning with SELECT or WITH.");
  }
  if (sql.includes(";")) {
    throw new Error("Audit SQL must be a single statement.");
  }
  if (sql.includes("--") || sql.includes("/*")) {
    throw new Error("Audit SQL must not contain comments.");
  }
  const forbidden = sql.match(FORBIDDEN_SQL_KEYWORD);
  if (forbidden) {
    throw new Error(`Audit SQL contains forbidden keyword ${forbidden[0].toUpperCase()}.`);
  }
  return sql;
}

// ---------------------------------------------------------------------------
// Audit statements (module constants — never built from request input)
// ---------------------------------------------------------------------------

/** Optimise campaign rows with each identifier namespace normalized to text-or-NULL. */
const OPTIMISE_ROWS_CTE = `WITH oc AS (
  SELECT
    sc.id AS row_id,
    sc."supplierCampaignId" AS scid,
    sc."supplierRegion"::text AS region,
    sc."sourceAccountLabel" AS account_label,
    NULLIF(btrim(sc."rawPayload"->>'id'), '') AS raw_id,
    COALESCE(
      NULLIF(btrim(sc."rawPayload"->>'campaignId'), ''),
      NULLIF(btrim(sc."rawPayload"->>'campaign_id'), '')
    ) AS raw_campaign_id,
    NULLIF(btrim(sc."rawPayload"->>'productId'), '') AS raw_product_id
  FROM supplier_campaigns sc
  WHERE sc.supplier::text = '${AUDITED_SUPPLIER}'
)`;

/** Both values present AND different. A missing value is never a conflict. */
const NAMESPACES_DISAGREE = `(
     (raw_id IS NOT NULL AND raw_campaign_id IS NOT NULL AND raw_id <> raw_campaign_id)
  OR (raw_id IS NOT NULL AND raw_product_id IS NOT NULL AND raw_id <> raw_product_id)
  OR (raw_campaign_id IS NOT NULL AND raw_product_id IS NOT NULL AND raw_campaign_id <> raw_product_id)
)`;

const ANY_IDENTIFIER_MISSING = `(raw_id IS NULL OR raw_campaign_id IS NULL OR raw_product_id IS NULL)`;

const IDENTIFIER_ROW_PROJECTION = `scid AS "supplierCampaignId",
  region AS "supplierRegion",
  account_label AS "sourceAccountLabel",
  raw_id,
  raw_campaign_id,
  raw_product_id`;

const LIVE_CERTIFIED_LIST = `('${LIVE_CERTIFIED_PRODUCT_ID}', '${LIVE_CERTIFIED_CAMPAIGN_ID}')`;

export const AUDIT_SQL = Object.freeze({
  supplierCampaignsPresent: `SELECT (to_regclass('public.supplier_campaigns') IS NOT NULL) AS present`,

  overallCounts: `${OPTIMISE_ROWS_CTE}
SELECT
  count(*)::int AS total_rows,
  (count(*) FILTER (WHERE raw_id IS NOT NULL))::int AS raw_id_present,
  (count(*) FILTER (WHERE raw_campaign_id IS NOT NULL))::int AS raw_campaign_id_present,
  (count(*) FILTER (WHERE raw_product_id IS NOT NULL))::int AS raw_product_id_present,
  (count(*) FILTER (WHERE raw_id IS NOT NULL AND raw_campaign_id IS NOT NULL AND raw_product_id IS NOT NULL))::int AS all_three_present,
  (count(*) FILTER (WHERE raw_campaign_id IS NULL))::int AS raw_campaign_id_missing,
  (count(*) FILTER (WHERE raw_product_id IS NULL))::int AS raw_product_id_missing
FROM oc`,

  namespaceDisagreements: `${OPTIMISE_ROWS_CTE}
SELECT
  (count(*) FILTER (WHERE raw_id IS NOT NULL AND raw_campaign_id IS NOT NULL))::int AS id_campaign_id_both_present,
  (count(*) FILTER (WHERE raw_id IS NOT NULL AND raw_campaign_id IS NOT NULL AND raw_id <> raw_campaign_id))::int AS id_campaign_id_differ,
  (count(*) FILTER (WHERE raw_id IS NOT NULL AND raw_product_id IS NOT NULL))::int AS id_product_id_both_present,
  (count(*) FILTER (WHERE raw_id IS NOT NULL AND raw_product_id IS NOT NULL AND raw_id <> raw_product_id))::int AS id_product_id_differ,
  (count(*) FILTER (WHERE raw_campaign_id IS NOT NULL AND raw_product_id IS NOT NULL))::int AS campaign_id_product_id_both_present,
  (count(*) FILTER (WHERE raw_campaign_id IS NOT NULL AND raw_product_id IS NOT NULL AND raw_campaign_id <> raw_product_id))::int AS campaign_id_product_id_differ
FROM oc`,

  supplierCampaignIdLineage: `${OPTIMISE_ROWS_CTE}
SELECT
  (count(*) FILTER (WHERE raw_id IS NOT NULL AND scid = raw_id))::int AS id_matches,
  (count(*) FILTER (WHERE raw_id IS NOT NULL AND scid <> raw_id))::int AS id_differs,
  (count(*) FILTER (WHERE raw_id IS NULL))::int AS id_raw_missing,
  (count(*) FILTER (WHERE raw_campaign_id IS NOT NULL AND scid = raw_campaign_id))::int AS campaign_id_matches,
  (count(*) FILTER (WHERE raw_campaign_id IS NOT NULL AND scid <> raw_campaign_id))::int AS campaign_id_differs,
  (count(*) FILTER (WHERE raw_campaign_id IS NULL))::int AS campaign_id_raw_missing,
  (count(*) FILTER (WHERE raw_product_id IS NOT NULL AND scid = raw_product_id))::int AS product_id_matches,
  (count(*) FILTER (WHERE raw_product_id IS NOT NULL AND scid <> raw_product_id))::int AS product_id_differs,
  (count(*) FILTER (WHERE raw_product_id IS NULL))::int AS product_id_raw_missing
FROM oc`,

  sampleRows: `${OPTIMISE_ROWS_CTE}
SELECT
  ${IDENTIFIER_ROW_PROJECTION}
FROM oc
ORDER BY
  CASE
    WHEN ${NAMESPACES_DISAGREE} THEN 0
    WHEN ${ANY_IDENTIFIER_MISSING} THEN 1
    ELSE 2
  END,
  region, account_label, scid
LIMIT ${SAMPLE_ROW_LIMIT}`,

  liveCertifiedRows: `${OPTIMISE_ROWS_CTE}
SELECT
  ${IDENTIFIER_ROW_PROJECTION}
FROM oc
WHERE scid IN ${LIVE_CERTIFIED_LIST}
   OR raw_id IN ${LIVE_CERTIFIED_LIST}
   OR raw_campaign_id IN ${LIVE_CERTIFIED_LIST}
   OR raw_product_id IN ${LIVE_CERTIFIED_LIST}
ORDER BY region, account_label, scid`,

  supplierCommissionRulesPresent: `SELECT (to_regclass('public.supplier_commission_rules') IS NOT NULL) AS present`,

  commissionRuleLinkage: `${OPTIMISE_ROWS_CTE},
rules AS (
  SELECT r.id AS rule_id, r."supplierCampaignId" AS campaign_row_id
  FROM supplier_commission_rules r
  WHERE r.supplier::text = '${AUDITED_SUPPLIER}'
),
linked AS (
  SELECT rules.rule_id, oc.scid, oc.raw_campaign_id, oc.raw_product_id
  FROM rules
  JOIN oc ON oc.row_id = rules.campaign_row_id
)
SELECT
  (SELECT count(*) FROM rules)::int AS total_rules,
  (SELECT count(*) FROM rules WHERE campaign_row_id IS NULL)::int AS unlinked_rules,
  (SELECT count(*) FROM linked)::int AS rules_linked_to_optimise_campaigns,
  (SELECT count(*) FROM linked WHERE raw_campaign_id IS NOT NULL AND scid <> raw_campaign_id)::int AS linked_scid_differs_from_raw_campaign_id,
  (SELECT count(*) FROM linked WHERE raw_product_id IS NOT NULL AND scid <> raw_product_id)::int AS linked_scid_differs_from_raw_product_id`,
});

// Fail at module load if any constant is not read-only. Tests assert the same.
for (const sql of Object.values(AUDIT_SQL)) assertReadOnlySql(sql);

// ---------------------------------------------------------------------------
// Output projection (allowlist)
// ---------------------------------------------------------------------------

function toCount(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value); // count(*)::int arrives as a number; Number(BigInt) covers uncast counts
  return Number.isFinite(number) ? number : null;
}

function toBoolean(value) {
  return value === true;
}

function firstRow(rows) {
  return Array.isArray(rows) && rows.length > 0 && rows[0] && typeof rows[0] === "object" ? rows[0] : {};
}

/** Exactly the six identifier columns, each coerced to string-or-null. Nothing else survives. */
export function projectIdentifierRow(row) {
  const projected = {};
  for (const field of IDENTIFIER_ROW_FIELDS) {
    const value = row?.[field];
    projected[field] = value === undefined || value === null ? null : String(value);
  }
  return projected;
}

function projectIdentifierRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(projectIdentifierRow);
}

/** Uniform "this route does not exist" reply. Never distinguishes why. */
function notFound(res) {
  return res.status(404).json({ ok: false, message: "Not found." });
}

async function loadDefaultDependencies() {
  // Loaded only after both gates pass. The client is the app's shared instance;
  // no model method is used — a single raw read-only executor is exposed.
  const { prisma } = await import("../../database/prisma.js");
  return {
    // $queryRawUnsafe is "unsafe" only with respect to interpolation, and the
    // statements handed to it are module constants that never contain request
    // input. Each one has already passed assertReadOnlySql.
    query: (sql) => prisma.$queryRawUnsafe(sql),
  };
}

/**
 * Build the handler. The executor is injectable so the gate, the projection
 * and the statement set can be tested without a database or a Vercel runtime.
 */
export function createOptimiseIdentifierAuditPreviewHandler({
  env = process.env,
  loadDependencies = loadDefaultDependencies,
} = {}) {
  return async function optimiseIdentifierAuditPreviewHandler(req, res, next) {
    // Gate 1: preview runtime only.
    if (!isPreviewRuntime(env)) return notFound(res);

    // Gate 2: a configured token, and a matching header. A missing token, a
    // missing header and a wrong header are all indistinguishable from the
    // route not existing.
    const expectedToken = env.CERTIFICATION_TOKEN;
    if (typeof expectedToken !== "string" || expectedToken.length === 0) return notFound(res);
    const providedToken = req?.headers?.[CERTIFICATION_TOKEN_HEADER];
    if (!tokenMatches(typeof providedToken === "string" ? providedToken : "", expectedToken)) {
      return notFound(res);
    }

    let statementsExecuted = 0;

    try {
      const { query } = await loadDependencies();

      const run = async (sql) => {
        assertReadOnlySql(sql);
        statementsExecuted += 1;
        return query(sql);
      };

      const meta = {
        generatedAt: new Date().toISOString(),
        supplier: AUDITED_SUPPLIER,
        readOnly: true,
        writesPerformed: 0,
        supplierApiCalls: 0,
        sampleRowLimit: SAMPLE_ROW_LIMIT,
        campaignIdSources: ["rawPayload.campaignId", "rawPayload.campaign_id"],
        disagreementSemantics: "counted only when both values are present and differ",
      };

      // The audit is meaningless against a database that does not carry the
      // MBO schema, so say so explicitly instead of failing on the first CTE.
      const supplierCampaignsPresent = toBoolean(firstRow(await run(AUDIT_SQL.supplierCampaignsPresent)).present);
      if (!supplierCampaignsPresent) {
        return res.json({
          ok: true,
          meta: { ...meta, statementsExecuted, supplierCampaignsPresent: false },
          supplierCampaignsPresent: false,
          message: "supplier_campaigns does not exist in the connected database.",
        });
      }

      const counts = firstRow(await run(AUDIT_SQL.overallCounts));
      const disagreements = firstRow(await run(AUDIT_SQL.namespaceDisagreements));
      const lineage = firstRow(await run(AUDIT_SQL.supplierCampaignIdLineage));
      const sampleRows = projectIdentifierRows(await run(AUDIT_SQL.sampleRows));
      const liveCertifiedRows = projectIdentifierRows(await run(AUDIT_SQL.liveCertifiedRows));

      const supplierCommissionRulesPresent = toBoolean(
        firstRow(await run(AUDIT_SQL.supplierCommissionRulesPresent)).present,
      );
      let commissionRuleLinkage = { supplierCommissionRulesPresent: false };
      if (supplierCommissionRulesPresent) {
        const linkage = firstRow(await run(AUDIT_SQL.commissionRuleLinkage));
        commissionRuleLinkage = {
          supplierCommissionRulesPresent: true,
          totalRules: toCount(linkage.total_rules),
          unlinkedRules: toCount(linkage.unlinked_rules),
          rulesLinkedToOptimiseCampaigns: toCount(linkage.rules_linked_to_optimise_campaigns),
          linkedSupplierCampaignIdDiffersFromRawCampaignId: toCount(linkage.linked_scid_differs_from_raw_campaign_id),
          linkedSupplierCampaignIdDiffersFromRawProductId: toCount(linkage.linked_scid_differs_from_raw_product_id),
        };
      }

      return res.json({
        ok: true,
        meta: { ...meta, statementsExecuted, supplierCampaignsPresent: true },
        overallCounts: {
          totalRows: toCount(counts.total_rows),
          rawIdPresent: toCount(counts.raw_id_present),
          rawCampaignIdPresent: toCount(counts.raw_campaign_id_present),
          rawProductIdPresent: toCount(counts.raw_product_id_present),
          allThreePresent: toCount(counts.all_three_present),
          rawCampaignIdMissing: toCount(counts.raw_campaign_id_missing),
          rawProductIdMissing: toCount(counts.raw_product_id_missing),
        },
        namespaceDisagreements: {
          idVsCampaignId: {
            bothPresent: toCount(disagreements.id_campaign_id_both_present),
            differ: toCount(disagreements.id_campaign_id_differ),
          },
          idVsProductId: {
            bothPresent: toCount(disagreements.id_product_id_both_present),
            differ: toCount(disagreements.id_product_id_differ),
          },
          campaignIdVsProductId: {
            bothPresent: toCount(disagreements.campaign_id_product_id_both_present),
            differ: toCount(disagreements.campaign_id_product_id_differ),
          },
        },
        supplierCampaignIdLineage: {
          id: {
            matches: toCount(lineage.id_matches),
            differs: toCount(lineage.id_differs),
            rawMissing: toCount(lineage.id_raw_missing),
          },
          campaignId: {
            matches: toCount(lineage.campaign_id_matches),
            differs: toCount(lineage.campaign_id_differs),
            rawMissing: toCount(lineage.campaign_id_raw_missing),
          },
          productId: {
            matches: toCount(lineage.product_id_matches),
            differs: toCount(lineage.product_id_differs),
            rawMissing: toCount(lineage.product_id_raw_missing),
          },
        },
        sampleRows,
        liveCertifiedIdentifiers: {
          productId: LIVE_CERTIFIED_PRODUCT_ID,
          campaignId: LIVE_CERTIFIED_CAMPAIGN_ID,
          rows: liveCertifiedRows,
        },
        commissionRuleLinkage,
      });
    } catch (error) {
      // The app error handler echoes err.message to the client. A driver error
      // can name the database host, so only a generic message and the driver's
      // error CODE (e.g. P1001) are allowed through. The original is dropped.
      const safe = new Error(`Identifier audit failed (${error?.name ?? "Error"}).`);
      safe.statusCode = 500;
      if (typeof error?.code === "string" && /^[A-Z0-9_]{1,16}$/.test(error.code)) safe.code = error.code;
      return next(safe);
    }
  };
}

export const optimiseIdentifierAuditPreviewHandler = createOptimiseIdentifierAuditPreviewHandler();
