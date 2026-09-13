import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const express = (await import("express")).default;
const { requireAdminRole, requirePermission } = await import("../src/middleware/auth.js");
const { PERMISSIONS } = await import("../src/auth/permissions.js");
const {
  DIAGNOSTIC_ERROR_CATEGORIES,
  IDENTITY_TABLES,
  PROVIDER_CLASSES,
  classifyProviderHost,
  inspectDirectUrl,
  runDatabaseRecoveryDiagnostic,
} = await import("../src/modules/ops/databaseRecoveryDiagnostic.service.js");
const { databaseRecoveryDiagnosticHandler } = await import(
  "../src/controllers/databaseRecoveryDiagnostic.controller.js"
);

const routesSource = readFileSync("src/routes/index.js", "utf8");
const serviceSource = readFileSync("src/modules/ops/databaseRecoveryDiagnostic.service.js", "utf8");
const authSource = readFileSync("src/middleware/auth.js", "utf8");

const ROUTE = "/ops/diagnostics/database-recovery";

/**
 * A connection string built entirely from distinctive tokens.
 *
 * Every part is a string that appears nowhere else in the codebase, so a leak test can assert on
 * the token itself rather than on a pattern that might match innocent output.
 */
const SECRET_PARTS = {
  user: "zzuserzz",
  password: "zzpasswordzz",
  host: "zzhostzz.proxy.rlwy.net",
  port: "41234",
  database: "zzdatabasezz",
  query: "zzsslmodezz",
};
const LIVE_URL =
  `postgresql://${SECRET_PARTS.user}:${SECRET_PARTS.password}` +
  `@${SECRET_PARTS.host}:${SECRET_PARTS.port}/${SECRET_PARTS.database}?sslmode=${SECRET_PARTS.query}`;

/** Every statement a real run would make, and nothing else. Records SQL; returns canned rows. */
function fakeClient({ tables = Object.values(IDENTITY_TABLES), counts = {}, fail = null } = {}) {
  const statements = [];
  let disconnected = 0;

  const sqlOf = (strings) => (Array.isArray(strings?.raw) ? strings.raw.join("?") : String(strings));

  return {
    statements,
    get disconnected() {
      return disconnected;
    },
    client: {
      $queryRaw(strings) {
        const sql = sqlOf(strings);
        statements.push(sql);
        if (fail && fail(sql)) return Promise.reject(new Error(`boom ${LIVE_URL}`));
        if (/SELECT 1/.test(sql)) return Promise.resolve([{ "?column?": 1 }]);
        if (/information_schema\.tables/.test(sql)) {
          return Promise.resolve(tables.map((table_name) => ({ table_name })));
        }
        if (/_prisma_migrations/.test(sql)) {
          return Promise.resolve([
            {
              applied_count: 57,
              first_migration: "20260429083809_init_schema",
              last_migration: "20260903060000_expand_supplier_keys",
            },
          ]);
        }
        const match = sql.match(/FROM "([A-Za-z_]+)"/);
        return Promise.resolve([{ count: counts[match?.[1]] ?? 0 }]);
      },
      $disconnect() {
        disconnected += 1;
        return Promise.resolve();
      },
    },
  };
}

function run(url, options = {}) {
  const fake = options.fake ?? fakeClient();
  return runDatabaseRecoveryDiagnostic({
    url,
    clientFactory: () => fake.client,
    timeoutMs: options.timeoutMs ?? 2000,
  }).then((result) => ({ result, fake }));
}

