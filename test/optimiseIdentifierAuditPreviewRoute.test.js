/**
 * TEMPORARY preview-only, READ-ONLY Optimise persisted-identifier audit route.
 *
 * These prove the GATE, the read-only statement set, the allowlist projection,
 * and — against a real Postgres inside a rolled-back transaction — the
 * campaignId/campaign_id fallback and the both-present-and-different
 * disagreement semantics. Nothing here calls a supplier.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CERTIFICATION_TOKEN_HEADER } from "../src/routes/internal/optimiseCertificationPreview.js";
import {
  AUDIT_SQL,
  AUDITED_SUPPLIER,
  IDENTIFIER_ROW_FIELDS,
  LIVE_CERTIFIED_CAMPAIGN_ID,
  LIVE_CERTIFIED_PRODUCT_ID,
  PREVIEW_IDENTIFIER_AUDIT_ROUTE,
  SAMPLE_ROW_LIMIT,
  assertReadOnlySql,
  createOptimiseIdentifierAuditPreviewHandler,
  projectIdentifierRow,
} from "../src/routes/internal/optimiseIdentifierAuditPreview.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_PATH = path.join(here, "..", "src", "routes", "internal", "optimiseIdentifierAuditPreview.js");
const ROUTER_PATH = path.join(here, "..", "src", "routes", "index.js");
const PRISMA_MODULE_PATH = path.join(here, "..", "src", "database", "prisma.js");

const REAL_TOKEN = "temporary-certification-token-value";
const previewEnv = { VERCEL_ENV: "preview", CERTIFICATION_TOKEN: REAL_TOKEN };
const NOT_FOUND = { ok: false, message: "Not found." };

// Values that must never appear in any response body.
const LEAKED_HOST = "db.internal.example";
const LEAKED_CONNECTION = `postgresql://ci:s3cret-pw@${LEAKED_HOST}:5432/prod`;
const LEAKED_PASSWORD = "s3cret-pw";
const LEAKED_API_KEY = "LEAKED-API-KEY-VALUE";
const LEAKED_TRACKING_URL = "https://track.example/click?campaign=1";

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

function sqlKeyOf(sql) {
  return Object.keys(AUDIT_SQL).find((key) => AUDIT_SQL[key] === sql) ?? null;
}

/**
 * A fake executor keyed by statement. Records loads and every statement
 * executed so tests can prove exactly what the handler asked the database for.
 */
function fakeDatabase({
  supplierCampaignsPresent = true,
  supplierCommissionRulesPresent = true,
  rows = {},
  failWith = null,
} = {}) {
  const calls = { loads: 0, executed: [] };

  const canned = {
    supplierCampaignsPresent: [{ present: supplierCampaignsPresent }],
    supplierCommissionRulesPresent: [{ present: supplierCommissionRulesPresent }],
    overallCounts: [
      {
        total_rows: 7n,
        raw_id_present: 7n,
        raw_campaign_id_present: 5n,
        raw_product_id_present: 6n,
        all_three_present: 4n,
        raw_campaign_id_missing: 2n,
        raw_product_id_missing: 1n,
      },
    ],
    namespaceDisagreements: [
      {
        id_campaign_id_both_present: 5,
        id_campaign_id_differ: 3,
        id_product_id_both_present: 6,
        id_product_id_differ: 4,
        campaign_id_product_id_both_present: 4,
        campaign_id_product_id_differ: 2,
      },
    ],
    supplierCampaignIdLineage: [
      {
        id_matches: 7,
        id_differs: 0,
        id_raw_missing: 0,
        campaign_id_matches: 2,
        campaign_id_differs: 3,
        campaign_id_raw_missing: 2,
        product_id_matches: 2,
        product_id_differs: 4,
        product_id_raw_missing: 1,
      },
    ],
    sampleRows: [
      {
        supplierCampaignId: "9001",
        supplierRegion: "SEA",
        sourceAccountLabel: "default",
        raw_id: "9001",
        raw_campaign_id: "7001",
        raw_product_id: "5001",
        // Everything below must be dropped by the allowlist projection.
        rawPayload: { apiKey: LEAKED_API_KEY, trackingURL: LEAKED_TRACKING_URL },
        trackingUrl: LEAKED_TRACKING_URL,
        password: LEAKED_PASSWORD,
        connection: LEAKED_CONNECTION,
        DATABASE_URL: LEAKED_CONNECTION,
        merchantNameRaw: "Some Merchant",
      },
      { supplierCampaignId: "9002", supplierRegion: "SEA", sourceAccountLabel: "default", raw_id: 9002, raw_campaign_id: null, raw_product_id: undefined },
    ],
    liveCertifiedRows: [
      {
        supplierCampaignId: "9003",
        supplierRegion: "SEA",
        sourceAccountLabel: "default",
        raw_id: "9003",
        raw_campaign_id: LIVE_CERTIFIED_CAMPAIGN_ID,
        raw_product_id: LIVE_CERTIFIED_PRODUCT_ID,
        rawPayload: { apiKey: LEAKED_API_KEY },
      },
    ],
    commissionRuleLinkage: [
      {
        total_rules: 11n,
        unlinked_rules: 2n,
        rules_linked_to_optimise_campaigns: 9n,
        linked_scid_differs_from_raw_campaign_id: 6n,
        linked_scid_differs_from_raw_product_id: 7n,
      },
    ],
    ...rows,
  };

  return {
    calls,
    load: async () => {
      calls.loads += 1;
      return {
        query: async (sql) => {
          calls.executed.push(sql);
          if (failWith) throw failWith;
          const key = sqlKeyOf(sql);
          assert.ok(key, "the handler executed a statement that is not one of the audit constants");
          return canned[key];
        },
      };
    },
  };
}

