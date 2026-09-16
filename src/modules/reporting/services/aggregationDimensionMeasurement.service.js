/**
 * TEMPORARY — Phase 6a-ter risk assessment. Delete after the measurement is taken.
 *
 * Measures, per day of the post-sync rebuild window, how many DailyReport dimension buckets the
 * aggregation would produce, and what that costs inside one day's transaction under commit
 * 048a2ee. Read-only by construction and by the database's own enforcement:
 *
 *   - one SELECT, sent as a parameterised statement; the only inputs are two dates derived here
 *     from the clock exactly as maybePromoteAfterSync derives them — nothing from a request.
 *   - it runs inside a transaction whose first statement is SET TRANSACTION READ ONLY, so Postgres
 *     itself refuses any write for the rest of the transaction, whatever the code does.
 *   - SET LOCAL statement_timeout bounds the statement; the Prisma transaction timeout bounds the
 *     whole call. Both are transaction-scoped and leave no setting behind on the pooled connection.
 *   - the result is fifteen rows of integers. Every field is whitelisted and coerced to Number
 *     before it leaves this module; an identifier, a name or an amount has no path out.
 *
 * The semantics mirror AggregationService exactly (see aggregation.service.js):
 *   clicks      : clickedAt inside the UTC day, whose ClientCampaignAssignment and its
 *                 CanonicalCampaign (with merchantId) resolve                  (#accumulateClicks)
 *   conversions : conversionDate inside the UTC day, attributionStatus ATTRIBUTED,
 *                 clientAssignmentId not null, same resolution;
 *                 country = metadata->>'country'                               (#accumulateConversions)
 *   bucket key  : clientId | merchantId | canonicalCampaignId | campaignSourceId | country | day,
 *                 NULL campaignSourceId / country normalised to '' (dimensionKey's `?? ""`)
 *   per bucket  : one upsertDimension = findFirst + create, two queries.
 *
 * Validated against the real AggregationService on a shared fixture before this was written
 * (7 and 2 buckets on the two populated days, exact match).
 */

import { prisma as defaultPrisma } from "../../../database/prisma.js";
import { AGGREGATION_AFTER_SYNC_DAYS } from "../../../jobs/syncConfig.js";

export const MEASUREMENT_NAME = "phase-6a-ter-aggregation-dimension-buckets";

/** Bounds. Constants, never request-supplied: a SET value cannot be a bind parameter. */
export const STATEMENT_TIMEOUT_MS = 60_000;
export const TRANSACTION_TIMEOUT_MS = 90_000;
export const TRANSACTION_MAX_WAIT_MS = 10_000;

/** The exact guard statements, exported so a test can assert nothing else is ever executed. */
export const READ_ONLY_GUARD_SQL = "SET TRANSACTION READ ONLY";
export const STATEMENT_TIMEOUT_GUARD_SQL = `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`;

/** Bucket-count thresholds the report flags, for the A / B / C decision. */
export const BUCKET_THRESHOLDS = Object.freeze([300, 400, 500]);

/** Constants of the per-day transaction shape under commit 048a2ee. */
export const CLICK_PAGE_SIZE = 5_000;
export const ASSIGNMENT_LOOKUP_CHUNK = 1_000;

/**
 * The window maybePromoteAfterSync rebuilds: today (UTC) minus AGGREGATION_AFTER_SYNC_DAYS through
 * today, and the rebuild loop is inclusive, so a 14-day setting is fifteen calendar days.
 */
export function resolvePostSyncAggregationWindow(now = new Date(), daysBack = AGGREGATION_AFTER_SYNC_DAYS) {
  const to = new Date(now);
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - Math.max(1, daysBack));
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);
  const days = Math.round((Date.UTC(...isoParts(toIso)) - Date.UTC(...isoParts(fromIso))) / 86_400_000) + 1;
  return { from: fromIso, to: toIso, days };
}

function isoParts(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m - 1, d];
}

/** The per-day fields that may leave this module, and nothing else. All integers. */
const ROW_FIELDS = Object.freeze([
  "sourceClicks",
  "sourceConversions",
  "eligibleClicks",
  "eligibleConversions",
  "distinctAssignments",
  "distinctClients",
  "distinctMerchants",
  "distinctCampaigns",
  "distinctCampaignSources",
  "distinctCountries",
  "bucketsExact",
  "estimatedDailyReportUpserts",
  "estimatedTransactionQueries",
  "estimatedMsAt5msPerQuery",
  "estimatedMsAt10msPerQuery",
]);

