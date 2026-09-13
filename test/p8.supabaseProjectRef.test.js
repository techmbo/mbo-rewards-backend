import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const {
  IDENTITY_TABLES,
  extractSupabaseProjectRef,
  inspectDirectUrl,
  runDatabaseRecoveryDiagnostic,
} = await import("../src/modules/ops/databaseRecoveryDiagnostic.service.js");

const serviceSource = readFileSync("src/modules/ops/databaseRecoveryDiagnostic.service.js", "utf8");

/**
 * A Supabase direct URL whose every component is a distinctive token.
 *
 * The project ref is the ONE part that may be returned. Everything else — user, password, port,
 * database, query — must never appear, so each is a string that occurs nowhere else in the repo and
 * a leak assertion can name it directly.
 */
const REF = "abcdefghij0123456789"; // 20 chars, the shape Supabase issues
const PARTS = {
  user: "zzsbuserzz",
  password: "zzsbpasswordzz",
  port: "5432",
  database: "zzsbdatabasezz",
  query: "zzsbsslmodezz",
};
const SUPABASE_URL =
  `postgresql://${PARTS.user}:${PARTS.password}@db.${REF}.supabase.co:${PARTS.port}` +
  `/${PARTS.database}?sslmode=${PARTS.query}`;

/** The full host, which must never be returned even though the ref inside it may be. */
const FULL_HOST = `db.${REF}.supabase.co`;

function fakeClient() {
  return {
    $queryRaw(strings) {
      const sql = Array.isArray(strings?.raw) ? strings.raw.join("?") : String(strings);
      if (/SELECT 1/.test(sql)) return Promise.resolve([{ "?column?": 1 }]);
      if (/information_schema\.tables/.test(sql)) {
        return Promise.resolve(Object.values(IDENTITY_TABLES).map((table_name) => ({ table_name })));
      }
      if (/_prisma_migrations/.test(sql)) {
        return Promise.resolve([
          { applied_count: 56, first_migration: "20260429083809_init_schema", last_migration: "z" },
        ]);
      }
      return Promise.resolve([{ count: 1 }]);
    },
    $disconnect: () => Promise.resolve(),
  };
}

