import { PrismaClient } from "@prisma/client";

/**
 * A read-only identity check on whatever DIRECT_URL points at.
 *
 * `DATABASE_URL` was deleted during an incident and replaced with a value that is not a Postgres
 * URL, so the runtime client cannot connect. `DIRECT_URL` was untouched, is declared in the same
 * datasource block, and has been present since the first commit of this repository — so if it still
 * names the original production database, that fact is recoverable without recovering any secret.
 *
 * This module answers exactly one question: is the database at DIRECT_URL this application's
 * database? It answers with structure and counts, never with content.
 *
 * Three properties hold by construction rather than by care:
 *
 *  - **No part of the URL can leave.** The URL is parsed once, and the only thing derived from it
 *    that reaches a caller is a provider CLASS chosen from a frozen list. Host, port, database
 *    name, user, password and query parameters are never returned, never logged, and never placed
 *    on an error. There is no code path that copies any of them into the result.
 *  - **Nothing is written.** Every statement is a fixed SELECT literal. There is no dynamic SQL, no
 *    interpolation, and no caller input reaches this module at all — the endpoint takes no
 *    parameters.
 *  - **The runtime client is untouched.** A separate, short-lived PrismaClient is constructed with
 *    an explicit datasource override and disconnected in a finally block. The exported `prisma`
 *    singleton, which reads DATABASE_URL, is never imported here.
 */

/** Provider classes. The only URL-derived value that ever leaves this module. */
export const PROVIDER_CLASSES = Object.freeze([
  "railway",
  "neon",
  "supabase",
  "aws",
  "digitalocean",
  "generic_postgres",
  "unknown",
]);

/** Fixed error categories. A category never carries a host, a URL or a driver message. */
export const DIAGNOSTIC_ERROR_CATEGORIES = Object.freeze([
  "MISSING_URL",
  "INVALID_SCHEME",
  "CONNECTION_FAILED",
  "QUERY_FAILED",
]);

/**
 * Host suffix → provider class.
 *
 * Matched as an exact host or a dot-anchored suffix, never as a substring: a substring test would
 * classify `neon.tech.attacker.example` as Neon. Misclassification would not leak anything, but a
 * classifier that can be fooled is not evidence, and this result is being used to identify a
 * database during an incident.
 */
const PROVIDER_SUFFIXES = Object.freeze([
  ["railway", ["railway.app", "rlwy.net", "railway.internal"]],
  ["neon", ["neon.tech"]],
  ["supabase", ["supabase.co", "supabase.com"]],
  ["aws", ["rds.amazonaws.com"]],
  ["digitalocean", ["db.ondigitalocean.com", "ondigitalocean.com"]],
]);

