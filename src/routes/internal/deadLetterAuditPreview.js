/**
 * TEMPORARY — Preview-only, READ-ONLY dead-letter queue audit.
 *
 * REMOVE THIS FILE AND ITS ROUTE REGISTRATION once the DLQ evidence has been
 * captured. It exists because the production database is reachable only from
 * inside the Vercel runtime, and the existing GET /api/ops/jobs/dead-letter
 * returns complete JobRun rows (payload, result, correlationId, raw lastError)
 * that must not leave the runtime for this investigation.
 *
 * Guarantees:
 *   - Serves ONLY when VERCEL_ENV === "preview" AND the x-audit-token header
 *     matches DLQ_AUDIT_TOKEN in constant time. Missing token, wrong token,
 *     unconfigured token and non-preview runtime are all the same 404.
 *   - The database layer is loaded lazily, AFTER both gates. A rejected request
 *     never touches Prisma.
 *   - READ ONLY. The Prisma client is wrapped in a reader that exposes only
 *     jobRun.count / groupBy / findMany. No model write method exists in this
 *     module, no raw SQL is issued, no job is executed or enqueued, and no
 *     supplier client is imported. The request body is never read.
 *   - Output is an ALLOWLIST: aggregate counts plus a capped sample projected to
 *     id / jobName / status / attempt / maxAttempts / progress / timestamps and
 *     a derived error category. payload, result and correlationId are never
 *     selected from the database; lastError is selected only to be sanitized
 *     and classified server-side and is never returned raw. A final response
 *     guard refuses to serialize any of those keys.
 *   - Database errors are replaced with a generic message so a driver error
 *     cannot echo connection details through the app error handler.
 */

import crypto from "node:crypto";

/** Temporary route path, mounted under the app's /api prefix. */
export const PREVIEW_DLQ_AUDIT_ROUTE = "/internal/audit/dead-letter";
export const DLQ_AUDIT_TOKEN_HEADER = "x-audit-token";
export const DLQ_AUDIT_TOKEN_ENV = "DLQ_AUDIT_TOKEN";

export const SAMPLE_LIMIT = 20;
/** Upper bound on DEAD_LETTER rows whose lastError is read for classification. */
export const ERROR_SCAN_LIMIT = 1000;
export const MAX_EXAMPLE_LENGTH = 200;

export const JOB_STATUSES = Object.freeze(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "DEAD_LETTER"]);

/** Columns selected for the safe sample. lastError is internal-only (classified, then dropped). */
export const SAMPLE_SELECT = Object.freeze({
  id: true,
  jobName: true,
  status: true,
  attempt: true,
  maxAttempts: true,
  progress: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  lastError: true,
});

/** The only per-row fields that leave the runtime. */
export const SAMPLE_OUTPUT_FIELDS = Object.freeze([
  "id",
  "jobName",
  "status",
  "attempt",
  "maxAttempts",
  "progress",
  "createdAt",
  "startedAt",
  "completedAt",
]);

/** Keys that must never appear anywhere in the response body. */
export const FORBIDDEN_OUTPUT_KEYS = Object.freeze(["payload", "result", "correlationId", "lastError"]);

const SUPPLIER_NAME_PATTERN = /\b(optimise|boostiny|trackier|partnerize|impact|awin|admitad|cj|rakuten)\b/i;

// ---------------------------------------------------------------------------
// Gate (same properties as the temporary Optimise certification gate)
// ---------------------------------------------------------------------------

/** Preview runtime only. Production and development are indistinguishable from absent. */
export function isPreviewRuntime(env = process.env) {
  return env?.VERCEL_ENV === "preview";
}

/**
 * Constant-time token comparison over SHA-256 digests, so neither the token
 * value nor its length leaks through timing.
 */
export function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const providedDigest = crypto.createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

/** Uniform "this route does not exist" reply. Never distinguishes why. */
function notFound(res) {
  return res.status(404).json({ ok: false, message: "Not found." });
}

