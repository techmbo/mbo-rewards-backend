import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Minimum environment for createApp(); mirrors test/p8.databaseRecoveryRouteMount.test.js.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.LOG_LEVEL = "silent";

const TOKEN = "zzmigrationglasszz-0123456789abcdef-0123456789";

const {
  EXPECTED_APPLIED_COUNT_AFTER,
  EXPECTED_APPLIED_COUNT_BEFORE,
  EXPECTED_CHECKSUM,
  EXPECTED_PRECEDING_MIGRATION,
  MIGRATION_NAME,
  MIGRATION_STATEMENTS,
  MIGRATION_STATUS,
  NEW_COLUMNS,
  NEW_ENUM_TYPES,
  NEW_INDEX,
  computeMigrationChecksum,
} = await import("../src/modules/ops/partnerizeTrackingMigration.service.js");

const { PARTNERIZE_TRACKING_MIGRATION_ROUTE_PATH } = await import(
  "../src/routes/partnerizeTrackingMigrationRoute.js"
);

const SERVICE_SRC = readFileSync(
  new URL("../src/modules/ops/partnerizeTrackingMigration.service.js", import.meta.url),
  "utf8",
);
const CONTROLLER_SRC = readFileSync(
  new URL("../src/controllers/partnerizeTrackingMigration.controller.js", import.meta.url),
  "utf8",
);
const ROUTE_SRC = readFileSync(
  new URL("../src/routes/partnerizeTrackingMigrationRoute.js", import.meta.url),
  "utf8",
);
const MIGRATION_SQL = readFileSync(
  new URL(`../prisma/migrations/${MIGRATION_NAME}/migration.sql`, import.meta.url),
  "utf8",
);

/**
 * Strip comments so "no X anywhere" assertions test executable code rather than prose. The files
 * deliberately explain in comments what they do NOT do, and a bare substring scan matches that.
 */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const SERVICE_CODE = code(SERVICE_SRC);
const CONTROLLER_CODE = code(CONTROLLER_SRC);
const ROUTE_CODE = code(ROUTE_SRC);

/* ------------------------------------------------------------------ constants */

test("the endpoint targets exactly the audited migration", () => {
  assert.equal(MIGRATION_NAME, "20260913090000_partnerize_supplier_tracking_link");
  assert.equal(EXPECTED_PRECEDING_MIGRATION, "20260903060000_expand_supplier_keys");
  assert.equal(EXPECTED_APPLIED_COUNT_BEFORE, 56);
  assert.equal(EXPECTED_APPLIED_COUNT_AFTER, 57);
  assert.equal(
    PARTNERIZE_TRACKING_MIGRATION_ROUTE_PATH,
    "/api/ops/diagnostics/apply-partnerize-tracking-migration",
  );
});

test("the runtime checksum matches the audited checksum and the file on disk", async () => {
  const computed = await computeMigrationChecksum();
  assert.equal(computed, EXPECTED_CHECKSUM);
  assert.equal(
    computed,
    "d008e553464fa0d8b99a6dfcc3c60b55164cd53b4e7edcb52b41061af4f28790",
  );
});

test("checksum is computed at runtime, never trusted from a constant alone", () => {
  // The comparison must be computed-vs-expected. A hard-coded value written straight into the
  // migration record could record a migration whose SQL had since changed.
  assert.ok(SERVICE_SRC.includes("createHash(\"sha256\")"));
  assert.ok(SERVICE_SRC.includes("checksum !== EXPECTED_CHECKSUM"));
  assert.ok(SERVICE_SRC.includes("CHECKSUM_MISMATCH"));
});

test("a tampered migration file fails the checksum gate before any write", async () => {
  const tampered = async () => Buffer.from("-- not the audited migration\n");
  const computed = await computeMigrationChecksum(tampered);
  assert.notEqual(computed, EXPECTED_CHECKSUM);
});

/* ------------------------------------------------------------- exact SQL only */

test("exactly five frozen statements, matching the audited migration", () => {
  assert.equal(MIGRATION_STATEMENTS.length, 5);
  assert.ok(Object.isFrozen(MIGRATION_STATEMENTS));
  const verbs = MIGRATION_STATEMENTS.map((s) => s.trim().split(/\s+/).slice(0, 2).join(" "));
  assert.deepEqual(verbs, [
    "CREATE TYPE",
    "CREATE TYPE",
    "ALTER TABLE",
    'UPDATE "supplier_campaigns"',
    "CREATE INDEX",
  ]);
});