async function invoke({ env, headers = {}, db = fakeDatabase() }) {
  const handler = createOptimiseIdentifierAuditPreviewHandler({ env, loadDependencies: db.load });
  const res = mockRes();
  let nextError = null;
  await handler({ headers, body: {}, query: {} }, res, (error) => {
    nextError = error;
  });
  return { res, db, nextError };
}

function walk(value, visit, keyPath = []) {
  visit(value, keyPath);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, [...keyPath, String(index)]));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) walk(child, visit, [...keyPath, key]);
  }
}

function collectKeys(value) {
  const keys = new Set();
  walk(value, (node) => {
    if (node && typeof node === "object" && !Array.isArray(node)) Object.keys(node).forEach((key) => keys.add(key));
  });
  return keys;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

test("production / non-preview runtime: 404 and the database layer is never loaded", async () => {
  for (const vercelEnv of ["production", "development", undefined, "", "Preview", "PREVIEW"]) {
    const { res, db } = await invoke({
      env: { VERCEL_ENV: vercelEnv, CERTIFICATION_TOKEN: REAL_TOKEN },
      headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN },
    });

    assert.equal(res.statusCode, 404, `VERCEL_ENV=${vercelEnv} must 404`);
    assert.deepEqual(res.body, NOT_FOUND);
    assert.equal(db.calls.loads, 0, "database dependency not loaded");
    assert.equal(db.calls.executed.length, 0, "no statement executed");
  }
});

test("preview runtime without a token header: identical 404, database never loaded", async () => {
  const { res, db } = await invoke({ env: previewEnv, headers: {} });

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, NOT_FOUND);
  assert.equal(db.calls.loads, 0);
  assert.equal(db.calls.executed.length, 0);
});

test("preview runtime with a wrong token: identical 404, database never loaded", async () => {
  for (const wrong of ["nope", `${REAL_TOKEN}x`, REAL_TOKEN.slice(0, -1), REAL_TOKEN.toUpperCase(), "", " "]) {
    const { res, db } = await invoke({ env: previewEnv, headers: { [CERTIFICATION_TOKEN_HEADER]: wrong } });

    assert.equal(res.statusCode, 404, `token "${wrong.slice(0, 4)}…" must 404`);
    assert.deepEqual(res.body, NOT_FOUND, "the wrong-token body is byte-identical to the no-token body");
    assert.equal(db.calls.loads, 0);
    assert.equal(db.calls.executed.length, 0);
  }
});

test("preview runtime with no CERTIFICATION_TOKEN configured: identical 404, database never loaded", async () => {
  for (const env of [{ VERCEL_ENV: "preview" }, { VERCEL_ENV: "preview", CERTIFICATION_TOKEN: "" }]) {
    const { res, db } = await invoke({ env, headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN } });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, NOT_FOUND);
    assert.equal(db.calls.loads, 0);
  }
});

test("the gate is the certification route's gate, not a copy", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf8");

  assert.match(
    source,
    /import \{\s*CERTIFICATION_TOKEN_HEADER,\s*isPreviewRuntime,\s*tokenMatches,?\s*\} from "\.\/optimiseCertificationPreview\.js"/,
    "isPreviewRuntime, tokenMatches and the header name are imported from the certification route",
  );
  assert.ok(!/timingSafeEqual|createHash/.test(source), "no second token comparison is implemented here");
  assert.ok(!/\.VERCEL_ENV\b/.test(source), "VERCEL_ENV is never read here; the imported isPreviewRuntime is the only runtime check");
});

// ---------------------------------------------------------------------------
// Database dependency is not loaded before the gate
// ---------------------------------------------------------------------------

test("statically: the only top-level import is the certification gate; Prisma is reached only via a dynamic import", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf8");

  const staticImports = [...source.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
  assert.deepEqual(staticImports, ["./optimiseCertificationPreview.js"], "exactly one static import");

  assert.ok(!/@prisma\/client/.test(source), "no direct @prisma/client reference");
  const prismaReferences = source.match(/database\/prisma\.js/g) ?? [];
  assert.equal(prismaReferences.length, 1, "the prisma module is referenced exactly once");
  assert.match(source, /await import\("\.\.\/\.\.\/database\/prisma\.js"\)/, "and that reference is a dynamic import");

  // The dynamic import sits inside loadDefaultDependencies, which the handler
  // calls only after both gates.
  const gateIndex = source.indexOf("if (!isPreviewRuntime(env)) return notFound(res);");
  const loadIndex = source.indexOf("await loadDependencies()");
  assert.ok(gateIndex > 0 && loadIndex > gateIndex, "dependencies are loaded after the runtime gate in the handler body");
});

