/**
 * TEMPORARY ONE-SHOT MIGRATION — REMOVE AFTER USE.
 *
 * Applies exactly one pre-audited migration from the live runtime, because the Prisma CLI cannot
 * reach this database from anywhere we control: DATABASE_URL is intentionally absent and the
 * runtime reaches Postgres through the DIRECT_URL fallback in src/database/prisma.js.
 *
 * It reuses that existing client. It never reads, prints, logs or transmits the connection string,
 * host, database name or credentials.
 *
 * Everything — preconditions, the five statements, the migration record and post-verification —
 * happens inside ONE transaction. PostgreSQL DDL is transactional, so any failure at any point
 * leaves the database exactly as it was.
 *
 * No Prisma CLI, no child_process, no shell. The SQL is a frozen constant; nothing about it comes
 * from the request.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../../database/prisma.js";

export const MIGRATION_NAME = "20260913090000_partnerize_supplier_tracking_link";
export const EXPECTED_PRECEDING_MIGRATION = "20260903060000_expand_supplier_keys";
export const EXPECTED_APPLIED_COUNT_BEFORE = 56;
export const EXPECTED_APPLIED_COUNT_AFTER = 57;

/** SHA-256 of the audited migration.sql, confirmed to match what `prisma migrate deploy` records. */
export const EXPECTED_CHECKSUM =
  "d008e553464fa0d8b99a6dfcc3c60b55164cd53b4e7edcb52b41061af4f28790";

export const NEW_COLUMNS = Object.freeze([
  "supplierTrackingLinkState",
  "supplierTrackingLinkProvenance",
  "supplierTrackingLinkUpdatedAt",
  "supplierTrackingLinkUpdatedBy",
]);

export const NEW_ENUM_TYPES = Object.freeze([
  "SupplierTrackingLinkState",
  "SupplierTrackingLinkProvenance",
]);

export const NEW_INDEX = "supplier_campaigns_supplier_supplierTrackingLinkState_idx";

export const MIGRATION_STATUS = Object.freeze({
  APPLIED: "APPLIED",
  ALREADY_APPLIED: "ALREADY_APPLIED",
});

/**
 * The five audited statements, verbatim from the migration file and frozen here.
 *
 * They are NOT parsed out of the file at runtime: `$executeRawUnsafe` uses the extended query
 * protocol and rejects multi-statement strings ("cannot insert multiple commands into a prepared
 * statement", SQLSTATE 42601), and splitting arbitrary SQL on semicolons is a footgun. The file is
 * still read — to checksum it — so the statements below and the recorded checksum cannot drift
 * apart silently.
 */
export const MIGRATION_STATEMENTS = Object.freeze([
  `CREATE TYPE "SupplierTrackingLinkState" AS ENUM (
  'TRACKING_LINK_NOT_GENERATED',
  'TRACKING_LINK_AVAILABLE',
  'TRACKING_LINK_NEEDS_REVIEW',
  'TRACKING_LINK_REVOKED'
)`,
  `CREATE TYPE "SupplierTrackingLinkProvenance" AS ENUM (
  'MANUAL_ADMIN',
  'SUPPLIER_API'
)`,
  `ALTER TABLE "supplier_campaigns"
  ADD COLUMN "supplierTrackingLinkState" "SupplierTrackingLinkState" NOT NULL DEFAULT 'TRACKING_LINK_NOT_GENERATED',
  ADD COLUMN "supplierTrackingLinkProvenance" "SupplierTrackingLinkProvenance",
  ADD COLUMN "supplierTrackingLinkUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "supplierTrackingLinkUpdatedBy" TEXT`,
  `UPDATE "supplier_campaigns"
   SET "supplierTrackingLinkState" = 'TRACKING_LINK_AVAILABLE'
 WHERE "trackingUrl" IS NOT NULL
   AND btrim("trackingUrl") <> ''`,
  `CREATE INDEX "supplier_campaigns_supplier_supplierTrackingLinkState_idx"
  ON "supplier_campaigns"("supplier", "supplierTrackingLinkState")`,
]);