// ---------------------------------------------------------------------------
// lastError sanitization and classification (server-side only)
// ---------------------------------------------------------------------------

const SECRET_KEY_NAMES =
  "api[_-]?key|apikey|x-api-key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|credentials?|signature|sig";

/**
 * key=value / key: value / "key": "value" forms. A quoted value is consumed
 * whole, so a value containing whitespace ("Bearer a b") cannot leave a tail.
 */
const SECRET_KEY_PATTERN = new RegExp(`\\b(${SECRET_KEY_NAMES})\\b(["']?)(\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s"',;&)}\\]]+)`, "gi");

/**
 * Authorization / Proxy-Authorization in header, query-string or JSON form.
 * The key may be quoted; the value is consumed whole whether quoted (any
 * content up to the closing quote) or bare (optional scheme word plus token).
 */
const AUTHORIZATION_PATTERN =
  /\b((?:proxy-)?authorization)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?:(?:basic|bearer|apikey|api-key|token|digest|hmac|negotiate|ntlm|aws4-hmac-sha256)\s+)?[^\s,;"'}\]]+)/gi;

/** Whole database / broker connection strings are redacted, host included. */
const CONNECTION_STRING_PATTERN = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver|libsql):\/\/[^\s"'<>]+/gi;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Redact anything credential-shaped from a free-text error message. Applied
 * before any classification and before anything derived from lastError can be
 * returned. Order matters: structured secrets first, then URLs, then blobs.
 */
export function sanitizeErrorText(value) {
  if (value === undefined || value === null) return "";
  let text = String(value);

  text = text.replace(AUTHORIZATION_PATTERN, "$1=[REDACTED]");
  text = text.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]*)?/g, "[REDACTED_JWT]");
  text = text.replace(SECRET_KEY_PATTERN, "$1$2$3[REDACTED]");
  // Database / broker connection strings: the whole thing goes, host included.
  text = text.replace(CONNECTION_STRING_PATTERN, "[REDACTED_CONNECTION_STRING]");
  // Credentials embedded in any remaining URL: scheme://user:pass@host
  text = text.replace(/:\/\/[^\s/@"']+@/g, "://[REDACTED]@");
  // Query strings carry tokens and signatures: keep the path, drop the query.
  text = text.replace(/\?[^\s"'<>]*/g, "?[REDACTED_QUERY]");
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]");
  // Long opaque tokens / keys / signatures that survived the structured rules.
  // Path segments (no slash in the class) and plain UUIDs are kept: they carry
  // classification signal and are identifiers, not credentials.
  text = text.replace(/\b[A-Za-z0-9+_=-]{32,}\b/g, (match) => (UUID_PATTERN.test(match) ? match : "[REDACTED_BLOB]"));
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

/** Stable family key: sanitized text with identifiers and numbers masked. */
export function normalizeErrorSignature(sanitized) {
  return String(sanitized ?? "")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const CATEGORY_RULES = [
  ["HANDLER_NOT_REGISTERED", /no handler registered/i],
  ["JOB_ROW_MISSING", /^job \S+ not found/i],
  ["DATABASE_CONNECTIVITY", /\bP1\d{3}\b|can't reach database|connection pool|too many (clients|connections)|prisma.*(timed out|closed|terminated)/i],
  ["DATABASE_CONSTRAINT_OR_QUERY", /\bP2\d{3}\b|unique constraint|foreign key|null constraint|invalid `prisma|prisma.*invocation|column .* does not exist|relation .* does not exist/i],
  ["TIMEOUT", /\btimeout\b|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|deadline exceeded/i],
  ["NETWORK_CONNECTIVITY", /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|EPIPE|socket hang up|network error|fetch failed/i],
  ["UPSTREAM_RATE_LIMITED", /status code 429|\b429\b|rate limit|too many requests/i],
  ["UPSTREAM_AUTH_REJECTED", /status code 40[13]|\b40[13]\b|unauthori[sz]ed|forbidden|invalid (api )?key|authentication (failed|required)/i],
  ["UPSTREAM_5XX", /status code 5\d\d|\b50[0-4]\b|internal server error|bad gateway|service unavailable|gateway timeout/i],
  ["RESOURCE_EXHAUSTION", /out of memory|heap out of memory|maximum call stack|ENOMEM|EMFILE/i],
  ["CONFIGURATION", /missing required environment|not configured|environment variable|is not set\b|no .* configured/i],
  ["CODE_DEFECT_TYPEERROR", /cannot read propert|is not a function|is not iterable|is not defined|of undefined|of null|TypeError|ReferenceError|RangeError|SyntaxError|Unexpected token/i],
  ["UPSTREAM_NOT_FOUND", /status code 404|\b404\b|not found/i],
  ["VALIDATION_OR_BAD_REQUEST", /status code 4\d\d|bad request|validation|invalid\b|zod|expected .* received|is required|must be/i],
];

/** Coarse failure family for a sanitized error message. */
export function classifyError(sanitized) {
  const text = String(sanitized ?? "").trim();
  if (!text) return "NO_ERROR_MESSAGE";
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return "UNCLASSIFIED";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toCount(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function toIso(value) {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function percent(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 10000) / 100;
}

function minIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a < b ? a : b;
}

function maxIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

/** Exactly the allowlisted sample fields, coerced; nothing else survives. */
export function projectSampleRow(row) {
  const out = {};
  for (const field of SAMPLE_OUTPUT_FIELDS) {
    const value = row?.[field];
    if (field === "createdAt" || field === "startedAt" || field === "completedAt") out[field] = toIso(value);
    else if (field === "attempt" || field === "maxAttempts" || field === "progress") out[field] = value == null ? null : toCount(value);
    else out[field] = value == null ? null : String(value);
  }
  out.errorCategory = classifyError(sanitizeErrorText(row?.lastError));
  return out;
}

/** Refuse to serialize anything that carries a forbidden key, at any depth. */
export function assertNoForbiddenKeys(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return value;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_OUTPUT_KEYS.includes(key)) {
        throw new Error(`Forbidden key "${key}" at ${path}`);
      }
      assertNoForbiddenKeys(child, `${path}.${key}`);
    }
  }
  return value;
}

/**
 * Only the read methods this audit needs. Nothing else on the client is
 * reachable from the handler, so a coding mistake cannot become a write.
 */
export function readOnlyJobRunReader(prisma) {
  const model = prisma?.jobRun;
  if (!model || typeof model.count !== "function" || typeof model.groupBy !== "function" || typeof model.findMany !== "function") {
    throw new Error("jobRun read methods are unavailable.");
  }
  return Object.freeze({
    count: (args) => model.count(args),
    groupBy: (args) => model.groupBy(args),
    findMany: (args) => model.findMany(args),
  });
}

async function loadDefaultDependencies() {
  // Loaded only after both gates pass.
  const { prisma } = await import("../../database/prisma.js");
  return { prisma };
}

// ---------------------------------------------------------------------------
// Pure aggregation over query results (unit-testable without a database)
// ---------------------------------------------------------------------------

export function buildStatusCounts(statusGroups) {
  const counts = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0]));
  let total = 0;
  for (const group of statusGroups ?? []) {
    const n = toCount(group?._count?._all);
    if (group?.status in counts) counts[group.status] = n;
    else if (group?.status) counts[String(group.status)] = n;
    total += n;
  }
  return { ...counts, total };
}

export function buildDlqByJobName(jobGroups, dlqTotal) {
  return (jobGroups ?? [])
    .map((group) => ({
      jobName: String(group.jobName),
      count: toCount(group?._count?._all),
      percentageOfDlq: percent(toCount(group?._count?._all), dlqTotal),
      oldestCreatedAt: toIso(group?._min?.createdAt),
      newestCreatedAt: toIso(group?._max?.createdAt),
      oldestCompletedAt: toIso(group?._min?.completedAt),
      newestCompletedAt: toIso(group?._max?.completedAt),
    }))
    .sort((a, b) => b.count - a.count || a.jobName.localeCompare(b.jobName));
}

/**
 * attempt / maxAttempts analysis from (jobName, attempt, maxAttempts) groups.
 * `attempt === maxAttempts - 1` is the RETRY_ACCOUNTING_SIGNATURE: the row shape
 * the suspected off-by-one produces. It is a signature, not proof for any
 * individual row.
 */
export function buildAttemptAnalysis(attemptGroups) {
  const emptyBucket = () => ({ total: 0, attemptLessThanMax: 0, attemptEqualsMax: 0, attemptGreaterThanMax: 0, attemptEqualsMaxMinusOne: 0 });
  const totals = emptyBucket();
  const byJobName = {};
  const byAttempt = {};
  const byMaxAttempts = {};
  const byCombination = {};

  for (const group of attemptGroups ?? []) {
    const n = toCount(group?._count?._all);
    const attempt = toCount(group?.attempt);
    const maxAttempts = toCount(group?.maxAttempts);
    const jobName = String(group?.jobName ?? "");
    const bucket = (byJobName[jobName] ??= emptyBucket());

    byAttempt[attempt] = (byAttempt[attempt] ?? 0) + n;
    byMaxAttempts[maxAttempts] = (byMaxAttempts[maxAttempts] ?? 0) + n;
    const combo = `${attempt}/${maxAttempts}`;
    byCombination[combo] = (byCombination[combo] ?? 0) + n;

    for (const target of [totals, bucket]) {
      target.total += n;
      if (attempt < maxAttempts) target.attemptLessThanMax += n;
      else if (attempt === maxAttempts) target.attemptEqualsMax += n;
      else target.attemptGreaterThanMax += n;
      if (attempt === maxAttempts - 1) target.attemptEqualsMaxMinusOne += n;
    }
  }

  return { ...totals, byAttempt, byMaxAttempts, byCombination, byJobName };
}

export function buildErrorFamilies(errorRows) {
  const families = new Map();
  for (const row of errorRows ?? []) {
    const sanitized = sanitizeErrorText(row?.lastError);
    const category = classifyError(sanitized);
    const signature = normalizeErrorSignature(sanitized);
    const key = `${category}::${signature}`;
    const family = families.get(key) ?? {
      category,
      signature,
      count: 0,
      affectedJobNames: new Set(),
      sanitizedExample: sanitized.slice(0, MAX_EXAMPLE_LENGTH),
    };
    family.count += 1;
    if (row?.jobName) family.affectedJobNames.add(String(row.jobName));
    families.set(key, family);
  }
  // The normalized signature is the grouping key only; it is not serialized.
  return [...families.values()]
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category) || a.signature.localeCompare(b.signature))
    .map((family) => ({
      category: family.category,
      count: family.count,
      affectedJobNames: [...family.affectedJobNames].sort(),
      sanitizedExample: family.sanitizedExample,
    }));
}

export function ageIndication(ageByCompletedAt) {
  const a = ageByCompletedAt ?? {};
  const recent = toCount(a.lessThan1Hour) + toCount(a.oneTo24Hours);
  const total = recent + toCount(a.oneTo3Days) + toCount(a.threeTo7Days) + toCount(a.olderThan7Days);
  if (total === 0) return "EMPTY";
  // One or more dead-letters inside the last 24h. Whether that is a recurring
  // pattern is for the counts to say, not this label.
  if (recent > 0) return "RECENT_ACTIVITY_PRESENT";
  if (toCount(a.oneTo3Days) > 0 || toCount(a.threeTo7Days) > 0) return "RECENT_NOT_LAST_24H";
  return "HISTORICAL";
}

export function supplierDominance(dlqByJobName) {
  const matches = (dlqByJobName ?? [])
    .map((entry) => ({ jobName: entry.jobName, count: entry.count, supplier: entry.jobName.match(SUPPLIER_NAME_PATTERN)?.[1]?.toLowerCase() ?? null }))
    .filter((entry) => entry.supplier);
  if (matches.length === 0) return "NOT_DETERMINABLE_WITHOUT_SENSITIVE_PAYLOAD";
  const bySupplier = {};
  for (const entry of matches) bySupplier[entry.supplier] = (bySupplier[entry.supplier] ?? 0) + entry.count;
  return { determinedFrom: "jobName", bySupplier };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Build the handler. Dependencies are injectable so the gate, the projection
 * and the aggregation can be tested without a database or a Vercel runtime.
 */
export function createDeadLetterAuditPreviewHandler({
  env = process.env,
  loadDependencies = loadDefaultDependencies,
  now = () => new Date(),
} = {}) {
  return async function deadLetterAuditPreviewHandler(req, res, next) {
    // Gate 1: preview runtime only.
    if (!isPreviewRuntime(env)) return notFound(res);

    // Gate 2: a configured token, and a matching header. All failures identical.
    const expectedToken = env[DLQ_AUDIT_TOKEN_ENV];
    if (typeof expectedToken !== "string" || expectedToken.length === 0) return notFound(res);
    const providedToken = req?.headers?.[DLQ_AUDIT_TOKEN_HEADER];
    if (!tokenMatches(typeof providedToken === "string" ? providedToken : "", expectedToken)) {
      return notFound(res);
    }

    let queriesExecuted = 0;

    try {
      const { prisma } = await loadDependencies();
      const reader = readOnlyJobRunReader(prisma);
      const q = async (method, args) => {
        queriesExecuted += 1;
        return reader[method](args);
      };

      const generatedAt = now();
      const t = generatedAt.getTime();
      const h1 = new Date(t - 60 * 60 * 1000);
      const d1 = new Date(t - 24 * 60 * 60 * 1000);
      const d3 = new Date(t - 3 * 24 * 60 * 60 * 1000);
      const d7 = new Date(t - 7 * 24 * 60 * 60 * 1000);
      const dlqWhere = { status: "DEAD_LETTER" };

      // A. status counts
      const statusGroups = await q("groupBy", { by: ["status"], _count: { _all: true } });
      const statusCounts = buildStatusCounts(statusGroups);
      const dlqTotal = statusCounts.DEAD_LETTER;

      // B. DLQ by job name
      const jobGroups = await q("groupBy", {
        by: ["jobName"],
        where: dlqWhere,
        _count: { _all: true },
        _min: { createdAt: true, completedAt: true },
        _max: { createdAt: true, completedAt: true },
      });
      const dlqByJobName = buildDlqByJobName(jobGroups, dlqTotal);

      // C. attempt analysis
      const attemptGroups = await q("groupBy", {
        by: ["jobName", "attempt", "maxAttempts"],
        where: dlqWhere,
        _count: { _all: true },
      });
      const attemptAnalysis = buildAttemptAnalysis(attemptGroups);

      // D. age distribution — buckets anchored on the single generatedAt above.
      // `missing` is queried only for the nullable column (completedAt); createdAt
      // is NOT NULL and Prisma rejects a null filter on it.
      const ageBuckets = async (field, { nullable }) => ({
        lessThan1Hour: toCount(await q("count", { where: { ...dlqWhere, [field]: { gte: h1 } } })),
        oneTo24Hours: toCount(await q("count", { where: { ...dlqWhere, [field]: { gte: d1, lt: h1 } } })),
        oneTo3Days: toCount(await q("count", { where: { ...dlqWhere, [field]: { gte: d3, lt: d1 } } })),
        threeTo7Days: toCount(await q("count", { where: { ...dlqWhere, [field]: { gte: d7, lt: d3 } } })),
        olderThan7Days: toCount(await q("count", { where: { ...dlqWhere, [field]: { lt: d7 } } })),
        missing: nullable ? toCount(await q("count", { where: { ...dlqWhere, [field]: null } })) : 0,
      });
      const ageByCompletedAt = await ageBuckets("completedAt", { nullable: true });
      const ageByCreatedAt = await ageBuckets("createdAt", { nullable: false });

      // E. lastError classification — read internally, sanitized, never returned raw
      const errorRows = await q("findMany", {
        where: dlqWhere,
        select: { jobName: true, lastError: true },
        orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
        take: ERROR_SCAN_LIMIT,
      });
      const errorFamilies = buildErrorFamilies(errorRows);

      // F. safe sample — allowlisted select, capped, projected
      const sampleRows = await q("findMany", {
        where: dlqWhere,
        select: SAMPLE_SELECT,
        orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
        take: SAMPLE_LIMIT,
      });
      const sample = (Array.isArray(sampleRows) ? sampleRows : []).slice(0, SAMPLE_LIMIT).map(projectSampleRow);

      // Derived analysis
      const dominant = dlqByJobName[0] ?? null;
      const signatureByJobName = Object.fromEntries(
        Object.entries(attemptAnalysis.byJobName).map(([jobName, bucket]) => [
          jobName,
          {
            count: bucket.attemptEqualsMaxMinusOne,
            jobDlqTotal: bucket.total,
            percentageOfJobDlq: percent(bucket.attemptEqualsMaxMinusOne, bucket.total),
          },
        ]),
      );

      const body = {
        ok: true,
        meta: {
          readOnly: true,
          writesPerformed: 0,
          supplierApiCalls: 0,
          jobsExecuted: 0,
          generatedAt: generatedAt.toISOString(),
          queriesExecuted,
          sampleLimit: SAMPLE_LIMIT,
          errorScanLimit: ERROR_SCAN_LIMIT,
          errorRowsScanned: Array.isArray(errorRows) ? errorRows.length : 0,
          ageAnchor: "generatedAt",
        },
        statusCounts,
        dlqByJobName,
        attemptAnalysis,
        ageDistribution: { byCompletedAt: ageByCompletedAt, byCreatedAt: ageByCreatedAt },
        errorFamilies,
        sample,
        retryAccountingEvidence: {
          signature: "RETRY_ACCOUNTING_SIGNATURE: status = DEAD_LETTER AND attempt = maxAttempts - 1",
          note: "A signature match is consistent with the suspected off-by-one, not proof that a given row was caused by it.",
          confirmedSignatureCount: attemptAnalysis.attemptEqualsMaxMinusOne,
          percentageOfDlq: percent(attemptAnalysis.attemptEqualsMaxMinusOne, dlqTotal),
          byJobName: signatureByJobName,
        },
        dominantJobName: dominant?.jobName ?? null,
        dominantJobPercentage: dominant?.percentageOfDlq ?? 0,
        ageIndication: ageIndication(ageByCompletedAt),
        newestDeadLetterAt: dlqByJobName.reduce((acc, entry) => maxIso(acc, entry.newestCompletedAt), null),
        oldestDeadLetterAt: dlqByJobName.reduce((acc, entry) => minIso(acc, entry.oldestCompletedAt), null),
        supplierDominance: supplierDominance(dlqByJobName),
      };

      // Final guard immediately before serialization.
      assertNoForbiddenKeys(body);
      return res.json(body);
    } catch (error) {
      // The app error handler echoes err.message to the client; a driver error
      // can name the database host. Only a generic message and a short code pass.
      const safe = new Error(`Dead-letter audit failed (${error?.name ?? "Error"}).`);
      safe.statusCode = 500;
      if (typeof error?.code === "string" && /^[A-Z0-9_]{1,16}$/.test(error.code)) safe.code = error.code;
      return next(safe);
    }
  };
}

export const deadLetterAuditPreviewHandler = createDeadLetterAuditPreviewHandler();