test("at runtime: importing the route module does not load Prisma (loader-hook proof in a child process)", () => {
  const hook = `
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.includes("@prisma/client") || result.url.includes("/database/prisma.js") || result.url.includes("/.prisma/")) {
    throw new Error("PRISMA_LOADED:" + specifier);
  }
  return result;
}`;
  const script = `
import { register } from "node:module";
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});
await import(process.env.AUDIT_ROUTE_URL);
console.log("ROUTE_IMPORTED_WITHOUT_PRISMA");
try {
  await import(process.env.AUDIT_PRISMA_URL);
  console.log("CONTROL_FAILED");
} catch (error) {
  console.log(String(error?.message).startsWith("PRISMA_LOADED:") ? "CONTROL_OK" : "CONTROL_FAILED:" + error?.message);
}`;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      AUDIT_ROUTE_URL: pathToFileURL(ROUTE_PATH).href,
      AUDIT_PRISMA_URL: pathToFileURL(PRISMA_MODULE_PATH).href,
    },
  });

  assert.match(output, /ROUTE_IMPORTED_WITHOUT_PRISMA/, "the route module loads without resolving Prisma");
  assert.match(output, /CONTROL_OK/, "the hook demonstrably intercepts a real Prisma import");
});

// ---------------------------------------------------------------------------
// SQL is SELECT / CTE only
// ---------------------------------------------------------------------------

test("every audit statement is a single SELECT or WITH statement with no data-modifying keyword", () => {
  const forbidden =
    /\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|EXECUTE|SET|LOCK|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|COMMENT|DO|INTO|RETURNING)\b/i;

  assert.equal(Object.keys(AUDIT_SQL).length, 8, "eight statements: presence checks, A–F, rule presence, rule linkage");
  assert.ok(Object.isFrozen(AUDIT_SQL), "the statement set cannot be mutated at runtime");

  for (const [key, sql] of Object.entries(AUDIT_SQL)) {
    assert.match(sql, /^\s*(WITH|SELECT)\b/, `${key} starts with SELECT or WITH`);
    assert.ok(!sql.includes(";"), `${key} is a single statement`);
    assert.ok(!sql.includes("--") && !sql.includes("/*"), `${key} has no comments`);
    assert.ok(!forbidden.test(sql), `${key} has no forbidden keyword`);
    assert.equal(assertReadOnlySql(sql), sql, `${key} passes the runtime guard`);
    assert.ok(!/\$\d/.test(sql), `${key} takes no parameters (nothing from the request reaches it)`);
  }
});

test("the runtime guard rejects writes, DDL, multi-statement and comment tricks", () => {
  const rejected = [
    "UPDATE supplier_campaigns SET x = 1",
    "DELETE FROM supplier_campaigns",
    "INSERT INTO supplier_campaigns DEFAULT VALUES",
    "DROP TABLE supplier_campaigns",
    "ALTER TABLE supplier_campaigns ADD COLUMN x int",
    "TRUNCATE supplier_campaigns",
    "CREATE TABLE x (id int)",
    "SELECT 1; DELETE FROM supplier_campaigns",
    "WITH d AS (DELETE FROM supplier_campaigns RETURNING id) SELECT * FROM d",
    "WITH u AS (UPDATE supplier_campaigns SET x = 1 RETURNING id) SELECT count(*) FROM u",
    "SELECT * INTO copy_table FROM supplier_campaigns",
    "SELECT 1 -- ; DROP TABLE supplier_campaigns",
    "SELECT 1 /* DROP TABLE supplier_campaigns */",
    "EXPLAIN SELECT 1",
    "SET search_path TO public",
    "DO $$ BEGIN END $$",
    "",
    null,
    undefined,
    42,
  ];
  for (const sql of rejected) {
    assert.throws(() => assertReadOnlySql(sql), `must reject: ${String(sql).slice(0, 40)}`);
  }

  assert.equal(assertReadOnlySql("SELECT 1"), "SELECT 1");
  assert.equal(assertReadOnlySql("  with x as (select 1) select * from x"), "  with x as (select 1) select * from x");
});