test("every frozen statement appears in the audited migration.sql", () => {
  const normalise = (text) => text.replace(/\s+/g, " ").trim();
  const sql = normalise(MIGRATION_SQL);
  for (const statement of MIGRATION_STATEMENTS) {
    assert.ok(sql.includes(normalise(statement)), statement.slice(0, 48));
  }
});

test("statements touch only supplier_campaigns and the two new types", () => {
  for (const statement of MIGRATION_STATEMENTS) {
    const tables = [...statement.matchAll(/(?:ALTER TABLE|UPDATE|ON)\s+"([a-z_]+)"/gi)].map((m) => m[1]);
    for (const table of tables) assert.equal(table, "supplier_campaigns", statement.slice(0, 40));
  }
});

test("no destructive verb appears in any statement", () => {
  for (const statement of MIGRATION_STATEMENTS) {
    assert.doesNotMatch(statement, /\b(DROP|TRUNCATE|DELETE|GRANT|REVOKE)\b/i, statement.slice(0, 40));
  }
});

test("statements are executed one at a time, never as a multi-statement blob", () => {
  // $executeRawUnsafe rejects multi-statement strings (SQLSTATE 42601), and splitting arbitrary
  // SQL on semicolons is unsafe. The service iterates the frozen array instead.
  assert.ok(SERVICE_SRC.includes("for (const statement of MIGRATION_STATEMENTS)"));
  assert.ok(!SERVICE_SRC.includes(".split(\";\")"));
  for (const statement of MIGRATION_STATEMENTS) {
    assert.ok(!statement.includes(";"), "a frozen statement must not embed a terminator");
  }
});

/* ------------------------------------------------- no caller-controlled input */

test("no caller-controlled SQL, name, path, id or parameter reaches the service", () => {
  for (const source of [SERVICE_SRC, CONTROLLER_SRC]) {
    assert.ok(!/req\.body\.[a-z]/i.test(source), "no field is read off the body");
    assert.ok(!/req\.query/.test(source));
    assert.ok(!/req\.params/.test(source));
  }
  // The controller inspects the body only to reject a non-empty one.
  assert.ok(CONTROLLER_SRC.includes("BODY_NOT_ACCEPTED"));
  assert.ok(!/applyPartnerizeTrackingMigration\(\s*req/.test(CONTROLLER_SRC));
});

test("a non-empty body is rejected rather than ignored", async () => {
  const { applyPartnerizeTrackingMigrationHandler } = await import(
    "../src/controllers/partnerizeTrackingMigration.controller.js"
  );
  for (const body of [{ sql: "DROP TABLE x" }, "text", Buffer.from("x"), { anything: 1 }]) {
    let status = null;
    let payload = null;
    await applyPartnerizeTrackingMigrationHandler(
      { body },
      { status(code) { status = code; return this; }, json(value) { payload = value; } },
      () => assert.fail("next() must not be called for a rejected body"),
    );
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(payload.code, "BODY_NOT_ACCEPTED");
  }
});

test("an empty body is accepted by the body guard", async () => {
  const { applyPartnerizeTrackingMigrationHandler } = await import(
    "../src/controllers/partnerizeTrackingMigration.controller.js"
  );
  // No database here, so it must get past the guard and fail later — never at the guard.
  for (const body of [undefined, null, {}, ""]) {
    let status = null;
    let nexted = false;
    await applyPartnerizeTrackingMigrationHandler(
      { body },
      { status(code) { status = code; return this; }, json() {} },
      () => { nexted = true; },
    );
    assert.ok(status !== 400 || nexted, `empty body must pass the guard: ${JSON.stringify(body)}`);
  }
});

/* ---------------------------------------------------------------- middleware */

test("the route chain is exactly the approved order, ADMIN only", () => {
  const chain = ROUTE_SRC.slice(ROUTE_SRC.indexOf("app.post("), ROUTE_SRC.indexOf("  );"));
  const order = [
    "databaseRecoveryMarker",
    "requireDatabaseRecoveryToken",
    "authenticate",
    "requireAdminRole",
    "noStoreHeaders",
    "applyPartnerizeTrackingMigrationHandler",
  ];
  let cursor = -1;
  for (const name of order) {
    const at = chain.indexOf(name);
    assert.ok(at > cursor, `${name} out of order`);
    cursor = at;
  }
  // The break-glass token gate must precede authenticate, which performs a database lookup.
  assert.ok(chain.indexOf("requireDatabaseRecoveryToken") < chain.indexOf("authenticate"));
  assert.ok(!chain.includes("requirePermission"), "must not use a widenable permission check");
  assert.ok(!/TECH/.test(ROUTE_CODE), "must not be widened to TECH");

  // Exactly these six, and nothing else: a seventh entry or a dropped guard fails here.
  const args = code(chain)
    .slice(code(chain).indexOf("(") + 1)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  assert.deepEqual(args, [
    "PARTNERIZE_TRACKING_MIGRATION_ROUTE_PATH",
    ...order,
  ]);
});

test("requireAdminRole admits ADMIN only", async () => {
  const { requireAdminRole } = await import("../src/middleware/auth.js");
  const run = (user) => {
    let status = null;
    let nexted = false;
    requireAdminRole(
      { user },
      { status(code) { status = code; return this; }, json() {} },
      () => { nexted = true; },
    );
    return { status, nexted };
  };
  assert.deepEqual(run({ role: "ADMIN" }), { status: null, nexted: true });
  for (const role of ["TECH", "OPERATIONS", "ANALYST", "SUPPORT", "CLIENT"]) {
    assert.equal(run({ role }).status, 403, role);
  }
  assert.equal(run(null).status, 401);
});

/* ------------------------------------------------------- live route behaviour */

async function withApp(fn) {
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}${PARTNERIZE_TRACKING_MIGRATION_ROUTE_PATH}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test("the route is mounted and the app still boots", async () => {
  process.env.DB_RECOVERY_DIAGNOSTIC_TOKEN = TOKEN;
  await withApp(async (base) => {
    const res = await fetch(base, { method: "POST" });
    // Without a token the break-glass gate answers; it never reaches the handler.
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("x-db-recovery-route"), "break-glass-v1");
  });
});