export const PRECONDITION_CODES = Object.freeze({
  CHECKSUM_MISMATCH: "CHECKSUM_MISMATCH",
  UNEXPECTED_APPLIED_COUNT: "UNEXPECTED_APPLIED_COUNT",
  UNEXPECTED_LATEST_MIGRATION: "UNEXPECTED_LATEST_MIGRATION",
  SUPPLIER_CAMPAIGNS_TABLE_MISSING: "SUPPLIER_CAMPAIGNS_TABLE_MISSING",
  COLUMN_ALREADY_EXISTS: "COLUMN_ALREADY_EXISTS",
  ENUM_TYPE_ALREADY_EXISTS: "ENUM_TYPE_ALREADY_EXISTS",
  INDEX_ALREADY_EXISTS: "INDEX_ALREADY_EXISTS",
});

export const VERIFICATION_CODES = Object.freeze({
  APPLIED_COUNT: "POST_APPLIED_COUNT",
  MIGRATION_ROW_MISSING: "POST_MIGRATION_ROW_MISSING",
  CHECKSUM_NOT_RECORDED: "POST_CHECKSUM_NOT_RECORDED",
  COLUMNS_MISSING: "POST_COLUMNS_MISSING",
  ENUMS_MISSING: "POST_ENUMS_MISSING",
  INDEX_MISSING: "POST_INDEX_MISSING",
  USER_COUNT_CHANGED: "POST_USER_COUNT_CHANGED",
  CAMPAIGN_COUNT_CHANGED: "POST_CAMPAIGN_COUNT_CHANGED",
  TRACKING_URLS_MUTATED: "POST_TRACKING_URLS_MUTATED",
  BACKFILL_INCONSISTENT: "POST_BACKFILL_INCONSISTENT",
});

export class MigrationPreconditionError extends Error {
  constructor(code, detail = null) {
    super(`Precondition failed: ${code}`);
    this.name = "MigrationPreconditionError";
    this.code = code;
    this.detail = detail;
  }
}

export class MigrationVerificationError extends Error {
  constructor(code, detail = null) {
    super(`Post-verification failed: ${code}`);
    this.name = "MigrationVerificationError";
    this.code = code;
    this.detail = detail;
  }
}

const MIGRATION_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "prisma",
  "migrations",
  MIGRATION_NAME,
  "migration.sql",
);

/** SHA-256 of the raw file bytes — the algorithm Prisma itself uses, confirmed against real rows. */
export async function computeMigrationChecksum(readFileImpl = readFile) {
  return createHash("sha256").update(await readFileImpl(MIGRATION_FILE)).digest("hex");
}

const count = async (tx, sql, ...params) => Number((await tx.$queryRawUnsafe(sql, ...params))[0].n);

async function readState(tx) {
  const appliedRows = await tx.$queryRawUnsafe(
    `select migration_name, checksum from _prisma_migrations
      where finished_at is not null and rolled_back_at is null
      order by finished_at desc`,
  );
  return {
    appliedNames: appliedRows.map((row) => row.migration_name),
    checksums: new Map(appliedRows.map((row) => [row.migration_name, row.checksum])),
    users: await count(tx, `select count(*)::int n from "User"`),
    campaigns: await count(tx, `select count(*)::int n from supplier_campaigns`),
    trackingUrls: await count(
      tx,
      `select count(*)::int n from supplier_campaigns where "trackingUrl" is not null and btrim("trackingUrl") <> ''`,
    ),
  };
}

/**
 * Apply the migration, once.
 *
 * @returns {Promise<object>} a credential-free summary.
 */