test("the statements encode the required semantics", () => {
  for (const key of ["overallCounts", "namespaceDisagreements", "supplierCampaignIdLineage", "sampleRows", "liveCertifiedRows", "commissionRuleLinkage"]) {
    const sql = AUDIT_SQL[key];
    assert.match(sql, /FROM supplier_campaigns/, `${key} reads supplier_campaigns`);
    assert.match(sql, new RegExp(`supplier::text = '${AUDITED_SUPPLIER}'`), `${key} is scoped to ${AUDITED_SUPPLIER}`);
    // campaignId falls back to campaign_id, in that order.
    assert.match(
      sql,
      /COALESCE\(\s*NULLIF\(btrim\(sc\."rawPayload"->>'campaignId'\), ''\),\s*NULLIF\(btrim\(sc\."rawPayload"->>'campaign_id'\), ''\)\s*\)/,
      `${key} supports rawPayload.campaignId and rawPayload.campaign_id`,
    );
    assert.ok(!/IS DISTINCT FROM/i.test(sql), `${key} does not use IS DISTINCT FROM`);
    assert.ok(!/"rawPayload"\s+AS|"rawPayload",|"rawPayload"\s*$/m.test(sql), `${key} never selects the raw payload itself`);
    assert.ok(!/trackingUrl|destinationUrl|merchantNameRaw|password|DATABASE_URL/.test(sql), `${key} selects no URL, name or credential column`);
  }

  // Every disagreement is guarded by both-present predicates.
  const disagreementPairs = [
    ["raw_id", "raw_campaign_id"],
    ["raw_id", "raw_product_id"],
    ["raw_campaign_id", "raw_product_id"],
  ];
  for (const [left, right] of disagreementPairs) {
    const guarded = new RegExp(`${left} IS NOT NULL AND ${right} IS NOT NULL AND ${left} <> ${right}`);
    assert.match(AUDIT_SQL.namespaceDisagreements, guarded, `${left} vs ${right} requires both present`);
    assert.match(AUDIT_SQL.sampleRows, guarded, `sample ordering uses the same both-present predicate`);
  }
  // Lineage "differs" is likewise guarded by presence; "raw missing" is its own bucket.
  for (const ns of ["raw_id", "raw_campaign_id", "raw_product_id"]) {
    assert.match(AUDIT_SQL.supplierCampaignIdLineage, new RegExp(`${ns} IS NOT NULL AND scid = ${ns}`));
    assert.match(AUDIT_SQL.supplierCampaignIdLineage, new RegExp(`${ns} IS NOT NULL AND scid <> ${ns}`));
    assert.match(AUDIT_SQL.supplierCampaignIdLineage, new RegExp(`WHERE ${ns} IS NULL\\)`));
  }

  assert.match(AUDIT_SQL.sampleRows, new RegExp(`LIMIT ${SAMPLE_ROW_LIMIT}$`));
  assert.equal(SAMPLE_ROW_LIMIT, 25);
  assert.match(AUDIT_SQL.liveCertifiedRows, /\('57316', '7340528'\)/);
  assert.equal(LIVE_CERTIFIED_PRODUCT_ID, "57316");
  assert.equal(LIVE_CERTIFIED_CAMPAIGN_ID, "7340528");
  assert.match(AUDIT_SQL.supplierCommissionRulesPresent, /to_regclass\('public\.supplier_commission_rules'\)/);
  assert.match(AUDIT_SQL.commissionRuleLinkage, /FROM supplier_commission_rules r/);
  assert.match(AUDIT_SQL.commissionRuleLinkage, /JOIN oc ON oc\.row_id = rules\.campaign_row_id/, "rules join campaigns by the row FK");
});

// ---------------------------------------------------------------------------
// Handler behaviour with an injected executor
// ---------------------------------------------------------------------------

test("valid token: runs exactly the audit constants, in order, each through the read-only guard", async () => {
  const { res, db, nextError } = await invoke({ env: previewEnv, headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN } });

  assert.equal(nextError, null);
  assert.equal(res.statusCode, 200);
  assert.equal(db.calls.loads, 1, "the database layer is loaded once, after the gate");
  assert.deepEqual(
    db.calls.executed.map(sqlKeyOf),
    [
      "supplierCampaignsPresent",
      "overallCounts",
      "namespaceDisagreements",
      "supplierCampaignIdLineage",
      "sampleRows",
      "liveCertifiedRows",
      "supplierCommissionRulesPresent",
      "commissionRuleLinkage",
    ],
  );
  for (const sql of db.calls.executed) assert.equal(assertReadOnlySql(sql), sql);
  assert.equal(res.body.meta.statementsExecuted, 8);
  assert.equal(res.body.meta.writesPerformed, 0);
  assert.equal(res.body.meta.supplierApiCalls, 0);
  assert.equal(res.body.meta.readOnly, true);
  assert.equal(res.body.meta.supplier, "OPTIMISE");
  assert.equal(res.body.meta.supplierCampaignsPresent, true);
  assert.deepEqual(res.body.meta.campaignIdSources, ["rawPayload.campaignId", "rawPayload.campaign_id"]);
});