test("no recovery token configured disables the route entirely", async () => {
  const previous = process.env.DB_RECOVERY_DIAGNOSTIC_TOKEN;
  delete process.env.DB_RECOVERY_DIAGNOSTIC_TOKEN;
  try {
    await withApp(async (base) => {
      const res = await fetch(base, {
        method: "POST",
        headers: { "x-db-recovery-token": TOKEN, authorization: "Bearer whatever" },
      });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.ok, false);
    });
  } finally {
    process.env.DB_RECOVERY_DIAGNOSTIC_TOKEN = previous;
  }
});

test("an invalid recovery token is rejected before authentication", async () => {
  process.env.DB_RECOVERY_DIAGNOSTIC_TOKEN = TOKEN;
  await withApp(async (base) => {
    for (const value of [
      "wrong-token-value-that-is-long-enough-000000",
      TOKEN.slice(0, -1),
      `${TOKEN}x`,
      "",
    ]) {
      const res = await fetch(base, {
        method: "POST",
        headers: { "x-db-recovery-token": value },
      });
      assert.equal(res.status, 401, JSON.stringify(value));
    }
  });
});

test("unauthenticated is rejected even with a valid recovery token", async () => {
  process.env.DB_RECOVERY_DIAGNOSTIC_TOKEN = TOKEN;
  await withApp(async (base) => {
    const res = await fetch(base, {
      method: "POST",
      headers: { "x-db-recovery-token": TOKEN },
    });
    assert.equal(res.status, 401);
  });
});

test("GET is not routed — the endpoint is POST only", async () => {
  process.env.DB_RECOVERY_DIAGNOSTIC_TOKEN = TOKEN;
  await withApp(async (base) => {
    const res = await fetch(base, { method: "GET", headers: { "x-db-recovery-token": TOKEN } });
    assert.notEqual(res.status, 200);
    assert.equal(res.headers.get("x-db-recovery-route"), null, "GET must not hit this route");
  });
});

/* ----------------------------------------------------------------- isolation */

