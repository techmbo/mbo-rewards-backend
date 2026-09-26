import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = join(__dirname, "..");
const MIGRATIONS_ROOT = join(REPO_ROOT, "prisma/migrations");
const MIGRATION_DIR = "20260929090000_align_performance_index_expectations";
const PREVIOUS_MIGRATION_DIR = "20260928090000_restore_correctness_unique_indexes";
const WAVE11_DIR = "20260710153000_wave1_1_performance_indexes";
const MIGRATION_FILE = join(MIGRATIONS_ROOT, MIGRATION_DIR, "migration.sql");
const SCHEMA_FILE = join(REPO_ROOT, "prisma/schema.prisma");

/** Exact drop order: eight permanently retired, then four deferred pending measurement. */
const RETIRED = [
  "supplier_campaigns_supplier_campaignStatus_lastSyncedAt_idx",
  "supplier_coupons_couponEndDate_idx",
  "merchant_aliases_aliasValue_trgm_idx",
  "merchants_normalizedName_trgm_idx",
  "clients_name_trgm_idx",
  "clicks_clickedAt_brin_idx",
  "conversions_conversionDate_brin_idx",
  "conversions_clickId_idx",
];
const DEFERRED = [
  "supplier_campaigns_campaignName_trgm_idx",
  "supplier_campaigns_merchantNameRaw_trgm_idx",
  "merchants_displayName_trgm_idx",
  "canonical_campaigns_displayName_trgm_idx",
];
const EXPECTED_DROPS = [...RETIRED, ...DEFERRED];

/** The seven historical gin_trgm_ops indexes, the only pg_trgm dependents in migration history. */
const TRIGRAM_INDEXES = [
  "supplier_campaigns_campaignName_trgm_idx",
  "supplier_campaigns_merchantNameRaw_trgm_idx",
  "merchant_aliases_aliasValue_trgm_idx",
  "merchants_displayName_trgm_idx",
  "merchants_normalizedName_trgm_idx",
  "canonical_campaigns_displayName_trgm_idx",
  "clients_name_trgm_idx",
];

/** Where each of the twelve was originally created. */
const HISTORICAL_HOME = {
  supplier_campaigns_campaignName_trgm_idx: WAVE11_DIR,
  supplier_campaigns_merchantNameRaw_trgm_idx: WAVE11_DIR,
  supplier_campaigns_supplier_campaignStatus_lastSyncedAt_idx: WAVE11_DIR,
  supplier_coupons_couponEndDate_idx: WAVE11_DIR,
  merchants_displayName_trgm_idx: "20260710160000_wave2_merchant_intelligence",
  merchants_normalizedName_trgm_idx: "20260710160000_wave2_merchant_intelligence",
  merchant_aliases_aliasValue_trgm_idx: "20260710160000_wave2_merchant_intelligence",
  canonical_campaigns_displayName_trgm_idx: "20260713110000_wave2b_catalog_intelligence",
  clients_name_trgm_idx: "20260713120000_wave3_client_distribution",
  clicks_clickedAt_brin_idx: "20260713140000_wave5_attribution_reporting",
  conversions_conversionDate_brin_idx: "20260713140000_wave5_attribution_reporting",
  conversions_clickId_idx: "20260713140000_wave5_attribution_reporting",
};

const DOCUMENTED_MODELS = ["SupplierCampaign", "Merchant", "CanonicalCampaign", "Conversion", "Click"];

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

function migrationSql(dir) {
  return readFileSync(join(MIGRATIONS_ROOT, dir, "migration.sql"), "utf8");
}

function createdIndexNames(sql) {
  return [...executableSql(sql).matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF NOT EXISTS)?\s+"([^"]+)"/gi)].map(
    (m) => m[1],
  );
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
  // `doc` is the comment block as one line of prose so phrases wrapped across /// lines still match.
  const doc = docLines.map((line) => line.replace(/^\/\/\/\s?/, "")).join(" ").replace(/\s+/g, " ");
  return { schema, body, doc };
}

