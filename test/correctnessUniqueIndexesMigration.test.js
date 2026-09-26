import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = join(__dirname, "..");
const MIGRATIONS_ROOT = join(REPO_ROOT, "prisma/migrations");
const MIGRATION_DIR = "20260928090000_restore_correctness_unique_indexes";
const PREVIOUS_MIGRATION_DIR = "20260927090000_supplier_coupons_entity_identity";
const WAVE3_DIR = "20260713120000_wave3_client_distribution";
const WAVE5_DIR = "20260713140000_wave5_attribution_reporting";
const MIGRATION_FILE = join(MIGRATIONS_ROOT, MIGRATION_DIR, "migration.sql");
const SCHEMA_FILE = join(REPO_ROOT, "prisma/schema.prisma");

const ASSIGNMENT_INDEX = "client_campaign_assignments_client_campaign_active_key";
const REPORT_INDEX = "daily_reports_dimension_key";

const EXPECTED_ASSIGNMENT_STATEMENT =
  `CREATE UNIQUE INDEX IF NOT EXISTS "${ASSIGNMENT_INDEX}" ` +
  `ON "client_campaign_assignments"("clientId", "canonicalCampaignId") ` +
  `WHERE "status" IN ('ASSIGNED', 'ACTIVE', 'PAUSED')`;

const EXPECTED_REPORT_STATEMENT =
  `CREATE UNIQUE INDEX IF NOT EXISTS "${REPORT_INDEX}" ` +
  `ON "daily_reports"( "clientId", "canonicalCampaignId", ` +
  `COALESCE("campaignSourceId", ''), COALESCE("country", ''), "reportDate" )`;

