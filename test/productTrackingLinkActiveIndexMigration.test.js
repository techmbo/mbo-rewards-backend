import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS_ROOT = join(__dirname, "../prisma/migrations");
const MIGRATION_DIR = "20260926120000_product_tracking_links_one_active_per_client_product";
const MIGRATION_FILE = join(MIGRATIONS_ROOT, MIGRATION_DIR, "migration.sql");
const SCHEMA_FILE = join(__dirname, "../prisma/schema.prisma");

const INDEX_NAME = "product_tracking_links_clientId_productId_active_key";
const TABLE_NAME = "product_tracking_links";

/** Comments stripped so assertions target executable SQL only. */
function executableSql(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

describe("product tracking link ACTIVE partial unique index — recording migration", () => {
  it("sits between the mapper error retry migration and the supplier coupon identity migration", () => {
    assert.ok(existsSync(MIGRATION_FILE), `${MIGRATION_FILE} is missing`);
    const dirs = readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const index = dirs.indexOf(MIGRATION_DIR);
    assert.ok(index > 0, "migration directory not found among migrations");
    assert.equal(dirs[index - 1], "20260925120000_mapper_error_retry_started_at");
    assert.equal(dirs[index + 1], "20260927090000_supplier_coupons_entity_identity");
  });

  it("creates the partial unique index idempotently with the exact name, table, columns and predicate", () => {
    const sql = executableSql(readFileSync(MIGRATION_FILE, "utf8"));
    const statements = sql
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
    assert.equal(statements.length, 1, "the migration must contain exactly one statement");

    const [statement] = statements;
    const normalized = statement.replace(/\s+/g, " ");

    assert.match(normalized, /^CREATE UNIQUE INDEX IF NOT EXISTS /);
    assert.equal(
      normalized,
      `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "${TABLE_NAME}" ("clientId", "productId") WHERE "status" = 'ACTIVE'`,
    );
  });

  it("never uses CONCURRENTLY, which cannot run inside a Prisma migration transaction", () => {
    const sql = readFileSync(MIGRATION_FILE, "utf8");
    assert.doesNotMatch(sql, /CONCURRENTLY/i);
  });

  it("does not drop, alter or write anything", () => {
    const sql = executableSql(readFileSync(MIGRATION_FILE, "utf8"));
    assert.doesNotMatch(sql, /\b(DROP|ALTER|INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it("documents the invariant on the ProductTrackingLink model without a full @@unique", () => {
    const schema = readFileSync(SCHEMA_FILE, "utf8");
    const modelStart = schema.indexOf("model ProductTrackingLink {");
    assert.ok(modelStart > 0, "ProductTrackingLink model not found");
    const modelEnd = schema.indexOf("\n}\n", modelStart);
    const modelBody = schema.slice(modelStart, modelEnd);

    // The comment block is the run of /// lines immediately above the model.
    const before = schema.slice(0, modelStart);
    const commentLines = before
      .trimEnd()
      .split("\n")
      .reverse();
    const docBlock = [];
    for (const line of commentLines) {
      if (!line.startsWith("///")) break;
      docBlock.unshift(line);
    }
    const doc = docBlock.join("\n");

    assert.ok(doc.includes(INDEX_NAME), "schema comment must name the exact index");
    assert.match(doc, /one ACTIVE link per \(clientId, productId\)/);
    assert.match(doc, /Prisma 5\.22 cannot express a partial \(WHERE\) predicate/);
    assert.match(doc, /migration SQL only/);
    assert.match(doc, /never accept that removal/);
    assert.match(doc, new RegExp(MIGRATION_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    assert.doesNotMatch(modelBody, /@@unique\(\[clientId, productId\]\)/);
    assert.doesNotMatch(modelBody, /@@unique\(\[clientId, productId, status\]\)/);
    assert.match(modelBody, /@@map\("product_tracking_links"\)/);
  });
});