describe("performance index alignment — migration", () => {
  it("exists and directly follows the correctness unique index migration", () => {
    assert.ok(existsSync(MIGRATION_FILE), `${MIGRATION_FILE} is missing`);
    const dirs = migrationDirs();
    const index = dirs.indexOf(MIGRATION_DIR);
    assert.ok(index > 0, "migration directory not found among migrations");
    assert.equal(dirs[index - 1], PREVIOUS_MIGRATION_DIR);
  });

  it("contains exactly thirteen executable statements", () => {
    assert.equal(statementsOf(readFileSync(MIGRATION_FILE, "utf8")).length, 13);
  });

  it("statements 1-12 are DROP INDEX IF EXISTS of exactly the twelve expected names, in order, without duplicates", () => {
    const statements = statementsOf(readFileSync(MIGRATION_FILE, "utf8"));
    const drops = statements.slice(0, 12);
    const names = drops.map((statement) => {
      const match = statement.match(/^DROP INDEX IF EXISTS "([^"]+)"$/);
      assert.ok(match, `not a plain DROP INDEX IF EXISTS: ${statement}`);
      return match[1];
    });
    assert.deepEqual(names, EXPECTED_DROPS);
    assert.equal(new Set(names).size, 12, "duplicate index names in the drop set");
    for (const statement of drops) assert.doesNotMatch(statement, /EXTENSION/i);
  });

  it("statement 13 is DROP EXTENSION IF EXISTS pg_trgm and it is last", () => {
    const statements = statementsOf(readFileSync(MIGRATION_FILE, "utf8"));
    assert.equal(statements[12], "DROP EXTENSION IF EXISTS pg_trgm");
    assert.equal(statements.length - 1, 12, "the extension drop must be the final statement");
    assert.equal(statements.filter((s) => /EXTENSION/i.test(s)).length, 1);
  });

  it("all seven historical gin_trgm_ops indexes are in the drop set, before the extension drop", () => {
    for (const name of TRIGRAM_INDEXES) {
      const position = EXPECTED_DROPS.indexOf(name);
      assert.ok(position >= 0 && position < 12, `${name} must be dropped before DROP EXTENSION`);
    }
  });

  it("never uses CASCADE, CONCURRENTLY, CREATE, ALTER, or data DML", () => {
    const sql = readFileSync(MIGRATION_FILE, "utf8");
    assert.doesNotMatch(sql, /CASCADE/i, "CASCADE must not appear anywhere, comments included");
    assert.doesNotMatch(sql, /CONCURRENTLY/i, "CONCURRENTLY must not appear anywhere, comments included");
    const executable = executableSql(sql);
    assert.doesNotMatch(executable, /\bCREATE\b/i);
    assert.doesNotMatch(executable, /\bALTER\b/i);
    assert.doesNotMatch(executable, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it("describes the four deferred indexes as deferred pending measurement, never as obsolete", () => {
    const sql = readFileSync(MIGRATION_FILE, "utf8");
    assert.match(sql, /DEFERRED PENDING MEASUREMENT/);
    assert.match(sql, /PERMANENTLY RETIRED/);
    assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pg_trgm;/, "comments must name the forward path");
    assert.match(sql, /EXPLAIN/);
    assert.match(sql, /pg_stat_statements/);
    // The word may appear only in a negation ("not obsolete").
    for (const match of sql.matchAll(/obsolete/gi)) {
      const before = sql.slice(Math.max(0, match.index - 8), match.index);
      assert.match(before, /not\s+$/i, `deferred indexes must not be called obsolete: "...${before}obsolete"`);
    }
  });
});

describe("performance index alignment — history guards", () => {
  it("every one of the twelve still has its original CREATE INDEX in its historical migration", () => {
    for (const [name, dir] of Object.entries(HISTORICAL_HOME)) {
      assert.ok(createdIndexNames(migrationSql(dir)).includes(name), `${dir} no longer creates ${name}`);
    }
  });

  it("wave1_1 still contains CREATE EXTENSION IF NOT EXISTS pg_trgm", () => {
    const statements = statementsOf(migrationSql(WAVE11_DIR));
    assert.ok(statements.includes("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  });

  it("the seven trigram indexes and the wave1_1 extension statement are the only pg_trgm dependents in history", () => {
    const dependentPattern = /gin_trgm_ops|gist_trgm_ops|\bsimilarity\s*\(|word_similarity|show_trgm|set_limit\s*\(|show_limit|<->|<<->|<->>|\s%>\s|\s<%\s/i;
    const extensionPattern = /\bEXTENSION\b/i;
    const seen = new Set();
    for (const dir of migrationDirs()) {
      for (const statement of statementsOf(migrationSql(dir))) {
        if (extensionPattern.test(statement)) {
          const allowed =
            (dir === WAVE11_DIR && statement === "CREATE EXTENSION IF NOT EXISTS pg_trgm") ||
            (dir === MIGRATION_DIR && statement === "DROP EXTENSION IF EXISTS pg_trgm");
          assert.ok(allowed, `unexpected extension statement in ${dir}: ${statement}`);
          continue;
        }
        if (!dependentPattern.test(statement)) continue;
        const created = statement.match(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF NOT EXISTS)?\s+"([^"]+)"/i);
        assert.ok(created, `pg_trgm-dependent statement that is not one of the seven indexes in ${dir}: ${statement}`);
        assert.ok(TRIGRAM_INDEXES.includes(created[1]), `unexpected pg_trgm-dependent index ${created[1]} in ${dir}`);
        seen.add(created[1]);
      }
      assert.doesNotMatch(executableSql(migrationSql(dir)), /USING\s+gist/i, `${dir} uses a GiST index`);
    }
    assert.deepEqual([...seen].sort(), [...TRIGRAM_INDEXES].sort());
  });

  it("no migration after this one recreates any of the twelve indexes or pg_trgm", () => {
    const dirs = migrationDirs();
    for (const dir of dirs.slice(dirs.indexOf(MIGRATION_DIR) + 1)) {
      const sql = migrationSql(dir);
      for (const name of EXPECTED_DROPS) {
        assert.ok(!createdIndexNames(sql).includes(name), `${dir} recreates retired/deferred index ${name}`);
      }
      assert.doesNotMatch(executableSql(sql), /CREATE\s+EXTENSION[^;]*pg_trgm/i, `${dir} reinstalls pg_trgm`);
    }
  });
});

describe("performance index alignment — schema documentation", () => {
  it("schema declares no PostgreSQL extension and no GIN/GiST index types", () => {
    const schema = readFileSync(SCHEMA_FILE, "utf8");
    // Attribute lines only: the /// documentation blocks may mention pg_trgm as the forward path.
    const attributes = schema
      .split("\n")
      .filter((line) => !line.trim().startsWith("///"))
      .join("\n");
    assert.doesNotMatch(attributes, /postgresqlExtensions/);
    assert.doesNotMatch(attributes, /^\s*extensions\s*=/m);
    assert.doesNotMatch(attributes, /type:\s*(Gin|Gist)\b/);
    assert.doesNotMatch(attributes, /pg_trgm/);
    assert.doesNotMatch(attributes, /trgm/);
  });

  it("each documented model names the alignment migration and keeps its attributes", () => {
    for (const model of DOCUMENTED_MODELS) {
      const { doc, body } = modelWithDoc(model);
      assert.ok(doc.includes(MIGRATION_DIR), `${model} doc must name the alignment migration`);
      assert.match(doc, /PERFORMANCE NOTE/, `${model} doc must be a performance note`);
      assert.doesNotMatch(body, /@@index\(\[clickId\]\)/, `${model} must not gain @@index([clickId]) here`);
    }
  });

  it("deferred indexes are described as deferred pending measurement, not permanently obsolete", () => {
    const deferredByModel = {
      SupplierCampaign: ["supplier_campaigns_campaignName_trgm_idx", "supplier_campaigns_merchantNameRaw_trgm_idx"],
      Merchant: ["merchants_displayName_trgm_idx"],
      CanonicalCampaign: ["canonical_campaigns_displayName_trgm_idx"],
    };
    for (const [model, names] of Object.entries(deferredByModel)) {
      const { doc } = modelWithDoc(model);
      for (const name of names) assert.ok(doc.includes(name), `${model} doc must name ${name}`);
      assert.match(doc, /DEFERRED PENDING MEASUREMENT/);
      assert.match(doc, /not obsolete/);
      assert.match(doc, /pg_trgm/);
    }
    const conversion = modelWithDoc("Conversion").doc;
    assert.ok(conversion.includes("conversions_conversionDate_brin_idx"));
    assert.ok(conversion.includes("conversions_clickId_idx"));
    assert.match(conversion, /add @@index\(\[clickId\]\)/);
    const click = modelWithDoc("Click").doc;
    assert.ok(click.includes("clicks_clickedAt_brin_idx"));
  });
});