test("no child_process, shell or Prisma CLI anywhere in the feature", () => {
  for (const source of [SERVICE_CODE, CONTROLLER_CODE, ROUTE_CODE]) {
    for (const banned of ["child_process", "spawnSync", "spawn(", "execSync", "exec(", "npx ", "migrate deploy"]) {
      assert.ok(!source.includes(banned), banned);
    }
  }
});

test("the connection string is never read, logged or returned", () => {
  for (const source of [SERVICE_CODE, CONTROLLER_CODE, ROUTE_CODE]) {
    for (const banned of ["DIRECT_URL", "DATABASE_URL", "console.log", "datasources", "process.env"]) {
      assert.ok(!source.includes(banned), banned);
    }
  }
  // The response shape is whitelisted explicitly.
  for (const banned of ["host", "hostname", "database\"", "username", "password", "url"]) {
    assert.ok(!CONTROLLER_SRC.includes(`${banned}:`), banned);
  }
});

test("the response exposes only counts, booleans and fixed codes", () => {
  const shape = CONTROLLER_SRC.slice(
    CONTROLLER_SRC.indexOf("function toResponse"),
    CONTROLLER_SRC.indexOf("function hasBody"),
  );
  const keys = [...shape.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys, [
    "ok",
    "status",
    "writesExecuted",
    "migrationName",
    "appliedMigrationCountBefore",
    "appliedMigrationCountAfter",
    "userCountBefore",
    "userCountAfter",
    "supplierCampaignCountBefore",
    "supplierCampaignCountAfter",
    "columnsVerified",
    "enumsVerified",
    "indexVerified",
  ]);
});

test("all work happens inside one transaction", () => {
  assert.equal((SERVICE_SRC.match(/\$transaction\(/g) || []).length, 1);
  // Every write goes through the transaction handle, never the bare client.
  assert.ok(!/\bprisma\.\$executeRaw/.test(SERVICE_SRC));
  assert.ok(!/\bclient\.\$executeRaw/.test(SERVICE_SRC));
  assert.ok(SERVICE_SRC.includes("tx.$executeRawUnsafe"));
});

test("the already-applied check precedes every write", () => {
  const alreadyAt = SERVICE_SRC.indexOf("MIGRATION_STATUS.ALREADY_APPLIED");
  const firstWriteAt = SERVICE_SRC.indexOf("tx.$executeRawUnsafe");
  assert.ok(alreadyAt > 0 && alreadyAt < firstWriteAt, "the no-op path must return before any write");
});

test("the migration record uses the Prisma-compatible row shape", () => {
  for (const column of [
    "id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at",
    "started_at", "applied_steps_count",
  ]) {
    assert.ok(SERVICE_SRC.includes(column), column);
  }
  assert.ok(SERVICE_SRC.includes("randomUUID()"));
});

test("the expected schema objects are pinned", () => {
  assert.deepEqual([...NEW_COLUMNS], [
    "supplierTrackingLinkState",
    "supplierTrackingLinkProvenance",
    "supplierTrackingLinkUpdatedAt",
    "supplierTrackingLinkUpdatedBy",
  ]);
  assert.deepEqual([...NEW_ENUM_TYPES], [
    "SupplierTrackingLinkState",
    "SupplierTrackingLinkProvenance",
  ]);
  assert.equal(NEW_INDEX, "supplier_campaigns_supplier_supplierTrackingLinkState_idx");
  assert.deepEqual(MIGRATION_STATUS, { APPLIED: "APPLIED", ALREADY_APPLIED: "ALREADY_APPLIED" });
});

/* ------------------------------------------------ gate behaviour, no database */

const {
  MigrationPreconditionError,
  applyPartnerizeTrackingMigration,
} = await import("../src/modules/ops/partnerizeTrackingMigration.service.js");

/**
 * A stand-in for the Prisma client that answers the service's reads from a described database
 * state. It records every statement executed, so "zero writes" is asserted directly rather than
 * inferred. The service takes its client by injection precisely so the gates can be exercised
 * without a live database.
 */
function fakeClient({
  applied = Array.from({ length: 56 }, (_, i) =>
    i === 0 ? EXPECTED_PRECEDING_MIGRATION : `2026010100000${i}_older`),
  checksums = new Map(),
  users = 5,
  campaigns = 6,
  trackingUrls = 2,
  columns = [],
  enums = [],
  index = 0,
  tableExists = 1,
} = {}) {
  const executed = [];
  const state = { applied: [...applied], columns: [...columns], enums: [...enums], index };

  const query = async (sql, ...params) => {
    if (sql.includes("from _prisma_migrations")) {
      return state.applied.map((name) => ({
        migration_name: name,
        checksum: checksums.get(name) ?? "x",
      }));
    }
    if (sql.includes('from "User"')) return [{ n: users }];
    if (sql.includes("information_schema.tables")) return [{ n: tableExists }];
    if (sql.includes("information_schema.columns")) {
      return state.columns.map((column_name) => ({ column_name }));
    }
    if (sql.includes("from pg_type")) return state.enums.map((typname) => ({ typname }));
    if (sql.includes("from pg_indexes")) return [{ n: state.index }];
    if (sql.includes("TRACKING_LINK_AVAILABLE")) return [{ n: trackingUrls }];
    if (sql.includes("TRACKING_LINK_NOT_GENERATED")) return [{ n: campaigns - trackingUrls }];
    if (sql.includes('"trackingUrl" is not null')) return [{ n: trackingUrls }];
    if (sql.includes("from supplier_campaigns")) return [{ n: campaigns }];
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  };

  const tx = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: async (sql, ...params) => {
      executed.push(sql);
      // Reflect the effect so post-verification sees a consistent database.
      if (sql.startsWith("CREATE TYPE")) state.enums.push(sql.match(/"([A-Za-z]+)"/)[1]);
      if (sql.startsWith("ALTER TABLE")) state.columns.push(...NEW_COLUMNS);
      if (sql.startsWith("CREATE INDEX")) state.index = 1;
      if (sql.includes("insert into _prisma_migrations")) {
        state.applied.unshift(MIGRATION_NAME);
        checksums.set(MIGRATION_NAME, params[1]);
      }
      return 1;
    },
  };

  return { executed, $transaction: async (fn) => fn(tx) };
}