/** Coerce one raw row to the whitelisted integer shape. Unknown columns are dropped. */
export function toSafeDayRow(raw = {}) {
  const day = typeof raw.day === "string" ? raw.day : raw.day instanceof Date ? raw.day.toISOString().slice(0, 10) : String(raw.day ?? "");
  const out = { day };
  for (const field of ROW_FIELDS) {
    const value = raw[field];
    out[field] = value === null || value === undefined ? 0 : Number(value);
  }
  return out;
}

/** Aggregate the per-day rows into what the decision needs. */
export function summariseMeasurement(days = []) {
  const buckets = days.map((d) => d.bucketsExact);
  const max = buckets.length ? Math.max(...buckets) : 0;
  const avg = buckets.length ? Math.round((buckets.reduce((a, b) => a + b, 0) / buckets.length) * 100) / 100 : 0;
  const worst = days.reduce((best, d) => (best == null || d.bucketsExact > best.bucketsExact ? d : best), null);
  const daysOver = {};
  for (const threshold of BUCKET_THRESHOLDS) {
    daysOver[String(threshold)] = days.filter((d) => d.bucketsExact > threshold).map((d) => d.day);
  }
  return {
    maxBucketsExact: max,
    averageBucketsExact: avg,
    worstDay: worst ? worst.day : null,
    worstDayEstimatedMsAt5msPerQuery: worst ? worst.estimatedMsAt5msPerQuery : 0,
    worstDayEstimatedMsAt10msPerQuery: worst ? worst.estimatedMsAt10msPerQuery : 0,
    daysOver,
  };
}

/**
 * Run the measurement. `client` is injectable for tests; production uses the runtime Prisma
 * client, which already holds the database connection — no URL is read or handled here.
 */