export async function applyPartnerizeTrackingMigration({ client = prisma } = {}) {
  const checksum = await computeMigrationChecksum();
  const startedAt = new Date();

  return client.$transaction(
    async (tx) => {
      // ------------------------------------------------------------ preconditions
      const before = await readState(tx);

      // Checked first and before any write: a repeat call is a no-op, not an error.
      if (before.appliedNames.includes(MIGRATION_NAME)) {
        return {
          status: MIGRATION_STATUS.ALREADY_APPLIED,
          writesExecuted: 0,
          migrationName: MIGRATION_NAME,
          appliedMigrationCountBefore: before.appliedNames.length,
          appliedMigrationCountAfter: before.appliedNames.length,
          userCountBefore: before.users,
          userCountAfter: before.users,
          supplierCampaignCountBefore: before.campaigns,
          supplierCampaignCountAfter: before.campaigns,
          columnsVerified: false,
          enumsVerified: false,
          indexVerified: false,
        };
      }

      // A tampered migration file must never be recorded under this migration's name.
      if (checksum !== EXPECTED_CHECKSUM) {
        throw new MigrationPreconditionError(PRECONDITION_CODES.CHECKSUM_MISMATCH);
      }
      if (before.appliedNames.length !== EXPECTED_APPLIED_COUNT_BEFORE) {
        throw new MigrationPreconditionError(PRECONDITION_CODES.UNEXPECTED_APPLIED_COUNT, {
          expected: EXPECTED_APPLIED_COUNT_BEFORE,
          actual: before.appliedNames.length,
        });
      }
      if (before.appliedNames[0] !== EXPECTED_PRECEDING_MIGRATION) {
        throw new MigrationPreconditionError(PRECONDITION_CODES.UNEXPECTED_LATEST_MIGRATION, {
          expected: EXPECTED_PRECEDING_MIGRATION,
          actual: before.appliedNames[0] ?? null,
        });
      }

      const tableExists = await count(
        tx,
        `select count(*)::int n from information_schema.tables
          where table_schema = 'public' and table_name = 'supplier_campaigns'`,
      );
      if (tableExists !== 1) {
        throw new MigrationPreconditionError(PRECONDITION_CODES.SUPPLIER_CAMPAIGNS_TABLE_MISSING);
      }

      const existingColumns = await tx.$queryRawUnsafe(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'supplier_campaigns'
            and column_name = any($1::text[])`,
        [...NEW_COLUMNS],
      );
      if (existingColumns.length) {
        throw new MigrationPreconditionError(PRECONDITION_CODES.COLUMN_ALREADY_EXISTS, {
          columns: existingColumns.map((row) => row.column_name),
        });
      }

      // CREATE TYPE on an existing type aborts the transaction, so this is checked explicitly
      // rather than left to surface as an opaque 500.
      const existingEnums = await tx.$queryRawUnsafe(
        `select typname from pg_type where typname = any($1::text[])`,
        [...NEW_ENUM_TYPES],
      );
      if (existingEnums.length) {
        throw new MigrationPreconditionError(PRECONDITION_CODES.ENUM_TYPE_ALREADY_EXISTS, {
          types: existingEnums.map((row) => row.typname),
        });
      }

      const existingIndex = await count(
        tx,
        `select count(*)::int n from pg_indexes where tablename = 'supplier_campaigns' and indexname = $1`,
        NEW_INDEX,
      );
      if (existingIndex !== 0) {
        throw new MigrationPreconditionError(PRECONDITION_CODES.INDEX_ALREADY_EXISTS);
      }

      // ------------------------------------------------------------------- apply
      for (const statement of MIGRATION_STATEMENTS) {
        await tx.$executeRawUnsafe(statement);
      }

      await tx.$executeRawUnsafe(
        `insert into _prisma_migrations
           (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         values ($1, $2, $3, $4, NULL, NULL, $5, 1)`,
        randomUUID(),
        checksum,
        new Date(),
        MIGRATION_NAME,
        startedAt,
      );

      // ------------------------------------------------------------------ verify
      const after = await readState(tx);

      if (after.appliedNames.length !== EXPECTED_APPLIED_COUNT_AFTER) {
        throw new MigrationVerificationError(VERIFICATION_CODES.APPLIED_COUNT, {
          expected: EXPECTED_APPLIED_COUNT_AFTER,
          actual: after.appliedNames.length,
        });
      }
      if (!after.appliedNames.includes(MIGRATION_NAME)) {
        throw new MigrationVerificationError(VERIFICATION_CODES.MIGRATION_ROW_MISSING);
      }
      if (after.checksums.get(MIGRATION_NAME) !== checksum) {
        throw new MigrationVerificationError(VERIFICATION_CODES.CHECKSUM_NOT_RECORDED);
      }

      const columns = await tx.$queryRawUnsafe(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'supplier_campaigns'
            and column_name = any($1::text[])`,
        [...NEW_COLUMNS],
      );
      if (columns.length !== NEW_COLUMNS.length) {
        throw new MigrationVerificationError(VERIFICATION_CODES.COLUMNS_MISSING, {
          found: columns.length,
        });
      }

      const enums = await tx.$queryRawUnsafe(
        `select typname from pg_type where typname = any($1::text[])`,
        [...NEW_ENUM_TYPES],
      );
      if (enums.length !== NEW_ENUM_TYPES.length) {
        throw new MigrationVerificationError(VERIFICATION_CODES.ENUMS_MISSING, {
          found: enums.length,
        });
      }

      const indexes = await count(
        tx,
        `select count(*)::int n from pg_indexes where tablename = 'supplier_campaigns' and indexname = $1`,
        NEW_INDEX,
      );
      if (indexes !== 1) {
        throw new MigrationVerificationError(VERIFICATION_CODES.INDEX_MISSING);
      }

      if (after.users !== before.users) {
        throw new MigrationVerificationError(VERIFICATION_CODES.USER_COUNT_CHANGED, {
          before: before.users,
          after: after.users,
        });
      }
      if (after.campaigns !== before.campaigns) {
        throw new MigrationVerificationError(VERIFICATION_CODES.CAMPAIGN_COUNT_CHANGED, {
          before: before.campaigns,
          after: after.campaigns,
        });
      }
      // The migration writes only the new state column; no existing tracking URL may change.
      if (after.trackingUrls !== before.trackingUrls) {
        throw new MigrationVerificationError(VERIFICATION_CODES.TRACKING_URLS_MUTATED, {
          before: before.trackingUrls,
          after: after.trackingUrls,
        });
      }

      // Every row carrying a tracking URL must be AVAILABLE, every other row NOT_GENERATED,
      // and the states must account for exactly the whole table.
      const available = await count(
        tx,
        `select count(*)::int n from supplier_campaigns
          where "supplierTrackingLinkState" = 'TRACKING_LINK_AVAILABLE'`,
      );
      const notGenerated = await count(
        tx,
        `select count(*)::int n from supplier_campaigns
          where "supplierTrackingLinkState" = 'TRACKING_LINK_NOT_GENERATED'`,
      );
      if (available !== after.trackingUrls || available + notGenerated !== after.campaigns) {
        throw new MigrationVerificationError(VERIFICATION_CODES.BACKFILL_INCONSISTENT, {
          available,
          notGenerated,
          withTrackingUrl: after.trackingUrls,
          total: after.campaigns,
        });
      }

      return {
        status: MIGRATION_STATUS.APPLIED,
        writesExecuted: MIGRATION_STATEMENTS.length + 1,
        migrationName: MIGRATION_NAME,
        appliedMigrationCountBefore: before.appliedNames.length,
        appliedMigrationCountAfter: after.appliedNames.length,
        userCountBefore: before.users,
        userCountAfter: after.users,
        supplierCampaignCountBefore: before.campaigns,
        supplierCampaignCountAfter: after.campaigns,
        columnsVerified: true,
        enumsVerified: true,
        indexVerified: true,
      };
    },
    { timeout: 120000 },
  );
}