test("a healthy database applies and reports the expected summary", async () => {
  const client = fakeClient();
  const result = await applyPartnerizeTrackingMigration({ client });
  assert.equal(result.status, MIGRATION_STATUS.APPLIED);
  assert.equal(result.writesExecuted, 6);
  assert.equal(result.appliedMigrationCountBefore, 56);
  assert.equal(result.appliedMigrationCountAfter, 57);
  assert.ok(result.columnsVerified && result.enumsVerified && result.indexVerified);
  assert.equal(client.executed.length, 6, "five statements plus one migration record");
});

test("counts are captured before and reported unchanged, not hard-coded to 7", async () => {
  for (const users of [1, 5, 7, 42]) {
    const result = await applyPartnerizeTrackingMigration({ client: fakeClient({ users }) });
    assert.equal(result.userCountBefore, users);
    assert.equal(result.userCountAfter, users);
  }
  const result = await applyPartnerizeTrackingMigration({ client: fakeClient({ campaigns: 9, trackingUrls: 3 }) });
  assert.equal(result.supplierCampaignCountBefore, 9);
  assert.equal(result.supplierCampaignCountAfter, 9);
});

test("ONE-SHOT: an already-applied migration returns ALREADY_APPLIED with zero writes", async () => {
  const client = fakeClient({ applied: [MIGRATION_NAME, EXPECTED_PRECEDING_MIGRATION] });
  const result = await applyPartnerizeTrackingMigration({ client });
  assert.equal(result.status, MIGRATION_STATUS.ALREADY_APPLIED);
  assert.equal(result.writesExecuted, 0);
  assert.equal(client.executed.length, 0, "no statement may be executed on a repeat call");
  assert.equal(result.columnsVerified, false);
});

test("a second call after a successful apply is ALREADY_APPLIED with zero further writes", async () => {
  const client = fakeClient();
  await applyPartnerizeTrackingMigration({ client });
  const executedAfterFirst = client.executed.length;
  const again = await applyPartnerizeTrackingMigration({ client });
  assert.equal(again.status, MIGRATION_STATUS.ALREADY_APPLIED);
  assert.equal(again.writesExecuted, 0);
  assert.equal(client.executed.length, executedAfterFirst, "the repeat call added no writes");
});