describe("supabase project ref — extraction", () => {
  it("1 — a direct Supabase host yields only the project ref", () => {
    assert.equal(extractSupabaseProjectRef(FULL_HOST), REF);
    assert.equal(extractSupabaseProjectRef(`db.${REF}.supabase.com`), REF);
    // Case and surrounding whitespace in the host do not change the answer.
    assert.equal(extractSupabaseProjectRef(`DB.${REF.toUpperCase()}.SUPABASE.CO`), REF);
    assert.equal(extractSupabaseProjectRef(`  ${FULL_HOST}  `), REF);
  });

  it("2 — the pooler host yields null, because the ref lives in the username there", () => {
    // Reading it would mean parsing the credential portion, which is forbidden.
    for (const host of [
      "aws-0-ap-southeast-1.pooler.supabase.com",
      "aws-1-eu-central-1.pooler.supabase.com",
      "db.pooler.supabase.com",
    ]) {
      assert.equal(extractSupabaseProjectRef(host), null, `${host} produced a ref`);
    }
  });

  it("3 — anything that is not exactly db.<ref>.supabase.co|com yields null", () => {
    for (const host of [
      `${REF}.supabase.co`, // no db. prefix, three labels
      // Four labels but the wrong first one: only `db` is the direct endpoint. Anything else is a
      // different Supabase host whose second label is not a project reference.
      `xx.${REF}.supabase.co`,
      `api.${REF}.supabase.co`,
      `pooler.${REF}.supabase.co`,
      `db2.${REF}.supabase.co`,
      `db.${REF}.supabase.co.attacker.test`, // suffix continues
      `db.${REF}.supabase.io`, // wrong TLD
      `db.${REF}.notsupabase.co`,
      `evil.db.${REF}.supabase.co`, // five labels
      `db.${REF}.supabase`, // three labels
      "db.supabase.co",
      "supabase.co",
      "db..supabase.co",
      "monorail.proxy.rlwy.net",
      "ep-cool-forest.eu-central-1.aws.neon.tech",
      "",
      null,
      undefined,
      42,
      {},
    ]) {
      assert.equal(extractSupabaseProjectRef(host), null, `${String(host)} produced a ref`);
    }
  });

  it("4 — a label that is not shaped like a reference yields null", () => {
    for (const label of [
      "short",
      "a".repeat(15), // below the floor
      "a".repeat(33), // above the ceiling
      "has-a-hyphen-in-it-x",
      "has_underscore_00000",
      "has.dot.inside.00000",
      // Not listed: an UPPERCASE label. DNS is case-insensitive and the extractor lowercases the
      // host before matching, which test 1 asserts deliberately — that is normalisation of the
      // hostname, not laxity about the reference's shape.
      "zzzz zzzz zzzz zzzzz",
    ]) {
      assert.equal(
        extractSupabaseProjectRef(`db.${label}.supabase.co`),
        null,
        `${label} was accepted as a ref`,
      );
    }
    // The boundaries themselves are accepted.
    assert.equal(extractSupabaseProjectRef(`db.${"a".repeat(16)}.supabase.co`), "a".repeat(16));
    assert.equal(extractSupabaseProjectRef(`db.${"a".repeat(32)}.supabase.co`), "a".repeat(32));
  });

  it("5 — the field is null for every non-Supabase provider", () => {
    for (const url of [
      "postgresql://u:p@monorail.proxy.rlwy.net:5432/d",
      "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech:5432/d",
      "postgresql://u:p@mbo.cluster-x.eu-west-1.rds.amazonaws.com:5432/d",
      "postgresql://u:p@internal.example.test:5432/d",
      "postgresql://u:p@db.ondigitalocean.com:5432/d",
    ]) {
      assert.equal(inspectDirectUrl(url).supabaseProjectRef, null, url);
    }
    // And for every unusable value, whatever the malformation.
    for (const url of ["", "   ", "not-a-url", `"${SUPABASE_URL}"`, ` ${SUPABASE_URL}`, "mysql://u:p@h/d"]) {
      assert.equal(inspectDirectUrl(url).supabaseProjectRef, null, JSON.stringify(url.slice(0, 14)));
    }
  });
});