test("valid token: the six result sets are shaped as specified, BigInt counts become numbers", async () => {
  const { res } = await invoke({ env: previewEnv, headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN } });

  assert.deepEqual(res.body.overallCounts, {
    totalRows: 7,
    rawIdPresent: 7,
    rawCampaignIdPresent: 5,
    rawProductIdPresent: 6,
    allThreePresent: 4,
    rawCampaignIdMissing: 2,
    rawProductIdMissing: 1,
  });
  assert.deepEqual(res.body.namespaceDisagreements, {
    idVsCampaignId: { bothPresent: 5, differ: 3 },
    idVsProductId: { bothPresent: 6, differ: 4 },
    campaignIdVsProductId: { bothPresent: 4, differ: 2 },
  });
  assert.deepEqual(res.body.supplierCampaignIdLineage, {
    id: { matches: 7, differs: 0, rawMissing: 0 },
    campaignId: { matches: 2, differs: 3, rawMissing: 2 },
    productId: { matches: 2, differs: 4, rawMissing: 1 },
  });
  assert.deepEqual(res.body.sampleRows, [
    { supplierCampaignId: "9001", supplierRegion: "SEA", sourceAccountLabel: "default", raw_id: "9001", raw_campaign_id: "7001", raw_product_id: "5001" },
    { supplierCampaignId: "9002", supplierRegion: "SEA", sourceAccountLabel: "default", raw_id: "9002", raw_campaign_id: null, raw_product_id: null },
  ]);
  assert.deepEqual(res.body.liveCertifiedIdentifiers, {
    productId: "57316",
    campaignId: "7340528",
    rows: [{ supplierCampaignId: "9003", supplierRegion: "SEA", sourceAccountLabel: "default", raw_id: "9003", raw_campaign_id: "7340528", raw_product_id: "57316" }],
  });
  assert.deepEqual(res.body.commissionRuleLinkage, {
    supplierCommissionRulesPresent: true,
    totalRules: 11,
    unlinkedRules: 2,
    rulesLinkedToOptimiseCampaigns: 9,
    linkedSupplierCampaignIdDiffersFromRawCampaignId: 6,
    linkedSupplierCampaignIdDiffersFromRawProductId: 7,
  });

  // JSON-serializable end to end (no BigInt survives).
  assert.doesNotThrow(() => JSON.stringify(res.body));
  walk(res.body, (node) => assert.notEqual(typeof node, "bigint"));
});

test("the response contains no rawPayload object, no credential, no URL and no unknown per-row field", async () => {
  const { res } = await invoke({ env: previewEnv, headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN } });
  const serialized = JSON.stringify(res.body);

  const keys = collectKeys(res.body);
  assert.ok(!keys.has("rawPayload"), "no rawPayload key anywhere in the response");
  for (const forbiddenKey of ["password", "connection", "DATABASE_URL", "DIRECT_URL", "trackingUrl", "merchantNameRaw", "host", "username"]) {
    assert.ok(!keys.has(forbiddenKey), `no "${forbiddenKey}" key anywhere in the response`);
  }

  for (const leaked of [LEAKED_CONNECTION, LEAKED_HOST, LEAKED_PASSWORD, LEAKED_API_KEY, LEAKED_TRACKING_URL, REAL_TOKEN, "postgres://", "postgresql://"]) {
    assert.ok(!serialized.includes(leaked), `response must not contain ${leaked.slice(0, 24)}`);
  }

  for (const row of [...res.body.sampleRows, ...res.body.liveCertifiedIdentifiers.rows]) {
    assert.deepEqual(Object.keys(row), [...IDENTIFIER_ROW_FIELDS], "each row carries exactly the six identifier fields");
    for (const value of Object.values(row)) assert.ok(value === null || typeof value === "string");
  }

  // The projection itself is the control: nothing outside the allowlist survives.
  assert.deepEqual(projectIdentifierRow({ supplierCampaignId: 1, rawPayload: { x: 1 }, extra: "no" }), {
    supplierCampaignId: "1",
    supplierRegion: null,
    sourceAccountLabel: null,
    raw_id: null,
    raw_campaign_id: null,
    raw_product_id: null,
  });
  assert.deepEqual(Object.keys(projectIdentifierRow(null)), [...IDENTIFIER_ROW_FIELDS]);
});

test("request input is ignored entirely", async () => {
  const db = fakeDatabase();
  const handler = createOptimiseIdentifierAuditPreviewHandler({ env: previewEnv, loadDependencies: db.load });
  const res = mockRes();

  await handler(
    {
      headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN },
      body: { supplier: "AWIN", limit: 100000, sql: "DELETE FROM supplier_campaigns", productId: "1" },
      query: { supplier: "AWIN", limit: 100000 },
    },
    res,
    () => {},
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(new Set(db.calls.executed), new Set(Object.values(AUDIT_SQL)));
  assert.ok(!JSON.stringify(res.body).includes("AWIN"));
});