test("a wrong applied count fails before any write", async () => {
  const client = fakeClient({ applied: [EXPECTED_PRECEDING_MIGRATION, "x_older"] });
  await assert.rejects(
    () => applyPartnerizeTrackingMigration({ client }),
    (error) => {
      assert.ok(error instanceof MigrationPreconditionError);
      assert.equal(error.code, "UNEXPECTED_APPLIED_COUNT");
      assert.equal(error.detail.expected, 56);
      return true;
    },
  );
  assert.equal(client.executed.length, 0);
});

test("a wrong latest migration fails before any write", async () => {
  const applied = Array.from({ length: 56 }, (_, i) => (i === 0 ? "29990101000000_someone_else" : `x${i}`));
  const client = fakeClient({ applied });
  await assert.rejects(
    () => applyPartnerizeTrackingMigration({ client }),
    (error) => error.code === "UNEXPECTED_LATEST_MIGRATION",
  );
  assert.equal(client.executed.length, 0);
});

test("an existing column fails cleanly before any write", async () => {
  const client = fakeClient({ columns: ["supplierTrackingLinkState"] });
  await assert.rejects(
    () => applyPartnerizeTrackingMigration({ client }),
    (error) => error.code === "COLUMN_ALREADY_EXISTS",
  );
  assert.equal(client.executed.length, 0);
});

test("an existing enum type fails cleanly before any write", async () => {
  const client = fakeClient({ enums: ["SupplierTrackingLinkState"] });
  await assert.rejects(
    () => applyPartnerizeTrackingMigration({ client }),
    (error) => error.code === "ENUM_TYPE_ALREADY_EXISTS",
  );
  assert.equal(client.executed.length, 0, "CREATE TYPE would abort the transaction; catch it first");
});

test("an existing index fails cleanly before any write", async () => {
  const client = fakeClient({ index: 1 });
  await assert.rejects(
    () => applyPartnerizeTrackingMigration({ client }),
    (error) => error.code === "INDEX_ALREADY_EXISTS",
  );
  assert.equal(client.executed.length, 0);
});

test("a missing supplier_campaigns table fails before any write", async () => {
  const client = fakeClient({ tableExists: 0 });
  await assert.rejects(
    () => applyPartnerizeTrackingMigration({ client }),
    (error) => error.code === "SUPPLIER_CAMPAIGNS_TABLE_MISSING",
  );
  assert.equal(client.executed.length, 0);
});

test("the executed statements are exactly the five audited ones plus the record", async () => {
  const client = fakeClient();
  await applyPartnerizeTrackingMigration({ client });
  assert.deepEqual(client.executed.slice(0, 5), [...MIGRATION_STATEMENTS]);
  assert.ok(client.executed[5].includes("insert into _prisma_migrations"));
  for (const statement of client.executed) {
    assert.doesNotMatch(statement, /\b(DROP|TRUNCATE|DELETE)\b/i);
  }
});

/* --------------------------------------------------- existing surfaces intact */

test("the existing DB recovery diagnostic is unchanged", () => {
  const existing = readFileSync(
    new URL("../src/routes/databaseRecoveryRoute.js", import.meta.url),
    "utf8",
  );
  assert.ok(existing.includes("/api/ops/diagnostics/database-recovery"));
  assert.ok(existing.includes("app.get("));
  assert.ok(!existing.includes("apply-partnerize-tracking-migration"));
  assert.ok(!existing.includes("requireAdminRole"), "the read-only diagnostic keeps its own gate");
});

test("app.js adds only the mount, ahead of the /api router", () => {
  const appSrc = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.ok(appSrc.includes("registerPartnerizeTrackingMigrationRoute(app)"));
  assert.ok(
    appSrc.indexOf("registerPartnerizeTrackingMigrationRoute(app)") <
      appSrc.indexOf('app.use("/api", routes)'),
  );
  assert.equal((appSrc.match(/registerPartnerizeTrackingMigrationRoute\(app\)/g) || []).length, 1);
});

test("normal application routes are untouched by this feature", () => {
  const routesSrc = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
  assert.ok(!routesSrc.includes("apply-partnerize-tracking-migration"));
  assert.ok(!routesSrc.includes("partnerizeTrackingMigration"));
});