describe("supabase project ref — nothing else leaks", () => {
  it("6 — inspectDirectUrl returns the ref and no other part of the URL", () => {
    const inspected = inspectDirectUrl(SUPABASE_URL);
    assert.equal(inspected.providerClass, "supabase");
    assert.equal(inspected.supabaseProjectRef, REF);

    const serialised = JSON.stringify(inspected);
    for (const [name, part] of Object.entries(PARTS)) {
      assert.ok(!serialised.includes(part), `${name} leaked`);
    }
    for (const forbidden of [
      FULL_HOST,
      "db.",
      ".supabase.co",
      "supabase.co",
      "postgresql://",
      "postgres://",
      "://",
      "@",
      ":5432",
    ]) {
      assert.ok(!serialised.includes(forbidden), `response contains ${forbidden}`);
    }
    // The ref alone, never the host that contains it.
    assert.ok(serialised.includes(REF), "the ref should be reported");
    assert.ok(!serialised.includes(`${REF}.`), "the ref was reported with its host suffix");
  });

  it("7 — the full diagnostic response leaks no credential and no full host", async () => {
    const result = await runDatabaseRecoveryDiagnostic({
      url: SUPABASE_URL,
      clientFactory: () => fakeClient(),
      timeoutMs: 2000,
    });
    assert.equal(result.providerClass, "supabase");
    assert.equal(result.supabaseProjectRef, REF);
    assert.equal(result.connectionOk, true);
    assert.equal(result.errorCategory, null);

    const serialised = JSON.stringify(result);
    for (const [name, part] of Object.entries(PARTS)) {
      assert.ok(!serialised.includes(part), `${name} leaked from the full response`);
    }
    for (const forbidden of [FULL_HOST, ".supabase.co", "postgresql://", "postgres://", "://", "@"]) {
      assert.ok(!serialised.includes(forbidden), `full response contains ${forbidden}`);
    }
    // Reconstructing the host from the response must be impossible: no prefix, no suffix.
    assert.ok(!serialised.includes("db."), "the response carries the host prefix");
    assert.ok(!serialised.includes("supabase.co"), "the response carries the host suffix");
  });

  it("7b — a failing connection to a Supabase URL still reports the ref and leaks nothing", async () => {
    const result = await runDatabaseRecoveryDiagnostic({
      url: SUPABASE_URL,
      clientFactory: () => ({
        // A driver error quoting the whole connection string, as Prisma's do.
        $queryRaw: () => Promise.reject(new Error(`boom ${SUPABASE_URL}`)),
        $disconnect: () => Promise.resolve(),
      }),
      timeoutMs: 2000,
    });
    assert.equal(result.errorCategory, "CONNECTION_FAILED");
    assert.equal(result.supabaseProjectRef, REF, "the ref comes from the URL, not the connection");
    const serialised = JSON.stringify(result);
    for (const part of Object.values(PARTS)) assert.ok(!serialised.includes(part));
    assert.ok(!serialised.includes(FULL_HOST));
  });

  it("8 — the extractor returns a bare label, never anything URL-shaped", () => {
    const refs = [
      extractSupabaseProjectRef(FULL_HOST),
      extractSupabaseProjectRef(`db.${"z".repeat(20)}.supabase.com`),
    ];
    for (const ref of refs) {
      assert.match(ref, /^[a-z0-9]{16,32}$/, "the extractor returned something other than a label");
      for (const forbidden of [".", ":", "/", "@", "?", "=", "&", " "]) {
        assert.ok(!ref.includes(forbidden), `the ref contains ${forbidden}`);
      }
    }
  });
});

describe("supabase project ref — the diagnostic is otherwise unchanged", () => {
  it("9 — still read-only, still no logging, still no runtime client", () => {
    const code = serviceSource.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      "$executeRaw",
      "$queryRawUnsafe",
      "$transaction",
      ".create(",
      ".update(",
      ".delete(",
      "INSERT",
      "TRUNCATE",
      "DROP",
      "console.",
      "logger",
      "database/prisma.js",
    ]) {
      assert.ok(!code.includes(forbidden), `the service now does ${forbidden}`);
    }
  });

  it("9b — the extractor reads a hostname only: it never sees the credential portion", () => {
    const start = serviceSource.indexOf("export function extractSupabaseProjectRef");
    const body = serviceSource.slice(start, serviceSource.indexOf("\n}", start));
    // Property accesses, not bare words: "export function" contains the substring "port".
    for (const forbidden of [
      ".username",
      ".password",
      ".port",
      ".pathname",
      ".search",
      ".searchParams",
      ".href",
      ".protocol",
      "new URL(",
    ]) {
      assert.ok(!body.includes(forbidden), `the extractor reads ${forbidden}`);
    }
    // The only input it takes is the hostname parameter.
    assert.match(body, /export function extractSupabaseProjectRef\(hostname\)/);
    // It is called with the hostname and nothing else.
    assert.match(serviceSource, /extractSupabaseProjectRef\(parsed\.hostname\)/);
  });

  it("9c — the cache headers and the break-glass gate are untouched", () => {
    const routeSource = readFileSync("src/routes/databaseRecoveryRoute.js", "utf8");
    assert.match(routeSource, /requireDatabaseRecoveryToken,/);
    assert.match(routeSource, /noStoreHeaders,/);
    const controller = readFileSync("src/controllers/databaseRecoveryDiagnostic.controller.js", "utf8");
    assert.match(controller, /"Cache-Control", "no-store"/);
    assert.match(controller, /"Pragma", "no-cache"/);
  });
});