function matchesHost(hostname, suffix) {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/**
 * The provider class for one hostname.
 *
 * `generic_postgres` means "a hostname we could read but do not recognise", `unknown` means "there
 * was no hostname to read". The distinction matters to whoever reads the result: the first says the
 * URL is well formed and points somewhere unrecognised, the second says the URL told us nothing.
 */
export function classifyProviderHost(hostname) {
  const host = String(hostname ?? "").trim().toLowerCase();
  if (!host) return "unknown";
  for (const [providerClass, suffixes] of PROVIDER_SUFFIXES) {
    if (suffixes.some((suffix) => matchesHost(host, suffix))) return providerClass;
  }
  return "generic_postgres";
}

/**
 * Presence, scheme validity and provider class for a candidate URL.
 *
 * Returns no part of the URL. A value that fails to parse is reported as an invalid scheme rather
 * than as a parse error, because from the caller's point of view those are the same fact: this is
 * not a usable Postgres URL.
 */
export function inspectDirectUrl(rawUrl) {
  const value = typeof rawUrl === "string" ? rawUrl : "";
  if (!value.trim()) {
    return { present: false, validScheme: false, providerClass: "unknown" };
  }

  // Checked on the RAW string, before parsing, and this ordering is the point. The WHATWG URL
  // parser strips leading and trailing whitespace, so `new URL(" postgresql://...")` succeeds —
  // while Prisma's engine does not strip it and rejects the same value with "the URL must start
  // with the protocol postgresql:// or postgres://". A diagnostic that disagreed with the engine
  // about exactly this would report a working URL for the malformation it exists to detect.
  if (!value.startsWith("postgresql://") && !value.startsWith("postgres://")) {
    return { present: true, validScheme: false, providerClass: "unknown" };
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { present: true, validScheme: false, providerClass: "unknown" };
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    // Deliberately not classified. A non-Postgres URL's host is not a Postgres provider, and
    // reporting a class for it would invite reading meaning into a value that has none here.
    return { present: true, validScheme: false, providerClass: "unknown" };
  }

  return { present: true, validScheme: true, providerClass: classifyProviderHost(parsed.hostname) };
}

/**
 * The tables that identify this application.
 *
 * Unmapped Prisma models keep their PascalCase names and must be quoted; models carrying `@@map`
 * are listed under the mapped name. `_prisma_migrations` is Prisma's own bookkeeping table and is
 * what makes the lineage check possible.
 */
export const IDENTITY_TABLES = Object.freeze({
  userTableExists: "User",
  marketplaceAccountTableExists: "MarketplaceAccount",
  fieldRegistryTableExists: "FieldRegistry",
  rawPayloadsTableExists: "raw_payloads",
  supplierCampaignsTableExists: "supplier_campaigns",
  prismaMigrationsTableExists: "_prisma_migrations",
});

const EMPTY_IDENTITY = Object.freeze(
  Object.fromEntries(Object.keys(IDENTITY_TABLES).map((key) => [key, false])),
);

const EMPTY_MIGRATIONS = Object.freeze({
  appliedCount: null,
  firstMigration: null,
  lastMigration: null,
});

const EMPTY_ROW_COUNTS = Object.freeze({
  users: null,
  marketplaceAccounts: null,
  rawPayloads: null,
  supplierCampaigns: null,
});

/** Total wall-clock budget. A hung connect must not hold a serverless invocation open. */
export const DIAGNOSTIC_TIMEOUT_MS = Number(process.env.DB_DIAGNOSTIC_TIMEOUT_MS || 8000);

/**
 * Rejects once the budget is spent.
 *
 * The rejection carries a fixed string — never a driver message, which could quote the URL.
 * `Promise.race` subscribes to both promises, so a driver rejection arriving after the timeout has
 * already won is still handled and cannot surface as an unhandled rejection.
 */
function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`diagnostic timed out: ${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * One count query per table, each a fixed literal.
 *
 * Written as separate templates rather than one parameterised query on purpose: a table name cannot
 * be a bind parameter, so a single query would need string interpolation. There is no caller input
 * here to interpolate, but a module that contains no dynamic SQL cannot grow an injection later.
 */
const ROW_COUNT_QUERIES = Object.freeze({
  users: {
    table: "User",
    run: (client) => client.$queryRaw`SELECT COUNT(*)::int AS count FROM "User"`,
  },
  marketplaceAccounts: {
    table: "MarketplaceAccount",
    run: (client) => client.$queryRaw`SELECT COUNT(*)::int AS count FROM "MarketplaceAccount"`,
  },
  rawPayloads: {
    table: "raw_payloads",
    run: (client) => client.$queryRaw`SELECT COUNT(*)::int AS count FROM "raw_payloads"`,
  },
  supplierCampaigns: {
    table: "supplier_campaigns",
    run: (client) => client.$queryRaw`SELECT COUNT(*)::int AS count FROM "supplier_campaigns"`,
  },
});

/** Default factory. Overridable so tests never construct a real client. */
function defaultClientFactory(url) {
  return new PrismaClient({
    datasources: { db: { url } },
    // Prisma's own logs can carry the datasource URL. Nothing from this client is logged.
    log: [],
  });
}

/**
 * Which of the identity tables exist, in any non-system schema.
 *
 * Not restricted to `public`: a database reached with a `?schema=` parameter puts them elsewhere,
 * and "are these tables present at all" is the question being asked. System catalogs are excluded
 * so the answer is about application tables only.
 */
async function readIdentityTables(client) {
  const names = Object.values(IDENTITY_TABLES);
  const rows = await client.$queryRaw`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_name = ANY(${names}::text[])
  `;
  const present = new Set((rows ?? []).map((row) => String(row.table_name)));
  return Object.fromEntries(
    Object.entries(IDENTITY_TABLES).map(([key, table]) => [key, present.has(table)]),
  );
}

/**
 * Migration lineage.
 *
 * `migration_name` is prefixed with a sortable timestamp, so lexicographic MIN and MAX are the
 * first and last applied migration. Only finished migrations count: a row with a null `finished_at`
 * is an interrupted apply, not applied state.
 */
async function readMigrationFingerprint(client) {
  const rows = await client.$queryRaw`
    SELECT COUNT(*)::int      AS applied_count,
           MIN(migration_name) AS first_migration,
           MAX(migration_name) AS last_migration
    FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL
  `;
  const row = rows?.[0] ?? {};
  return {
    appliedCount: row.applied_count ?? 0,
    firstMigration: row.first_migration ?? null,
    lastMigration: row.last_migration ?? null,
  };
}

async function readRowCounts(client, identity) {
  const counts = { ...EMPTY_ROW_COUNTS };
  const existing = new Set(
    Object.entries(identity)
      .filter(([, exists]) => exists)
      .map(([key]) => IDENTITY_TABLES[key]),
  );

  for (const [key, { table, run }] of Object.entries(ROW_COUNT_QUERIES)) {
    // Counting a table that is not there would fail the whole read for a fact already reported.
    if (!existing.has(table)) continue;
    const rows = await run(client);
    counts[key] = rows?.[0]?.count ?? null;
  }
  return counts;
}

/**
 * The diagnostic.
 *
 * Never throws: every failure is reported as one of the fixed categories, so a caller cannot end up
 * relaying a driver message that quotes the connection string. Partial results are kept — a
 * database that connects but refuses one query still tells us what the other queries found.
 */
export async function runDatabaseRecoveryDiagnostic({
  url = process.env.DIRECT_URL,
  clientFactory = defaultClientFactory,
  timeoutMs = DIAGNOSTIC_TIMEOUT_MS,
} = {}) {
  const { present, validScheme, providerClass } = inspectDirectUrl(url);

  const base = {
    directUrlPresent: present,
    directUrlValidPostgresScheme: validScheme,
    providerClass,
    connectionOk: false,
    databaseIdentity: { ...EMPTY_IDENTITY },
    migrationFingerprint: { ...EMPTY_MIGRATIONS },
    rowCountFingerprint: { ...EMPTY_ROW_COUNTS },
    errorCategory: null,
  };

  if (!present) return { ...base, errorCategory: "MISSING_URL" };
  if (!validScheme) return { ...base, errorCategory: "INVALID_SCHEME" };

  let client = null;
  try {
    client = clientFactory(url);
  } catch {
    // Constructing the client is where an unusable URL is rejected outright.
    return { ...base, errorCategory: "CONNECTION_FAILED" };
  }

  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(250, deadline - Date.now());

  try {
    try {
      await withTimeout(client.$queryRaw`SELECT 1`, remaining(), "connect");
    } catch {
      return { ...base, errorCategory: "CONNECTION_FAILED" };
    }

    const result = { ...base, connectionOk: true };

    try {
      result.databaseIdentity = await withTimeout(readIdentityTables(client), remaining(), "tables");
    } catch {
      return { ...result, errorCategory: "QUERY_FAILED" };
    }

    if (result.databaseIdentity.prismaMigrationsTableExists) {
      try {
        result.migrationFingerprint = await withTimeout(
          readMigrationFingerprint(client),
          remaining(),
          "migrations",
        );
      } catch {
        return { ...result, errorCategory: "QUERY_FAILED" };
      }
    }

    try {
      result.rowCountFingerprint = await withTimeout(
        readRowCounts(client, result.databaseIdentity),
        remaining(),
        "counts",
      );
    } catch {
      return { ...result, errorCategory: "QUERY_FAILED" };
    }

    return result;
  } finally {
    // Always released, including on the timeout path, so a serverless invocation cannot leak a
    // connection to a database it was only inspecting.
    await client?.$disconnect?.().catch(() => {});
  }
}