test("supplier_commission_rules absent: linkage reports presence false and the linkage statement never runs", async () => {
  const db = fakeDatabase({ supplierCommissionRulesPresent: false });
  const { res } = await invoke({ env: previewEnv, headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN }, db });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.commissionRuleLinkage, { supplierCommissionRulesPresent: false });
  assert.ok(!db.calls.executed.includes(AUDIT_SQL.commissionRuleLinkage), "no query against a table that does not exist");
  assert.equal(res.body.meta.statementsExecuted, 7);
});

test("supplier_campaigns absent (the wrong database): says so and stops after the presence check", async () => {
  const db = fakeDatabase({ supplierCampaignsPresent: false });
  const { res } = await invoke({ env: previewEnv, headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN }, db });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.supplierCampaignsPresent, false);
  assert.equal(res.body.meta.supplierCampaignsPresent, false);
  assert.equal(res.body.meta.statementsExecuted, 1);
  assert.deepEqual(db.calls.executed, [AUDIT_SQL.supplierCampaignsPresent]);
  assert.equal(res.body.overallCounts, undefined);
  assert.equal(res.body.sampleRows, undefined);
});

test("a database error is replaced by a generic error: the driver message (which can name the host) never leaves the runtime", async () => {
  const driverError = Object.assign(new Error(`Can't reach database server at \`${LEAKED_HOST}:5432\` using ${LEAKED_CONNECTION}`), {
    code: "P1001",
    name: "PrismaClientInitializationError",
  });
  const db = fakeDatabase({ failWith: driverError });
  const { res, nextError } = await invoke({ env: previewEnv, headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN }, db });

  assert.equal(res.body, null, "nothing is sent directly");
  assert.ok(nextError instanceof Error);
  assert.equal(nextError.statusCode, 500);
  assert.equal(nextError.code, "P1001", "the driver's error code is enough to triage");
  assert.equal(nextError.message, "Identifier audit failed (PrismaClientInitializationError).");
  assert.ok(!nextError.message.includes(LEAKED_HOST));
  assert.ok(!JSON.stringify({ ...nextError, message: nextError.message, stack: undefined }).includes(LEAKED_HOST));
  assert.equal(nextError.cause, undefined, "the original error is not attached");
  assert.equal(nextError.details, undefined, "no details object for the app handler to spread");
});

test("a malformed error code is dropped rather than echoed", async () => {
  const db = fakeDatabase({ failWith: Object.assign(new Error("boom"), { code: `see ${LEAKED_CONNECTION}` }) });
  const { nextError } = await invoke({ env: previewEnv, headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN }, db });

  assert.equal(nextError.code, undefined);
  assert.ok(!nextError.message.includes(LEAKED_HOST));
});

// ---------------------------------------------------------------------------
// No write / mutation / supplier path exists in the route
// ---------------------------------------------------------------------------

