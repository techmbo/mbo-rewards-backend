import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = join(__dirname, "..");
const MIGRATIONS_ROOT = join(REPO_ROOT, "prisma/migrations");
const MIGRATION_DIR = "20260927090000_supplier_coupons_entity_identity";
const PREVIOUS_MIGRATION_DIR = "20260926120000_product_tracking_links_one_active_per_client_product";
const MIGRATION_FILE = join(MIGRATIONS_ROOT, MIGRATION_DIR, "migration.sql");
const SCHEMA_FILE = join(REPO_ROOT, "prisma/schema.prisma");

const INDEX_NAME = "supplier_coupons_entityId_key";
const TABLE_NAME = "supplier_coupons";
const RETIRED_CODE_INDEX = "supplier_coupons_campaign_code_unique";
const RETIRED_LINK_INDEX = "supplier_coupons_campaign_link_unique";

/** Comments stripped so assertions target executable SQL only. */
function executableSql(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function statementsOf(sql) {
  return executableSql(sql)
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function migrationDirs() {
  return readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function supplierCouponModel() {
  const schema = readFileSync(SCHEMA_FILE, "utf8");
  const modelStart = schema.indexOf("model SupplierCoupon {");
  assert.ok(modelStart > 0, "SupplierCoupon model not found");
  const modelEnd = schema.indexOf("\n}\n", modelStart);
  const body = schema.slice(modelStart, modelEnd);

  // The doc block is the run of /// lines immediately above the model.
  const docLines = [];
  for (const line of schema.slice(0, modelStart).trimEnd().split("\n").reverse()) {
    if (!line.startsWith("///")) break;
    docLines.unshift(line);
  }
  return { schema, body, doc: docLines.join("\n") };
}

describe("supplier coupon entity identity — recording migration", () => {
  it("exists and directly follows the tracking-links recording migration", () => {
    assert.ok(existsSync(MIGRATION_FILE), `${MIGRATION_FILE} is missing`);
    const dirs = migrationDirs();
    const index = dirs.indexOf(MIGRATION_DIR);
    assert.ok(index > 0, "migration directory not found among migrations");
    assert.equal(dirs[index - 1], PREVIOUS_MIGRATION_DIR);
  });

  it("contains exactly three executable statements", () => {
    assert.equal(statementsOf(readFileSync(MIGRATION_FILE, "utf8")).length, 3);
  });

  it("statement 1 retires the code partial unique index idempotently", () => {
    const [first] = statementsOf(readFileSync(MIGRATION_FILE, "utf8"));
    assert.equal(first, `DROP INDEX IF EXISTS "${RETIRED_CODE_INDEX}"`);
  });

  it("statement 2 retires the link partial unique index idempotently", () => {
    const [, second] = statementsOf(readFileSync(MIGRATION_FILE, "utf8"));
    assert.equal(second, `DROP INDEX IF EXISTS "${RETIRED_LINK_INDEX}"`);
  });

  it("statement 3 creates the plain unique index on entityId, with IF NOT EXISTS and no predicate", () => {
    const [, , third] = statementsOf(readFileSync(MIGRATION_FILE, "utf8"));
    assert.equal(
      third,
      `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "${TABLE_NAME}"("entityId")`,
    );
    assert.doesNotMatch(third, /\bWHERE\b/i);
  });

  it("never uses CONCURRENTLY, data DML, ALTER TABLE, or pg_trgm", () => {
    const sql = readFileSync(MIGRATION_FILE, "utf8");
    assert.doesNotMatch(sql, /CONCURRENTLY/i);
    const executable = executableSql(sql);
    assert.doesNotMatch(executable, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    assert.doesNotMatch(executable, /\bALTER\s+TABLE\b/i);
    assert.doesNotMatch(sql, /pg_trgm/i);
    assert.doesNotMatch(executable, /supplierCouponId/);
  });

  it("no migration after this one recreates either retired index name", () => {
    const dirs = migrationDirs();
    const later = dirs.slice(dirs.indexOf(MIGRATION_DIR) + 1);
    for (const dir of later) {
      const sql = executableSql(readFileSync(join(MIGRATIONS_ROOT, dir, "migration.sql"), "utf8"));
      for (const retired of [RETIRED_CODE_INDEX, RETIRED_LINK_INDEX]) {
        assert.doesNotMatch(
          sql,
          new RegExp(`CREATE\\s+(UNIQUE\\s+)?INDEX[^;]*"${retired}"`, "i"),
          `${dir} recreates retired index ${retired}`,
        );
      }
    }
  });
});

describe("supplier coupon entity identity — schema", () => {
  it("entityId carries @unique on the field and the relation is unchanged", () => {
    const { body } = supplierCouponModel();
    assert.match(body, /^\s*entityId\s+String\?\s+@unique\s*$/m);
    assert.match(
      body,
      /^\s*entity\s+Entity\?\s+@relation\(fields: \[entityId\], references: \[id\], onDelete: SetNull\)\s*$/m,
    );
  });

  it("does not add a model-level unique on entityId or the deferred secondary key", () => {
    const { body } = supplierCouponModel();
    assert.doesNotMatch(body, /@@unique\(\[entityId\]\)/);
    assert.doesNotMatch(body, /@@unique\(\[supplierCampaignId, supplierCouponId\]\)/);
    assert.doesNotMatch(body, /@@unique\(/, "SupplierCoupon must carry no @@unique at all");
  });

  it("keeps the existing entityId index and the table mapping", () => {
    const { body } = supplierCouponModel();
    assert.match(body, /@@index\(\[entityId\]\)/);
    assert.match(body, /@@map\("supplier_coupons"\)/);
  });

  it("documents the invariant, the retired indexes, NULL semantics, and the deferred secondary key", () => {
    const { doc } = supplierCouponModel();
    assert.ok(doc.includes(INDEX_NAME), "doc must name the unique index");
    assert.ok(doc.includes(MIGRATION_DIR), "doc must name the migration directory");
    assert.match(doc, /one SupplierCoupon row per staged Entity/);
    assert.match(doc, /treats NULLs as distinct/);
    assert.ok(doc.includes(RETIRED_CODE_INDEX), "doc must name the retired code index");
    assert.ok(doc.includes(RETIRED_LINK_INDEX), "doc must name the retired link index");
    assert.match(doc, /must never be recreated/);
    assert.match(doc, /couponCode and couponLink are NOT identities/);
    assert.match(doc, /\(supplierCampaignId, supplierCouponId\) uniqueness is deliberately DEFERRED and NOT enforced/);
    assert.doesNotMatch(doc, /partial predicate exists|WHERE "entityId" IS NOT NULL/);
  });
});

describe("supplier coupon entity identity — Prisma diff parity", () => {
  it("the CREATE statement, minus IF NOT EXISTS, is exactly what Prisma 5.22 generates for entityId @unique", () => {
    // Offline schema-to-schema diff: no datasource is contacted. The "before" schema is the current
    // one with the @unique removed, so the diff must yield exactly the index this migration records.
    const schema = readFileSync(SCHEMA_FILE, "utf8");
    const before = schema.replace(/^(\s*entityId\s+String\?)\s+@unique\s*$/m, "$1");
    assert.notEqual(before, schema, "expected to strip exactly one @unique from entityId");

    const dir = mkdtempSync(join(tmpdir(), "supplier-coupon-identity-"));
    try {
      const beforePath = join(dir, "before.prisma");
      writeFileSync(beforePath, before);
      const cli = join(REPO_ROOT, "node_modules/prisma/build/index.js");
      assert.ok(existsSync(cli), "prisma CLI not installed");
      const run = spawnSync(
        process.execPath,
        [cli, "migrate", "diff", "--from-schema-datamodel", beforePath, "--to-schema-datamodel", SCHEMA_FILE, "--script"],
        { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" } },
      );
      assert.equal(run.status, 0, `prisma migrate diff failed: ${run.stderr}`);
      const generated = statementsOf(run.stdout);
      assert.deepEqual(generated, [`CREATE UNIQUE INDEX "${INDEX_NAME}" ON "${TABLE_NAME}"("entityId")`]);

      const [, , recorded] = statementsOf(readFileSync(MIGRATION_FILE, "utf8"));
      assert.equal(recorded.replace(" IF NOT EXISTS", ""), generated[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