export async function measureAggregationDimensions({ client = defaultPrisma, now = new Date() } = {}) {
  const window = resolvePostSyncAggregationWindow(now);
  const from = window.from;
  const to = window.to;

  const rawRows = await client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = 60000`;
      return tx.$queryRaw`
        WITH params AS (
          SELECT ${from}::date AS from_day, ${to}::date AS to_day
        ),
        days AS (
          SELECT d::date AS day
          FROM params, generate_series(from_day, to_day, INTERVAL '1 day') AS g(d)
        ),
        raw_clicks AS (
          SELECT c."clickedAt"::date AS day
          FROM clicks c, params p
          WHERE c."clickedAt" >= p.from_day::timestamp
            AND c."clickedAt" <  (p.to_day + 1)::timestamp
        ),
        elig_clicks AS (
          SELECT c."clickedAt"::date                 AS day,
                 a.id                                AS assignment_id,
                 a."clientId"                        AS client_id,
                 cc."merchantId"                     AS merchant_id,
                 a."canonicalCampaignId"             AS campaign_id,
                 COALESCE(c."campaignSourceId", '')  AS source_key,
                 COALESCE(c.country, '')             AS country_key
          FROM clicks c
          JOIN client_campaign_assignments a ON a.id = c."clientAssignmentId"
          JOIN canonical_campaigns cc        ON cc.id = a."canonicalCampaignId"
          CROSS JOIN params p
          WHERE c."clickedAt" >= p.from_day::timestamp
            AND c."clickedAt" <  (p.to_day + 1)::timestamp
            AND cc."merchantId" IS NOT NULL
        ),
        raw_convs AS (
          SELECT v."conversionDate"::date AS day
          FROM conversions v, params p
          WHERE v."conversionDate" >= p.from_day::timestamp
            AND v."conversionDate" <  (p.to_day + 1)::timestamp
        ),
        elig_convs AS (
          SELECT v."conversionDate"::date              AS day,
                 a.id                                  AS assignment_id,
                 a."clientId"                          AS client_id,
                 cc."merchantId"                       AS merchant_id,
                 a."canonicalCampaignId"               AS campaign_id,
                 COALESCE(v."campaignSourceId", '')    AS source_key,
                 COALESCE(v.metadata->>'country', '')  AS country_key
          FROM conversions v
          JOIN client_campaign_assignments a ON a.id = v."clientAssignmentId"
          JOIN canonical_campaigns cc        ON cc.id = a."canonicalCampaignId"
          CROSS JOIN params p
          WHERE v."conversionDate" >= p.from_day::timestamp
            AND v."conversionDate" <  (p.to_day + 1)::timestamp
            AND v."attributionStatus" = 'ATTRIBUTED'
            AND v."clientAssignmentId" IS NOT NULL
            AND cc."merchantId" IS NOT NULL
        ),
        dims AS (
          SELECT day, assignment_id, client_id, merchant_id, campaign_id, source_key, country_key FROM elig_clicks
          UNION ALL
          SELECT day, assignment_id, client_id, merchant_id, campaign_id, source_key, country_key FROM elig_convs
        ),
        per_day AS (
          SELECT
            d.day,
            (SELECT COUNT(*)::int FROM raw_clicks  r WHERE r.day = d.day)                                   AS "sourceClicks",
            (SELECT COUNT(*)::int FROM raw_convs   r WHERE r.day = d.day)                                   AS "sourceConversions",
            (SELECT COUNT(*)::int FROM elig_clicks e WHERE e.day = d.day)                                   AS "eligibleClicks",
            (SELECT COUNT(*)::int FROM elig_convs  e WHERE e.day = d.day)                                   AS "eligibleConversions",
            (SELECT COUNT(DISTINCT assignment_id)::int FROM dims x WHERE x.day = d.day)                     AS "distinctAssignments",
            (SELECT COUNT(DISTINCT client_id)::int     FROM dims x WHERE x.day = d.day)                     AS "distinctClients",
            (SELECT COUNT(DISTINCT merchant_id)::int   FROM dims x WHERE x.day = d.day)                     AS "distinctMerchants",
            (SELECT COUNT(DISTINCT campaign_id)::int   FROM dims x WHERE x.day = d.day)                     AS "distinctCampaigns",
            (SELECT COUNT(DISTINCT source_key)::int    FROM dims x WHERE x.day = d.day)                     AS "distinctCampaignSources",
            (SELECT COUNT(DISTINCT country_key)::int   FROM dims x WHERE x.day = d.day)                     AS "distinctCountries",
            (SELECT COUNT(DISTINCT (client_id, merchant_id, campaign_id, source_key, country_key))::int
               FROM dims x WHERE x.day = d.day)                                                             AS "bucketsExact"
          FROM days d
        )
        SELECT
          to_char(day, 'YYYY-MM-DD')                                                                AS day,
          "sourceClicks", "sourceConversions", "eligibleClicks", "eligibleConversions",
          "distinctAssignments", "distinctClients", "distinctMerchants", "distinctCampaigns",
          "distinctCampaignSources", "distinctCountries", "bucketsExact",
          "bucketsExact"                                                                            AS "estimatedDailyReportUpserts",
          (2 * GREATEST(1, CEIL("eligibleClicks" / 5000.0))::int
             + CEIL("distinctAssignments" / 1000.0)::int
             + 1
             + 2 * "bucketsExact")                                                                  AS "estimatedTransactionQueries",
          (2 * GREATEST(1, CEIL("eligibleClicks" / 5000.0))::int
             + CEIL("distinctAssignments" / 1000.0)::int
             + 1
             + 2 * "bucketsExact") * 5                                                              AS "estimatedMsAt5msPerQuery",
          (2 * GREATEST(1, CEIL("eligibleClicks" / 5000.0))::int
             + CEIL("distinctAssignments" / 1000.0)::int
             + 1
             + 2 * "bucketsExact") * 10                                                             AS "estimatedMsAt10msPerQuery"
        FROM per_day
        ORDER BY day
      `;
    },
    { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: TRANSACTION_TIMEOUT_MS },
  );

  const days = (Array.isArray(rawRows) ? rawRows : []).map(toSafeDayRow);

  return {
    measurement: MEASUREMENT_NAME,
    readOnly: true,
    window,
    grain: ["clientId", "merchantId", "canonicalCampaignId", "campaignSourceId", "country", "day"],
    assumptions: {
      commit: "048a2ee",
      clickPageSize: CLICK_PAGE_SIZE,
      assignmentLookupChunk: ASSIGNMENT_LOOKUP_CHUNK,
      queriesPerBucket: 2,
      prismaTransactionTimeoutMsDefault: 5000,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      transactionTimeoutMs: TRANSACTION_TIMEOUT_MS,
      thresholds: [...BUCKET_THRESHOLDS],
    },
    days,
    summary: summariseMeasurement(days),
  };
}