test("no write, mutation, persistence or supplier path exists in the route", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf8");

  assert.ok(!/prisma\.[A-Za-z]+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\b/.test(source), "no prisma model mutation");
  assert.ok(!/\$executeRaw|\$executeRawUnsafe|\$transaction/.test(source), "no execute or transaction API");
  assert.ok(!/PersistenceService|Repository/.test(source), "no persistence or repository layer");
  assert.ok(!/writeFile|mkdir|appendFile/.test(source), "nothing is written to disk");
  assert.ok(!/optimise\.adapter|optimiseCredentials|createHttpClient|httpClient|fetchCampaign|axios|fetch\(/.test(source), "no supplier client or HTTP call");
  assert.ok(!/optimiseCertification\.mjs|runCertification/.test(source), "the certification core (which calls the supplier) is not used");
  assert.ok(!/console\./.test(source), "nothing is logged from this route");
  assert.equal((source.match(/\.\$queryRawUnsafe\(/g) ?? []).length, 1, "exactly one raw read call site");
  assert.match(source, /query: \(sql\) => prisma\.\$queryRawUnsafe\(sql\)/, "and it forwards the constant unchanged");
  assert.match(source, /assertReadOnlySql\(sql\);\s*statementsExecuted \+= 1;\s*return query\(sql\);/, "every statement passes the guard immediately before execution");
});

test("the route is registered exactly once, as a temporary POST endpoint, with its own gate", () => {
  const routerSource = fs.readFileSync(ROUTER_PATH, "utf8");

  assert.equal(PREVIEW_IDENTIFIER_AUDIT_ROUTE, "/internal/certification/optimise-identifiers");
  assert.match(routerSource, /router\.post\(PREVIEW_IDENTIFIER_AUDIT_ROUTE, optimiseIdentifierAuditPreviewHandler\)/);
  assert.equal((routerSource.match(/PREVIEW_IDENTIFIER_AUDIT_ROUTE/g) ?? []).length, 2, "imported once, mounted once");
  assert.ok(
    !/router\.(get|put|patch|delete)\(PREVIEW_IDENTIFIER_AUDIT_ROUTE/.test(routerSource),
    "POST only",
  );
  assert.ok(
    !/router\.post\(PREVIEW_IDENTIFIER_AUDIT_ROUTE,\s*authenticate/.test(routerSource),
    "the preview gate, not user auth, controls this route",
  );
  const registration = routerSource.slice(routerSource.indexOf("router.post(PREVIEW_IDENTIFIER_AUDIT_ROUTE") - 400, routerSource.indexOf("router.post(PREVIEW_IDENTIFIER_AUDIT_ROUTE"));
  assert.match(registration, /TEMPORARY/, "the registration is labelled temporary");

  // The existing certification route is untouched by this registration.
  assert.equal((routerSource.match(/PREVIEW_CERTIFICATION_ROUTE/g) ?? []).length, 2);
});

// ---------------------------------------------------------------------------
// Real Postgres, rolled back: the SQL semantics hold on the actual schema
// ---------------------------------------------------------------------------

test("against Postgres in a rolled-back transaction: campaign_id fallback, trim, both-present disagreements, lineage, live identifiers, rule linkage", async () => {
  const { prisma } = await import("../src/database/prisma.js");
  const label = `idaudit-${process.pid}-${Date.now()}`;
  const ROLLBACK = Symbol("rollback");

  const auditWith = async (tx) => {
    const handler = createOptimiseIdentifierAuditPreviewHandler({
      env: previewEnv,
      loadDependencies: async () => ({ query: (sql) => tx.$queryRawUnsafe(sql) }),
    });
    const res = mockRes();
    let nextError = null;
    await handler({ headers: { [CERTIFICATION_TOKEN_HEADER]: REAL_TOKEN }, body: {}, query: {} }, res, (error) => {
      nextError = error;
    });
    assert.equal(nextError, null, nextError ? `${nextError.message} (${nextError.code ?? "no code"})` : undefined);
    assert.equal(res.statusCode, 200);
    return res.body;
  };

  const campaign = (supplierCampaignId, rawPayload) => ({
    supplier: "OPTIMISE",
    supplierRegion: "SEA",
    supplierCampaignId,
    sourceAccountLabel: label,
    campaignName: `Identifier audit fixture ${supplierCampaignId}`,
    rawPayload,
    normalizedPayload: {},
    mapperVersion: "identifier-audit-test",
  });

  let outcome = null;
  try {
    await prisma.$transaction(
      async (tx) => {
        const before = await auditWith(tx);
        assert.equal(before.meta.supplierCampaignsPresent, true);
        assert.equal(before.commissionRuleLinkage.supplierCommissionRulesPresent, true);

        // F1: all three present, all different; persisted key came from `id`.
        const f1 = await tx.supplierCampaign.create({ data: campaign("1001", { id: "1001", campaignId: "2001", productId: "3001" }) });
        // F2: campaign_id (snake) only, everything agrees.
        const f2 = await tx.supplierCampaign.create({ data: campaign("1002", { id: "1002", campaign_id: "1002", productId: "1002" }) });
        // F3: no campaignId at all; id and productId differ.
        await tx.supplierCampaign.create({ data: campaign("1003", { id: "1003", productId: "3003" }) });
        // F4: whitespace-only campaignId/campaign_id count as MISSING; id is trimmed; no productId.
        await tx.supplierCampaign.create({ data: campaign("1004", { id: " 1004 ", campaignId: "", campaign_id: "  " }) });
        // F5: the live-certified pair as JSON numbers, persisted under a key that matches neither.
        await tx.supplierCampaign.create({
          data: campaign("57316-row", { id: "9999", campaignId: Number(LIVE_CERTIFIED_CAMPAIGN_ID), productId: Number(LIVE_CERTIFIED_PRODUCT_ID) }),
        });

        const rule = (outcomeKey, supplierCampaignId) => ({
          supplier: "OPTIMISE",
          sourceAccountLabel: label,
          outcomeKey: `${label}:${outcomeKey}`,
          supplierCampaignId,
        });
        await tx.supplierCommissionRule.create({ data: rule("r1", f1.id) }); // linked; key differs from campaignId AND productId
        await tx.supplierCommissionRule.create({ data: rule("r2", f2.id) }); // linked; key matches both
        await tx.supplierCommissionRule.create({ data: rule("r3", null) }); // unlinked

        const after = await auditWith(tx);
        const delta = (pick) => pick(after) - pick(before);

        // A
        assert.equal(delta((b) => b.overallCounts.totalRows), 5);
        assert.equal(delta((b) => b.overallCounts.rawIdPresent), 5);
        assert.equal(delta((b) => b.overallCounts.rawCampaignIdPresent), 3, "F1 camelCase, F2 snake_case, F5 numeric");
        assert.equal(delta((b) => b.overallCounts.rawProductIdPresent), 4);
        assert.equal(delta((b) => b.overallCounts.allThreePresent), 3);
        assert.equal(delta((b) => b.overallCounts.rawCampaignIdMissing), 2, "F3 absent, F4 whitespace-only");
        assert.equal(delta((b) => b.overallCounts.rawProductIdMissing), 1);

        // B — both present AND different only
        assert.equal(delta((b) => b.namespaceDisagreements.idVsCampaignId.bothPresent), 3);
        assert.equal(delta((b) => b.namespaceDisagreements.idVsCampaignId.differ), 2, "F1 and F5; F2 agrees; F3/F4 have no campaignId");
        assert.equal(delta((b) => b.namespaceDisagreements.idVsProductId.bothPresent), 4);
        assert.equal(delta((b) => b.namespaceDisagreements.idVsProductId.differ), 3, "F1, F3, F5");
        assert.equal(delta((b) => b.namespaceDisagreements.campaignIdVsProductId.bothPresent), 3);
        assert.equal(delta((b) => b.namespaceDisagreements.campaignIdVsProductId.differ), 2, "F1 and F5");

        // C — lineage
        assert.equal(delta((b) => b.supplierCampaignIdLineage.id.matches), 4, "F1–F4 (F4 after trim)");
        assert.equal(delta((b) => b.supplierCampaignIdLineage.id.differs), 1, "F5");
        assert.equal(delta((b) => b.supplierCampaignIdLineage.id.rawMissing), 0);
        assert.equal(delta((b) => b.supplierCampaignIdLineage.campaignId.matches), 1, "F2 via campaign_id");
        assert.equal(delta((b) => b.supplierCampaignIdLineage.campaignId.differs), 2, "F1, F5");
        assert.equal(delta((b) => b.supplierCampaignIdLineage.campaignId.rawMissing), 2, "F3, F4");
        assert.equal(delta((b) => b.supplierCampaignIdLineage.productId.matches), 1, "F2");
        assert.equal(delta((b) => b.supplierCampaignIdLineage.productId.differs), 3, "F1, F3, F5");
        assert.equal(delta((b) => b.supplierCampaignIdLineage.productId.rawMissing), 1, "F4");

        // D — sample rows: ours appear, disagreements first, then missing, then consistent
        const ours = after.sampleRows.filter((row) => row.sourceAccountLabel === label);
        assert.equal(ours.length, 5);
        const position = Object.fromEntries(ours.map((row, index) => [row.supplierCampaignId, index]));
        for (const disagreeing of ["1001", "1003", "57316-row"]) {
          assert.ok(position[disagreeing] < position["1004"], `${disagreeing} (disagreement) sorts before 1004 (missing only)`);
        }
        assert.ok(position["1004"] < position["1002"], "1004 (missing) sorts before 1002 (consistent)");
        assert.deepEqual(ours.find((row) => row.supplierCampaignId === "1002"), {
          supplierCampaignId: "1002",
          supplierRegion: "SEA",
          sourceAccountLabel: label,
          raw_id: "1002",
          raw_campaign_id: "1002",
          raw_product_id: "1002",
        });
        assert.deepEqual(ours.find((row) => row.supplierCampaignId === "1004"), {
          supplierCampaignId: "1004",
          supplierRegion: "SEA",
          sourceAccountLabel: label,
          raw_id: "1004",
          raw_campaign_id: null,
          raw_product_id: null,
        });
        assert.ok(after.sampleRows.length <= SAMPLE_ROW_LIMIT);

        // E — live-certified identifiers found through raw columns, not the persisted key
        const live = after.liveCertifiedIdentifiers.rows.filter((row) => row.sourceAccountLabel === label);
        assert.deepEqual(live, [
          {
            supplierCampaignId: "57316-row",
            supplierRegion: "SEA",
            sourceAccountLabel: label,
            raw_id: "9999",
            raw_campaign_id: "7340528",
            raw_product_id: "57316",
          },
        ]);

        // F — rule linkage
        assert.equal(delta((b) => b.commissionRuleLinkage.totalRules), 3);
        assert.equal(delta((b) => b.commissionRuleLinkage.unlinkedRules), 1);
        assert.equal(delta((b) => b.commissionRuleLinkage.rulesLinkedToOptimiseCampaigns), 2);
        assert.equal(delta((b) => b.commissionRuleLinkage.linkedSupplierCampaignIdDiffersFromRawCampaignId), 1, "r1 only");
        assert.equal(delta((b) => b.commissionRuleLinkage.linkedSupplierCampaignIdDiffersFromRawProductId), 1, "r1 only");

        // Nothing but identifiers and counts came back.
        const keys = collectKeys(after);
        assert.ok(!keys.has("rawPayload"));
        assert.ok(!JSON.stringify(after).includes("Identifier audit fixture"), "campaign names are not returned");

        outcome = "asserted";
        throw ROLLBACK;
      },
      { timeout: 60_000 },
    );
    assert.fail("the fixture transaction must roll back");
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  } finally {
    await prisma.$disconnect();
  }

  assert.equal(outcome, "asserted");
  const leftover = await prisma.supplierCampaign.count({ where: { sourceAccountLabel: label } });
  assert.equal(leftover, 0, "the fixtures were rolled back; the audit test persists nothing");
  await prisma.$disconnect();
});