/** Serves one route with the real gates, driven by an injected user rather than a real token. */
async function serve(user) {
  const app = express();
  app.get(
    ROUTE,
    (req, _res, next) => {
      if (user) req.user = user;
      next();
    },
    requirePermission(PERMISSIONS.OPS_MANAGE),
    requireAdminRole,
    (_req, res) => res.json({ ok: true, data: { reached: true } }),
  );

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async get(path) {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("database recovery diagnostic — access control", () => {
  it("1 — an unauthenticated request is denied with 401 and never reaches the handler", async () => {
    const app = await serve(null);
    try {
      const res = await app.get(ROUTE);
      assert.equal(res.status, 401);
      assert.equal(res.body.ok, false);
      assert.ok(!res.body.data, "the handler must not have run");
    } finally {
      await app.stop();
    }
  });

  it("2 — a non-admin role is denied with 403", async () => {
    for (const role of ["OPERATIONS", "TECH", "ANALYST", "SUPPORT", "CLIENT"]) {
      const app = await serve({ id: "u1", role });
      try {
        const res = await app.get(ROUTE);
        assert.equal(res.status, 403, `${role} must be refused`);
        assert.ok(!res.body.data, `${role} must not reach the handler`);
      } finally {
        await app.stop();
      }
    }
  });

  it("2b — OPERATIONS holds ops:manage, so the role check is what refuses it", async () => {
    // Proves requireAdminRole is load-bearing: without it, OPERATIONS would pass the permission.
    const app = await serve({ id: "u1", role: "OPERATIONS" });
    try {
      assert.equal((await app.get(ROUTE)).status, 403);
    } finally {
      await app.stop();
    }

    const permissionOnly = express();
    permissionOnly.get(
      ROUTE,
      (req, _res, next) => {
        req.user = { id: "u1", role: "OPERATIONS" };
        next();
      },
      requirePermission(PERMISSIONS.OPS_MANAGE),
      (_req, res) => res.json({ ok: true, data: { reached: true } }),
    );
    const server = await new Promise((resolve) => {
      const s = permissionOnly.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${ROUTE}`);
      assert.equal(res.status, 200, "OPERATIONS does pass ops:manage on its own");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("2c — ADMIN passes both gates", async () => {
    const app = await serve({ id: "u1", role: "ADMIN" });
    try {
      const res = await app.get(ROUTE);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.reached, true);
    } finally {
      await app.stop();
    }
  });

  it("2d — the route is wired with authenticate, ops:manage, requireAdminRole and noStoreHeaders in order", () => {
    const start = routesSource.indexOf(`"${ROUTE}"`);
    assert.ok(start > 0, "the route is registered");
    const block = routesSource.slice(start, routesSource.indexOf(");", start));
    const order = [
      "authenticate",
      "requirePermission(PERMISSIONS.OPS_MANAGE)",
      "requireAdminRole",
      "noStoreHeaders",
      "databaseRecoveryDiagnosticHandler",
    ];
    const positions = order.map((name) => block.indexOf(name));
    for (const [i, position] of positions.entries()) {
      assert.ok(position >= 0, `${order[i]} missing from the route`);
    }
    for (let i = 1; i < positions.length; i += 1) {
      assert.ok(positions[i] > positions[i - 1], `${order[i]} must come after ${order[i - 1]}`);
    }
    // It is a GET and nothing else: no POST/PUT/PATCH/DELETE variant of this path exists.
    assert.equal(routesSource.split(`"${ROUTE}"`).length - 1, 1, "registered exactly once");
    assert.ok(
      routesSource.slice(Math.max(0, start - 200), start).includes("router.get("),
      "registered as a GET",
    );
  });
});

describe("database recovery diagnostic — DIRECT_URL handling", () => {
  it("3 — a missing DIRECT_URL returns MISSING_URL and connects to nothing", async () => {
    for (const missing of [undefined, null, "", "   "]) {
      let factoryCalls = 0;
      const result = await runDatabaseRecoveryDiagnostic({
        url: missing,
        clientFactory: () => {
          factoryCalls += 1;
          throw new Error("must not construct a client");
        },
      });
      assert.equal(factoryCalls, 0, "no client is constructed without a URL");
      assert.equal(result.errorCategory, "MISSING_URL");
      assert.equal(result.directUrlPresent, false);
      assert.equal(result.directUrlValidPostgresScheme, false);
      assert.equal(result.connectionOk, false);
      assert.equal(result.providerClass, "unknown");
      assert.equal(result.migrationFingerprint.appliedCount, null);
      assert.equal(result.rowCountFingerprint.users, null);
    }
  });

  it("4 — an invalid DIRECT_URL returns INVALID_SCHEME and never echoes the value", async () => {
    const invalid = [
      `"${LIVE_URL}"`,
      ` ${LIVE_URL}`,
      `host=${SECRET_PARTS.host} user=${SECRET_PARTS.user}`,
      "eyJhbGciOiJIUzI1NiJ9.zzpayloadzz.zzsigzz",
      `mysql://${SECRET_PARTS.user}:${SECRET_PARTS.password}@${SECRET_PARTS.host}/x`,
      `prisma+postgres://accelerate.prisma-data.net/?api_key=${SECRET_PARTS.password}`,
    ];
    for (const url of invalid) {
      const result = await runDatabaseRecoveryDiagnostic({
        url,
        clientFactory: () => {
          throw new Error("must not construct a client for an invalid scheme");
        },
      });
      assert.equal(result.errorCategory, "INVALID_SCHEME", url.slice(0, 12));
      assert.equal(result.directUrlPresent, true);
      assert.equal(result.directUrlValidPostgresScheme, false);
      assert.equal(result.providerClass, "unknown");

      const serialised = JSON.stringify(result);
      for (const [name, part] of Object.entries(SECRET_PARTS)) {
        assert.ok(!serialised.includes(part), `${name} leaked from an invalid URL`);
      }
    }
  });

  it("5 — a valid DIRECT_URL response carries no scheme, credential, host, port or database name", async () => {
    const { result } = await run(LIVE_URL, {
      fake: fakeClient({ counts: { User: 7, MarketplaceAccount: 3, raw_payloads: 1200, supplier_campaigns: 88 } }),
    });
    const serialised = JSON.stringify(result);

    for (const forbidden of ["postgres://", "postgresql://", "://", "@"]) {
      assert.ok(!serialised.includes(forbidden), `response contains ${forbidden}`);
    }
    for (const [name, part] of Object.entries(SECRET_PARTS)) {
      assert.ok(!serialised.includes(part), `${name} leaked`);
    }
    // Not even a fragment of the password, and no bare host label.
    assert.ok(!serialised.includes("zzpass"), "password fragment leaked");
    assert.ok(!serialised.includes("rlwy"), "host suffix leaked");
    assert.ok(!serialised.includes("proxy"), "host label leaked");

    // What it does report.
    assert.equal(result.directUrlPresent, true);
    assert.equal(result.directUrlValidPostgresScheme, true);
    assert.equal(result.providerClass, "railway");
    assert.equal(result.connectionOk, true);
    assert.equal(result.errorCategory, null);
  });

  it("5b — a driver error quoting the URL is reduced to a category", async () => {
    const fake = fakeClient({ fail: (sql) => /SELECT 1/.test(sql) });
    const { result } = await run(LIVE_URL, { fake });
    assert.equal(result.errorCategory, "CONNECTION_FAILED");
    assert.equal(result.connectionOk, false);
    const serialised = JSON.stringify(result);
    for (const part of Object.values(SECRET_PARTS)) {
      assert.ok(!serialised.includes(part), "a driver message leaked the URL");
    }
  });

  it("5c — a query failure keeps partial findings and never leaks", async () => {
    const fake = fakeClient({ fail: (sql) => /_prisma_migrations/.test(sql) });
    const { result } = await run(LIVE_URL, { fake });
    assert.equal(result.connectionOk, true, "the connection succeeded");
    assert.equal(result.errorCategory, "QUERY_FAILED");
    assert.equal(result.databaseIdentity.userTableExists, true, "earlier findings are kept");
    assert.equal(result.migrationFingerprint.appliedCount, null);
    for (const part of Object.values(SECRET_PARTS)) {
      assert.ok(!JSON.stringify(result).includes(part), "a query error leaked the URL");
    }
  });

  it("5d — provider classification is suffix-anchored, not a substring match", () => {
    const cases = [
      ["monorail.proxy.rlwy.net", "railway"],
      ["containers-us-west-1.railway.app", "railway"],
      ["ep-cool-forest.eu-central-1.aws.neon.tech", "neon"],
      ["db.abcdefgh.supabase.co", "supabase"],
      ["mbo.cluster-xyz.eu-west-1.rds.amazonaws.com", "aws"],
      ["db.ondigitalocean.com", "digitalocean"],
      ["postgres.internal.example.test", "generic_postgres"],
      ["", "unknown"],
      // A lookalike domain must not be classified as the provider it imitates.
      ["neon.tech.attacker.test", "generic_postgres"],
      ["notrlwy.net", "generic_postgres"],
      ["supabase.co.evil.test", "generic_postgres"],
    ];
    for (const [host, expected] of cases) {
      assert.equal(classifyProviderHost(host), expected, host || "(empty)");
    }
    for (const [, expected] of cases) assert.ok(PROVIDER_CLASSES.includes(expected));
  });

  it("5e — inspectDirectUrl returns three booleans/enums and nothing else", () => {
    const inspected = inspectDirectUrl(LIVE_URL);
    assert.deepEqual(Object.keys(inspected).sort(), ["present", "providerClass", "validScheme"]);
    assert.equal(inspected.providerClass, "railway");
    for (const part of Object.values(SECRET_PARTS)) {
      assert.ok(!JSON.stringify(inspected).includes(part));
    }
  });
});

describe("database recovery diagnostic — read-only and shape", () => {
  it("6 — every statement is a SELECT, and the connection is always released", async () => {
    const { fake } = await run(LIVE_URL);
    assert.ok(fake.statements.length >= 3, "it actually queried");
    for (const sql of fake.statements) {
      assert.match(sql.trim(), /^SELECT\b/i, `not a SELECT: ${sql.trim().slice(0, 40)}`);
      for (const write of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "DROP", "CREATE", "ALTER", "GRANT"]) {
        assert.ok(!new RegExp(`\\b${write}\\b`, "i").test(sql), `${write} in a diagnostic query`);
      }
    }
    assert.equal(fake.disconnected, 1, "disconnected exactly once");
  });

  it("6b — the connection is released even when the first query fails", async () => {
    const fake = fakeClient({ fail: () => true });
    await run(LIVE_URL, { fake });
    assert.equal(fake.disconnected, 1);
  });

  it("6c — the service source contains no write verb and no unsafe raw helper", () => {
    const body = serviceSource.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      "$executeRaw",
      "$executeRawUnsafe",
      "$queryRawUnsafe",
      "$transaction",
      ".create(",
      ".update(",
      ".upsert(",
      ".delete(",
      ".deleteMany(",
      "INSERT",
      "UPDATE ",
      "DELETE",
      "TRUNCATE",
      "DROP",
    ]) {
      assert.ok(!body.includes(forbidden), `service uses ${forbidden}`);
    }
  });

  it("6d — the response has exactly the agreed keys and JSON-safe values", async () => {
    const { result } = await run(LIVE_URL);
    assert.deepEqual(Object.keys(result).sort(), [
      "connectionOk",
      "databaseIdentity",
      "directUrlPresent",
      "directUrlValidPostgresScheme",
      "errorCategory",
      "migrationFingerprint",
      "providerClass",
      "rowCountFingerprint",
    ]);
    assert.deepEqual(Object.keys(result.databaseIdentity).sort(), [
      "fieldRegistryTableExists",
      "marketplaceAccountTableExists",
      "prismaMigrationsTableExists",
      "rawPayloadsTableExists",
      "supplierCampaignsTableExists",
      "userTableExists",
    ]);
    assert.deepEqual(Object.keys(result.migrationFingerprint).sort(), [
      "appliedCount",
      "firstMigration",
      "lastMigration",
    ]);
    assert.deepEqual(Object.keys(result.rowCountFingerprint).sort(), [
      "marketplaceAccounts",
      "rawPayloads",
      "supplierCampaigns",
      "users",
    ]);
    assert.ok(result.errorCategory === null || DIAGNOSTIC_ERROR_CATEGORIES.includes(result.errorCategory));
    // No BigInt anywhere: counts are cast to int in SQL so the response can be serialised.
    assert.doesNotThrow(() => JSON.stringify(result));
  });

  it("6e — a database missing our tables reports absence rather than failing", async () => {
    const { result, fake } = await run(LIVE_URL, { fake: fakeClient({ tables: [] }) });
    assert.equal(result.connectionOk, true);
    assert.equal(result.errorCategory, null);
    for (const value of Object.values(result.databaseIdentity)) assert.equal(value, false);
    assert.deepEqual(result.rowCountFingerprint, {
      users: null,
      marketplaceAccounts: null,
      rawPayloads: null,
      supplierCampaigns: null,
    });
    // Crucially: it did not try to count rows in tables that are not there.
    assert.ok(!fake.statements.some((sql) => /COUNT\(\*\)::int AS count FROM/.test(sql)));
  });

  it("6f — the expected repo fingerprint is reported verbatim when present", async () => {
    const { result } = await run(LIVE_URL);
    assert.equal(result.migrationFingerprint.appliedCount, 57);
    assert.equal(result.migrationFingerprint.firstMigration, "20260429083809_init_schema");
    assert.equal(result.migrationFingerprint.lastMigration, "20260903060000_expand_supplier_keys");
  });

  it("6g — the handler sets no-store and returns the service result unchanged", async () => {
    const app = express();
    app.get(ROUTE, databaseRecoveryDiagnosticHandler);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const previous = process.env.DIRECT_URL;
      delete process.env.DIRECT_URL;
      const res = await fetch(`http://127.0.0.1:${server.address().port}${ROUTE}`);
      const body = await res.json();
      if (previous !== undefined) process.env.DIRECT_URL = previous;

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("pragma"), "no-cache");
      assert.equal(body.data.errorCategory, "MISSING_URL");
      assert.equal(body.data.directUrlPresent, false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("database recovery diagnostic — nothing else changed", () => {
  it("7 — the runtime Prisma singleton is untouched and never imported by the diagnostic", () => {
    const prismaSource = readFileSync("src/database/prisma.js", "utf8");
    assert.match(prismaSource, /export const prisma = new PrismaClient\(\);/);
    assert.ok(
      !serviceSource.includes("database/prisma.js"),
      "the diagnostic must not use the runtime client",
    );
    // It builds its own client with an explicit datasource override.
    assert.match(serviceSource, /new PrismaClient\(\{\s*\n\s*datasources: \{ db: \{ url \} \}/);
  });

  it("7b — DATABASE_URL is never read by the diagnostic", () => {
    // Prose may name it; code may not read it. Comments are stripped before the check.
    const body = serviceSource.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, "");
    assert.ok(!body.includes("DATABASE_URL"), "the diagnostic reads DIRECT_URL only");
    assert.ok(body.includes("process.env.DIRECT_URL"));
  });

  it("7c — the diagnostic writes nothing through the audit trail", () => {
    const start = routesSource.indexOf(`"${ROUTE}"`);
    const block = routesSource.slice(start, routesSource.indexOf(");", start));
    // auditAction() calls logAccess(), which INSERTs an AccessLog row.
    assert.ok(!block.includes("auditAction"), "the diagnostic route must not write an audit row");
  });

  it("7d — existing auth middleware is unchanged in behaviour", () => {
    assert.match(authSource, /export function requirePermission\(\.\.\.requiredPermissions\) \{/);
    assert.match(authSource, /roleHasAnyPermission\(req\.user\.role, requiredPermissions\)/);
    assert.match(authSource, /export function requireEntityTypeAccess\(req, res, next\) \{/);
    assert.match(authSource, /export async function authenticate\(req, res, next\) \{/);
    // The new middleware is additive: it is a separate export, not an edit to an existing one.
    assert.equal(authSource.split("export function requireAdminRole").length - 1, 1);
  });

  it("7e — the certification routes are still wired exactly as before", () => {
    for (const path of [
      '"/ops/admin/network-certification"',
      '"/ops/admin/network-certification/:network/run"',
    ]) {
      const start = routesSource.indexOf(path);
      assert.ok(start > 0, `${path} still registered`);
      const block = routesSource.slice(start, routesSource.indexOf(");", start));
      assert.match(block, /authenticate,/);
      assert.match(block, /requirePermission\(PERMISSIONS\.INTEGRATIONS_MANAGE\),/);
      assert.match(block, /noStoreHeaders,/);
    }
    assert.ok(routesSource.includes("certificationRateLimiter"), "the limiter is still mounted");
  });

  it("7f — the diagnostic adds no dependency and no schema change", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    assert.ok(!Object.keys(pkg.dependencies).some((d) => d.includes("accelerate")));
    assert.equal(pkg.scripts.build, "prisma generate");
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    assert.match(schema, /url\s+= env\("DATABASE_URL"\)/);
    assert.match(schema, /directUrl = env\("DIRECT_URL"\)/);
  });
});
