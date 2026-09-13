/**
 * TEMPORARY ONE-TIME MIGRATION HOOK — REMOVE AFTER USE.
 *
 * Applies exactly one pre-audited migration in an environment where the database URL exists
 * (the Vercel production build), because DATABASE_URL is intentionally absent locally and
 * production runs through the DIRECT_URL fallback.
 *
 * This is NOT a general deploy step. It refuses to do anything unless the database is in the
 * exact expected state, and once that migration is applied the gate can never pass again.
 *
 * It never prints the connection string, host, username, password or any credential — only
 * counts, booleans and migration names.
 */
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const EXPECTED_MIGRATION = "20260913090000_partnerize_supplier_tracking_link";
const EXPECTED_PRECEDING = "20260903060000_expand_supplier_keys";
const EXPECTED_TOTAL_DIRECTORIES = 57;
const EXPECTED_APPLIED_BEFORE = 56;
const EXPECTED_USER_COUNT = 7;

const REQUIRED_COLUMNS = [
  "supplierTrackingLinkState",
  "supplierTrackingLinkProvenance",
  "supplierTrackingLinkUpdatedAt",
  "supplierTrackingLinkUpdatedBy",
];
const REQUIRED_INDEX = "supplier_campaigns_supplier_supplierTrackingLinkState_idx";

const log = (...args) => console.log("[one-time-migration]", ...args);

function fail(message) {
  console.error(`[one-time-migration] GATE FAILED: ${message}`);
  console.error("[one-time-migration] migrate deploy was NOT run. No database change was made.");
  process.exit(1);
}

function isValidPostgresUrl(value) {
  return (
    typeof value === "string" &&
    (value.startsWith("postgresql://") || value.startsWith("postgres://"))
  );
}

/** Resolve the URL without ever logging it. Mirrors src/database/prisma.js. */
function resolveUrl() {
  for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
    if (isValidPostgresUrl(process.env[name])) {
      log(`using connection from ${name} (value not shown)`);
      return process.env[name];
    }
  }
  fail("no usable postgres URL is present in this environment.");
  return null;
}

/**
 * Strip every connection detail Prisma prints. Its normal (non-error) output includes
 * `Datasource "db": PostgreSQL database "<name>", schema "public" at "<host>:<port>"`,
 * so redacting URLs alone is not sufficient — the host would reach the build log.
 */
function redact(text) {
  return String(text ?? "")
    .replace(/postgres(ql)?:\/\/\S+/gi, "[redacted]")
    .replace(/\bat\s+"[^"]*"/gi, 'at "[redacted]"')
    .replace(/\bdatabase\s+"[^"]*"/gi, 'database "[redacted]"')
    .replace(/\bhost(name)?\s*[:=]\s*\S+/gi, "host=[redacted]")
    .replace(/\buser(name)?\s*[:=]\s*\S+/gi, "user=[redacted]");
}