/** Comments stripped so assertions target executable SQL only. */
function executableSql(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function normalize(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function statementsOf(sql) {
  return executableSql(sql)
    .split(";")
    .map((part) => normalize(part))
    .filter(Boolean);
}

function migrationDirs() {
  return readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function migrationSql(dir) {
  return readFileSync(join(MIGRATIONS_ROOT, dir, "migration.sql"), "utf8");
}

function modelWithDoc(modelName) {
  const schema = readFileSync(SCHEMA_FILE, "utf8");
  const header = `model ${modelName} {`;
  const modelStart = schema.indexOf(`\n${header}\n`) + 1;
  assert.ok(modelStart > 0, `${modelName} model not found`);
  const modelEnd = schema.indexOf("\n}\n", modelStart);
  const body = schema.slice(modelStart, modelEnd);
  const docLines = [];
  for (const line of schema.slice(0, modelStart).trimEnd().split("\n").reverse()) {
    if (!line.startsWith("///")) break;
    docLines.unshift(line);
  }
  return { body, doc: docLines.join("\n") };
}

describe("correctness unique indexes — recording migration", () => {
  it("exists and directly follows the supplier coupon entity identity migration", () => {
    assert.ok(existsSync(MIGRATION_FILE), `${MIGRATION_FILE} is missing`);
    const dirs = migrationDirs();
    const index = dirs.indexOf(MIGRATION_DIR);
    assert.ok(index > 0, "migration directory not found among migrations");
    assert.equal(dirs[index - 1], PREVIOUS_MIGRATION_DIR);
  });

  it("contains exactly two executable statements", () => {
    assert.equal(statementsOf(readFileSync(MIGRATION_FILE, "utf8")).length, 2);
  });

  it("statement 1 restores the partial unique index on active assignments with the exact predicate", () => {
    const [first] = statementsOf(readFileSync(MIGRATION_FILE, "utf8"));
    assert.equal(first, EXPECTED_ASSIGNMENT_STATEMENT);
    assert.match(first, /WHERE "status" IN \('ASSIGNED', 'ACTIVE', 'PAUSED'\)$/);
    const statuses = [...first.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(statuses, ["ASSIGNED", "ACTIVE", "PAUSED"]);
    assert.doesNotMatch(first, /REVOKED/);
  });

  it("statement 2 restores the expression unique index on daily_reports with the exact keys in order", () => {
    const [, second] = statementsOf(readFileSync(MIGRATION_FILE, "utf8"));
    assert.equal(second, EXPECTED_REPORT_STATEMENT);
    const keyList = second.slice(second.indexOf("(", second.indexOf('"daily_reports"')) + 1, second.lastIndexOf(")"));
    const keys = keyList.split(/,(?![^(]*\))/).map((k) => k.trim());
    assert.deepEqual(keys, [
      '"clientId"',
      '"canonicalCampaignId"',
      `COALESCE("campaignSourceId", '')`,
      `COALESCE("country", '')`,
      '"reportDate"',
    ]);
    assert.doesNotMatch(second, /\bWHERE\b/i);
  });

  it("never uses CONCURRENTLY, DROP, ALTER, data DML, or pg_trgm", () => {
    const sql = readFileSync(MIGRATION_FILE, "utf8");
    assert.doesNotMatch(sql, /CONCURRENTLY/i, "CONCURRENTLY must not appear anywhere, comments included");
    const executable = executableSql(sql);
    assert.doesNotMatch(executable, /\bDROP\b/i);
    assert.doesNotMatch(executable, /\bALTER\b/i);
    assert.doesNotMatch(executable, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    assert.doesNotMatch(sql, /pg_trgm/i);
  });

  it("creates no unrelated index", () => {
    const executable = executableSql(readFileSync(MIGRATION_FILE, "utf8"));
    const created = [...executable.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF NOT EXISTS)?\s+"([^"]+)"/gi)].map((m) => m[1]);
    assert.deepEqual(created, [ASSIGNMENT_INDEX, REPORT_INDEX]);
  });

  it("historical wave3 migration still carries the original assignment index definition", () => {
    const statements = statementsOf(migrationSql(WAVE3_DIR));
    const original = EXPECTED_ASSIGNMENT_STATEMENT.replace(" IF NOT EXISTS", "");
    assert.ok(statements.includes(original), "wave3 original CREATE UNIQUE INDEX not found or altered");
  });

  it("historical wave5 migration still carries the original daily_reports index definition", () => {
    const statements = statementsOf(migrationSql(WAVE5_DIR));
    const original = EXPECTED_REPORT_STATEMENT.replace(" IF NOT EXISTS", "");
    assert.ok(statements.includes(original), "wave5 original CREATE UNIQUE INDEX not found or altered");
  });

  it("no migration, of any date, drops either correctness index", () => {
    for (const dir of migrationDirs()) {
      const executable = executableSql(migrationSql(dir));
      for (const name of [ASSIGNMENT_INDEX, REPORT_INDEX]) {
        assert.doesNotMatch(
          executable,
          new RegExp(`DROP\\s+INDEX[^;]*"${name}"`, "i"),
          `${dir} drops correctness index ${name}`,
        );
      }
    }
  });
});

describe("correctness unique indexes — schema documentation", () => {
  it("ClientCampaignAssignment declares no plain @@unique replacement and documents the partial index", () => {
    const { body, doc } = modelWithDoc("ClientCampaignAssignment");
    assert.doesNotMatch(body, /@@unique\(/, "ClientCampaignAssignment must carry no @@unique");
    assert.ok(doc.includes(ASSIGNMENT_INDEX), "doc must name the restored index");
    assert.ok(doc.includes(MIGRATION_DIR), "doc must name the restoring migration");
    assert.match(doc, /at most one non-revoked assignment/);
    assert.match(doc, /status IN \('ASSIGNED', 'ACTIVE', 'PAUSED'\)/);
    assert.match(doc, /REVOKED rows intentionally do[\s\S]*not participate/);
    assert.match(doc, /Prisma cannot express a[\s\S]*partial unique index/);
    assert.match(doc, /never replace it with a plain @@unique\(\[clientId, canonicalCampaignId\]\)/);
  });

  it("DailyReport declares no plain @@unique replacement and documents the expression index", () => {
    const { body, doc } = modelWithDoc("DailyReport");
    assert.doesNotMatch(body, /@@unique\(/, "DailyReport must carry no @@unique");
    assert.ok(doc.includes(REPORT_INDEX), "doc must name the restored index");
    assert.ok(doc.includes(MIGRATION_DIR), "doc must name the restoring migration");
    assert.match(doc, /one row per reporting dimension/);
    assert.match(doc, /COALESCE\(campaignSourceId, ''\), COALESCE\(country, ''\), reportDate/);
    assert.match(doc, /Prisma cannot express an expression index/);
    assert.match(doc, /plain @@unique over the nullable columns is not equivalent/);
  });
});
