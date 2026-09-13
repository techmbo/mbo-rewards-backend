import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const {
  IDENTITY_TABLES,
  extractSupabaseProjectRef,
  extractSupabaseProjectRefFromPoolerUsername,
  inspectDirectUrl,
  isSupabasePoolerHost,
  runDatabaseRecoveryDiagnostic,
  supabaseProjectRefFrom,
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

  it("2 — the pooler HOST carries no ref: on the pooler it lives in the username", () => {
    for (const host of [
      "aws-0-ap-southeast-1.pooler.supabase.com",
      "aws-1-eu-central-1.pooler.supabase.com",
      "db.pooler.supabase.com",
    ]) {
      assert.equal(extractSupabaseProjectRef(host), null, `${host} produced a host ref`);
      assert.equal(isSupabasePoolerHost(host), true, `${host} was not recognised as a pooler`);
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
    // The direct-host extractor still takes a hostname and nothing else, and the combiner is the
    // only caller that ever sees a username — behind the pooler-host check.
    assert.match(serviceSource, /supabaseProjectRefFrom\(\{ hostname: parsed\.hostname, username: parsed\.username \}\)/);
    const combinerStart = serviceSource.indexOf("export function supabaseProjectRefFrom");
    const combiner = serviceSource.slice(combinerStart, serviceSource.indexOf("\n}", combinerStart));
    const guard = combiner.indexOf("isSupabasePoolerHost(hostname)");
    const use = combiner.indexOf("extractSupabaseProjectRefFromPoolerUsername(username)");
    assert.ok(guard >= 0 && use > guard, "the username is read before the pooler host is confirmed");
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


/** A Supabase POOLER URL: the reference is in the username, not the hostname. */
const POOLER_PARTS = {
  password: "zzpoolerpasswordzz",
  port: "6543",
  database: "zzpoolerdatabasezz",
  query: "zzpoolersslmodezz",
};
const POOLER_HOST = "aws-0-ap-southeast-1.pooler.supabase.com";
const POOLER_USERNAME = `postgres.${REF}`;
const POOLER_URL =
  `postgresql://${POOLER_USERNAME}:${POOLER_PARTS.password}@${POOLER_HOST}:${POOLER_PARTS.port}` +
  `/${POOLER_PARTS.database}?sslmode=${POOLER_PARTS.query}`;

describe("supabase project ref — pooler username", () => {
  it("P1 — postgres.<ref> on a Supabase pooler host returns the ref", () => {
    assert.equal(inspectDirectUrl(POOLER_URL).supabaseProjectRef, REF);
    assert.equal(extractSupabaseProjectRefFromPoolerUsername(POOLER_USERNAME), REF);
    // Every region and both Supabase TLDs.
    for (const host of [
      "aws-0-ap-southeast-1.pooler.supabase.com",
      "aws-1-eu-central-1.pooler.supabase.com",
      "aws-0-us-east-1.pooler.supabase.co",
    ]) {
      const url = `postgresql://${POOLER_USERNAME}:pw@${host}:6543/postgres`;
      assert.equal(inspectDirectUrl(url).supabaseProjectRef, REF, host);
    }
  });

  it("P2 — a username that is not exactly postgres.<ref> returns null", () => {
    for (const username of [
      "postgres",
      "postgresql." + REF,
      "pg." + REF,
      "postgres_" + REF,
      "postgres-" + REF,
      "Postgres." + REF,
      "postgres." + REF + ".extra",
      "postgres..",
      "postgres.." + REF,
      "admin.postgres." + REF,
      `postgres.${REF}:leftover`,
      // Percent-encoded: refused rather than decoded, so an unexpected value cannot become a ref.
      `postgres%2E${REF}`,
      "",
      " ",
      null,
      undefined,
      42,
      {},
    ]) {
      assert.equal(
        extractSupabaseProjectRefFromPoolerUsername(username),
        null,
        `${String(username)} was accepted`,
      );
    }
  });

  it("P3 — a malformed ref in the username returns null", () => {
    for (const ref of [
      "short",
      "a".repeat(15),
      "a".repeat(33),
      "has-a-hyphen-in-it-x",
      "has_underscore_00000",
      "HasUppercase00000000",
      "has zero width 0000",
    ]) {
      assert.equal(
        extractSupabaseProjectRefFromPoolerUsername(`postgres.${ref}`),
        null,
        `${ref} was accepted`,
      );
    }
    // Both branches share one shape rule, so the boundaries agree with the direct-host branch.
    assert.equal(extractSupabaseProjectRefFromPoolerUsername(`postgres.${"a".repeat(16)}`), "a".repeat(16));
    assert.equal(extractSupabaseProjectRefFromPoolerUsername(`postgres.${"a".repeat(32)}`), "a".repeat(32));
  });

  it("P4 — a non-Supabase host never has its username parsed", () => {
    for (const host of [
      "monorail.proxy.rlwy.net",
      "ep-cool-forest.eu-central-1.aws.neon.tech",
      "mbo.cluster-x.eu-west-1.rds.amazonaws.com",
      "internal.example.test",
      // Lookalikes: the suffix must be dot-anchored and must actually end there.
      "pooler.supabase.com.attacker.test",
      "notpooler.supabase.com.evil.test",
      "aws-0-x.pooler.supabase.com.evil.test",
    ]) {
      assert.equal(isSupabasePoolerHost(host), false, `${host} was treated as a pooler`);
      assert.equal(supabaseProjectRefFrom({ hostname: host, username: POOLER_USERNAME }), null, host);
      const url = `postgresql://${POOLER_USERNAME}:pw@${host}:6543/postgres`;
      assert.equal(inspectDirectUrl(url).supabaseProjectRef, null, url);
    }
    // The bare suffix is not an endpoint and is not accepted either.
    assert.equal(isSupabasePoolerHost("pooler.supabase.com"), false);
    assert.equal(isSupabasePoolerHost(".pooler.supabase.com"), false);
  });

  it("P5 — the pooler response carries the ref and no other component", () => {
    const inspected = inspectDirectUrl(POOLER_URL);
    assert.equal(inspected.providerClass, "supabase");
    assert.equal(inspected.supabaseProjectRef, REF);

    const serialised = JSON.stringify(inspected);
    for (const [name, part] of Object.entries(POOLER_PARTS)) {
      assert.ok(!serialised.includes(part), `${name} leaked`);
    }
    for (const forbidden of [
      POOLER_USERNAME,
      "postgres.",
      "postgres",
      POOLER_HOST,
      "pooler",
      "supabase.com",
      "aws-0",
      "ap-southeast-1",
      "postgresql://",
      "://",
      "@",
      ":6543",
    ]) {
      assert.ok(!serialised.includes(forbidden), `response contains ${forbidden}`);
    }
    assert.ok(serialised.includes(REF), "the ref should be reported");
    // The username is `postgres.<ref>`; only the second half may appear.
    assert.ok(!serialised.includes(`postgres.${REF}`), "the username was returned whole");
  });

  it("P6 — the full pooler diagnostic leaks nothing, on success or on failure", async () => {
    const runs = [
      await runDatabaseRecoveryDiagnostic({
        url: POOLER_URL,
        clientFactory: () => fakeClient(),
        timeoutMs: 2000,
      }),
      // A driver error quoting the whole connection string, as Prisma's do.
      await runDatabaseRecoveryDiagnostic({
        url: POOLER_URL,
        clientFactory: () => ({
          $queryRaw: () => Promise.reject(new Error(`boom ${POOLER_URL}`)),
          $disconnect: () => Promise.resolve(),
        }),
        timeoutMs: 2000,
      }),
      // A failure part-way through, after the connection succeeded.
      await runDatabaseRecoveryDiagnostic({
        url: POOLER_URL,
        clientFactory: () => ({
          $queryRaw: (strings) => {
            const sql = Array.isArray(strings?.raw) ? strings.raw.join("?") : String(strings);
            if (/SELECT 1/.test(sql)) return Promise.resolve([{ ok: 1 }]);
            return Promise.reject(new Error(`boom ${POOLER_URL}`));
          },
          $disconnect: () => Promise.resolve(),
        }),
        timeoutMs: 2000,
      }),
    ];

    assert.equal(runs[0].errorCategory, null);
    assert.equal(runs[1].errorCategory, "CONNECTION_FAILED");
    assert.equal(runs[2].errorCategory, "QUERY_FAILED");

    for (const result of runs) {
      assert.equal(result.supabaseProjectRef, REF, "the ref comes from the URL, not the connection");
      const serialised = JSON.stringify(result);
      for (const part of Object.values(POOLER_PARTS)) {
        assert.ok(!serialised.includes(part), "a credential component leaked");
      }
      // Not the bare word "supabase": providerClass is legitimately "supabase". The host forms are
      // what must never appear.
      for (const forbidden of [
        POOLER_USERNAME,
        "postgres",
        POOLER_HOST,
        "pooler",
        "supabase.com",
        "supabase.co",
        "aws-0",
        "@",
        "://",
      ]) {
        assert.ok(!serialised.includes(forbidden), `response contains ${forbidden}`);
      }
      assert.equal(result.providerClass, "supabase", "the provider class is still reported");
    }
  });

  it("P6b — a Supabase URL whose ref cannot be extracted reports null, never the username", () => {
    // The dangerous shape: providerClass IS supabase, so the extraction path runs, but nothing
    // matches. The result must be null — a fallback to the raw username here would return a
    // credential component on exactly the inputs the extractor was written to refuse.
    const USER = "zzrawusernamezz";
    const urls = [
      // Pooler host, username not postgres.<ref>
      `postgresql://${USER}:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/db`,
      // Pooler host, right prefix but a malformed ref
      `postgresql://postgres.${USER}:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/db`,
      // Direct-style Supabase host with a label that is not a ref
      `postgresql://${USER}:pw@db.short.supabase.co:5432/db`,
      // A Supabase host that is neither the direct nor the pooler shape
      `postgresql://${USER}:pw@api.${REF}.supabase.co:5432/db`,
      // No username at all
      "postgresql://aws-0-ap-southeast-1.pooler.supabase.com:6543/db",
    ];
    for (const url of urls) {
      const inspected = inspectDirectUrl(url);
      assert.equal(inspected.providerClass, "supabase", url);
      assert.equal(inspected.supabaseProjectRef, null, `a ref was invented for ${url}`);
      const serialised = JSON.stringify(inspected);
      assert.ok(!serialised.includes(USER), `the username leaked for ${url}`);
      assert.ok(!serialised.includes("zzraw"), `a username fragment leaked for ${url}`);
      assert.ok(!serialised.includes("postgres"), `the role name leaked for ${url}`);
    }
  });

  it("P7 — the username reader is anchored and returns only the captured group", () => {
    const start = serviceSource.indexOf("export function extractSupabaseProjectRefFromPoolerUsername");
    const body = serviceSource.slice(start, serviceSource.indexOf("\n}", start));
    // Anchored at both ends: an unanchored match could find a ref inside a longer secret.
    assert.match(body, /\^postgres\\\.\(\[a-z0-9\]\{16,32\}\)\$/);
    assert.ok(!body.includes("password"), "the username reader touches the password");
    assert.ok(!body.includes("decodeURI"), "the username reader decodes its input");
    // It returns match[1], never the whole match or the input.
    assert.ok(body.includes("match[1]"));
    assert.ok(!/return String\(username/.test(body), "the reader returns its input");
  });
});