function runPrisma(args, url) {
  const result = spawnSync("npx", ["prisma", ...args], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
  return {
    status: result.status,
    out: redact(`${result.stdout ?? ""}${result.stderr ?? ""}`),
  };
}

async function main() {
  const url = resolveUrl();
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    // ---------------------------------------------------------------- gate
    const status = runPrisma(["migrate", "status"], url);
    // `migrate status` exits non-zero when migrations are pending, which is the expected case.

    const foundMatch = status.out.match(/(\d+)\s+migrations?\s+found in prisma\/migrations/i);
    const directories = foundMatch ? Number(foundMatch[1]) : null;
    if (directories !== EXPECTED_TOTAL_DIRECTORIES) {
      fail(`expected ${EXPECTED_TOTAL_DIRECTORIES} migration directories, found ${directories}.`);
    }
    log(`migration directories: ${directories}`);

    const pending = [...status.out.matchAll(/^\s*(\d{14}_[a-z0-9_]+)\s*$/gim)].map((m) => m[1]);
    const uniquePending = [...new Set(pending)];
    if (uniquePending.length !== 1) {
      fail(`expected exactly 1 pending migration, found ${uniquePending.length}: ${uniquePending.join(", ")}`);
    }
    if (uniquePending[0] !== EXPECTED_MIGRATION) {
      fail(`pending migration is ${uniquePending[0]}, expected ${EXPECTED_MIGRATION}.`);
    }
    log(`pending migration: ${uniquePending[0]}`);

    const applied = await prisma.$queryRawUnsafe(
      `select migration_name from _prisma_migrations
        where finished_at is not null and rolled_back_at is null
        order by finished_at desc`,
    );
    const appliedNames = applied.map((row) => row.migration_name);
    log(`applied migrations before: ${appliedNames.length}`);
    if (appliedNames.length !== EXPECTED_APPLIED_BEFORE) {
      fail(`expected ${EXPECTED_APPLIED_BEFORE} applied migrations, found ${appliedNames.length}.`);
    }
    if (appliedNames[0] !== EXPECTED_PRECEDING) {
      fail(`latest applied migration is ${appliedNames[0]}, expected ${EXPECTED_PRECEDING}.`);
    }
    log(`latest applied before: ${appliedNames[0]}`);
    if (appliedNames.includes(EXPECTED_MIGRATION)) {
      fail(`${EXPECTED_MIGRATION} is already applied.`);
    }

    const [{ count: campaignsBefore }] = await prisma.$queryRawUnsafe(
      `select count(*)::int as count from supplier_campaigns`,
    );
    const [{ count: usersBefore }] = await prisma.$queryRawUnsafe(`select count(*)::int as count from "User"`);
    log(`pre-migration counts — supplier_campaigns: ${campaignsBefore}, User: ${usersBefore}`);

    log("GATE PASSED — all four conditions met. Applying.");

    // -------------------------------------------------------------- apply
    const deploy = runPrisma(["migrate", "deploy"], url);
    console.log(deploy.out.trim());
    if (deploy.status !== 0) {
      console.error("[one-time-migration] migrate deploy failed; Postgres DDL is transactional so the migration rolled back.");
      process.exit(1);
    }

    // ------------------------------------------------------------- verify
    const after = await prisma.$queryRawUnsafe(
      `select migration_name from _prisma_migrations
        where finished_at is not null and rolled_back_at is null`,
    );
    const afterNames = after.map((row) => row.migration_name);
    const checks = [];
    const check = (label, pass, detail) => {
      checks.push({ label, pass, detail });
      log(`${pass ? "PASS" : "FAIL"} — ${label}${detail ? `: ${detail}` : ""}`);
    };

    check("migration recorded", afterNames.includes(EXPECTED_MIGRATION), EXPECTED_MIGRATION);
    check("applied count is 57", afterNames.length === 57, String(afterNames.length));

    const columns = await prisma.$queryRawUnsafe(
      `select column_name from information_schema.columns
        where table_name = 'supplier_campaigns' and column_name = any($1::text[])`,
      REQUIRED_COLUMNS,
    );
    const columnNames = columns.map((row) => row.column_name).sort();
    check("all four columns exist", columnNames.length === 4, columnNames.join(", "));

    const indexes = await prisma.$queryRawUnsafe(
      `select indexname from pg_indexes where tablename = 'supplier_campaigns' and indexname = $1`,
      REQUIRED_INDEX,
    );
    check("index exists", indexes.length === 1, REQUIRED_INDEX);

    const [{ count: usersAfter }] = await prisma.$queryRawUnsafe(`select count(*)::int as count from "User"`);
    check(`User count is ${EXPECTED_USER_COUNT}`, usersAfter === EXPECTED_USER_COUNT, String(usersAfter));

    const [{ count: campaignsAfter }] = await prisma.$queryRawUnsafe(
      `select count(*)::int as count from supplier_campaigns`,
    );
    check("supplier_campaigns count unchanged", campaignsAfter === campaignsBefore, `${campaignsBefore} -> ${campaignsAfter}`);

    const postStatus = runPrisma(["migrate", "status"], url);
    check("no migration remains pending", /up to date|no pending migrations/i.test(postStatus.out), "");

    const stateBreakdown = await prisma.$queryRawUnsafe(
      `select "supplierTrackingLinkState"::text as state, count(*)::int as count
         from supplier_campaigns group by 1 order by 1`,
    );
    log(`backfill result: ${stateBreakdown.map((r) => `${r.state}=${r.count}`).join(", ") || "(no rows)"}`);

    const failed = checks.filter((entry) => !entry.pass);
    if (failed.length) {
      console.error(`[one-time-migration] ${failed.length} post-verification check(s) failed.`);
      process.exit(1);
    }
    log("ALL POST-VERIFICATION CHECKS PASSED.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  const message = redact(error?.message ?? error);
  console.error(`[one-time-migration] unexpected error: ${message}`);
  process.exit(1);
});
