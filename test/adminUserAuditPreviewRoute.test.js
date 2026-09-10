/**
 * TEMPORARY Preview-only, READ-ONLY staff user metadata audit — route tests.
 *
 * Proves: (1) no token → 401, (2) wrong token → 403, (3) a valid token returns
 * only the allowed fields, (4) CLIENT users are excluded, (5) password / token
 * fields can never appear, (6) no database mutation method is ever called —
 * plus the Preview-only 404, fail-closed 403 when the token is unconfigured,
 * lazy Prisma loading (loader-hook proof in a child process), constant-time
 * comparison, generic error replacement and the router mount.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ADMIN_USER_AUDIT_TOKEN_ENV,
  ADMIN_USER_AUDIT_TOKEN_HEADER,
  ALLOWED_USER_FIELDS,
  ALLOWED_USER_SELECT,
  EXCLUDED_ROLE,
  FORBIDDEN_USER_FIELDS,
  PREVIEW_ADMIN_USER_AUDIT_ROUTE,
  STAFF_ROLES,
  USER_ROW_LIMIT,
  assertSafeOutput,
  buildCountsByRole,
  createAdminUserAuditPreviewHandler,
  evaluateGates,
  isStaffRow,
  projectUserRow,
  readOnlyUserReader,
  tokenMatches,
} from "../src/routes/internal/adminUserAuditPreview.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_PATH = path.join(here, "..", "src", "routes", "internal", "adminUserAuditPreview.js");
const ROUTER_PATH = path.join(here, "..", "src", "routes", "index.js");

const REAL_TOKEN = "temporary-admin-user-audit-token-value";
const previewEnv = { VERCEL_ENV: "preview", [ADMIN_USER_AUDIT_TOKEN_ENV]: REAL_TOKEN };
const NOW = new Date("2026-09-10T12:00:00.000Z");

// Sentinels that must never leave the handler.
const LEAKED_HASH = "$2b$12$SENTINEL-PASSWORD-HASH-VALUE";
const LEAKED_INVITE = "invite-token-hash-SENTINEL";
const LEAKED_CLIENT_EMAIL = "portal-user@client.example";

function mockRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

function fixtureRows() {
  const d = (iso) => new Date(iso);
  const staff = (id, email, role, isActive, createdAt, name = null) => ({
    id, email, name, role, isActive, createdAt: d(createdAt),
    // Forbidden columns present on every row to prove they are dropped.
    passwordHash: LEAKED_HASH,
    inviteTokenHash: LEAKED_INVITE,
    inviteExpiresAt: d("2026-12-01T00:00:00.000Z"),
    passwordSetAt: d("2026-01-02T00:00:00.000Z"),
    clientId: null,
    updatedAt: d("2026-09-01T00:00:00.000Z"),
  });
  return [
    staff("u-1", "owner@example.com", "ADMIN", true, "2026-01-01T00:00:00.000Z", "Owner"),
    staff("u-2", "ops@example.com", "OPERATIONS", true, "2026-02-01T00:00:00.000Z"),
    staff("u-3", "former-admin@example.com", "ADMIN", false, "2026-03-01T00:00:00.000Z"),
    staff("u-4", "support@example.com", "SUPPORT", true, "2026-04-01T00:00:00.000Z"),
    { ...staff("u-5", LEAKED_CLIENT_EMAIL, "CLIENT", true, "2026-05-01T00:00:00.000Z"), clientId: "client-1" },
  ];
}

/**
 * Fake Prisma: `user` is a Proxy that throws on ANY property other than the
 * two read methods, so a stray write or raw call fails loudly. `leaky` makes
 * findMany ignore `select`/`where` and return full rows including CLIENT.
 */
function fakePrisma(rows, { leaky = false, failWith = null } = {}) {
  const calls = [];
  const applyWhere = (list) => list.filter((r) => r.role !== EXCLUDED_ROLE);
  const model = {
    async findMany(args) {
      calls.push({ method: "findMany", args });
      if (failWith) throw failWith;
      const base = leaky ? rows : applyWhere(rows);
      const limited = base.slice(0, args?.take ?? base.length);
      if (leaky || !args?.select) return limited.map((r) => ({ ...r }));
      return limited.map((r) => Object.fromEntries(Object.keys(args.select).filter((k) => args.select[k]).map((k) => [k, r[k]])));
    },
    async groupBy(args) {
      calls.push({ method: "groupBy", args });
      if (failWith) throw failWith;
      const base = leaky ? rows : applyWhere(rows);
      const counts = new Map();
      for (const r of base) counts.set(r.role, (counts.get(r.role) ?? 0) + 1);
      return [...counts.entries()].map(([role, n]) => ({ role, _count: { _all: n } }));
    },
  };
  const trap = new Proxy(model, {
    get(target, prop) {
      if (prop === "findMany" || prop === "groupBy") return target[prop];
      if (typeof prop === "symbol" || prop === "then") return undefined;
      throw new Error(`fake user model: forbidden method accessed: ${String(prop)}`);
    },
  });
  const client = new Proxy({ user: trap }, {
    get(target, prop) {
      if (prop === "user") return target.user;
      if (typeof prop === "symbol" || prop === "then") return undefined;
      throw new Error(`fake prisma: forbidden client member accessed: ${String(prop)}`);
    },
  });
  return { prisma: client, calls };
}

async function invoke({ env = previewEnv, headers = {}, rows = fixtureRows(), leaky = false, failWith = null } = {}) {
  const loads = { count: 0 };
  const fake = fakePrisma(rows, { leaky, failWith });
  const handler = createAdminUserAuditPreviewHandler({
    env,
    now: () => NOW,
    loadDependencies: async () => { loads.count += 1; return { prisma: fake.prisma }; },
  });
  const res = mockRes();
  let nextError = null;
  await handler({ headers, body: { ignored: true }, query: { ignored: true } }, res, (err) => { nextError = err; });
  return { res, nextError, loads, calls: fake.calls };
}

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => collectKeys(v, keys));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { keys.add(k); collectKeys(v, keys); }
  return keys;
}

// ---------------------------------------------------------------------------

test("non-preview runtime (production / development): 404 like an unknown route, database never loaded", async () => {
  for (const env of [{}, { VERCEL_ENV: "production", [ADMIN_USER_AUDIT_TOKEN_ENV]: REAL_TOKEN }, { VERCEL_ENV: "development", [ADMIN_USER_AUDIT_TOKEN_ENV]: REAL_TOKEN }]) {
    const { res, loads } = await invoke({ env, headers: { [ADMIN_USER_AUDIT_TOKEN_HEADER]: REAL_TOKEN } });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { ok: false, message: "Not found." });
    assert.equal(loads.count, 0);
  }
});

test("fail closed: token env unset or blank in Preview → 403, database never loaded, even with a header", async () => {
  for (const env of [{ VERCEL_ENV: "preview" }, { VERCEL_ENV: "preview", [ADMIN_USER_AUDIT_TOKEN_ENV]: "" }, { VERCEL_ENV: "preview", [ADMIN_USER_AUDIT_TOKEN_ENV]: "   " }]) {
    const { res, loads } = await invoke({ env, headers: { [ADMIN_USER_AUDIT_TOKEN_HEADER]: "anything" } });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.ok, false);
    assert.equal(loads.count, 0);
  }
});

test("1. no token header → 401, database never loaded", async () => {
  for (const headers of [{}, { [ADMIN_USER_AUDIT_TOKEN_HEADER]: "" }, { "x-other": REAL_TOKEN }]) {
    const { res, loads, calls } = await invoke({ headers });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { ok: false, message: "Audit token required." });
    assert.equal(loads.count, 0);
    assert.equal(calls.length, 0);
  }
});

test("2. wrong token → 403, database never loaded; the response never echoes any token", async () => {
  for (const wrong of ["wrong", REAL_TOKEN.slice(0, -1), `${REAL_TOKEN} `, REAL_TOKEN.toUpperCase()]) {
    const { res, loads, calls } = await invoke({ headers: { [ADMIN_USER_AUDIT_TOKEN_HEADER]: wrong } });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { ok: false, message: "Invalid audit token." });
    assert.equal(loads.count, 0);
    assert.equal(calls.length, 0);
    assert.ok(!JSON.stringify(res.body).includes(REAL_TOKEN));
    assert.ok(!JSON.stringify(res.body).includes(wrong));
  }
  // Gate evaluation never returns the token either.
  const rejection = evaluateGates(previewEnv, { [ADMIN_USER_AUDIT_TOKEN_HEADER]: "nope" });
  assert.ok(!JSON.stringify(rejection).includes(REAL_TOKEN));
});

test("token comparison is constant-time-shaped and exact", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf8");
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /timingSafeEqual/);
  assert.equal(tokenMatches(REAL_TOKEN, REAL_TOKEN), true);
  assert.equal(tokenMatches("", REAL_TOKEN), false);
  assert.equal(tokenMatches(REAL_TOKEN, ""), false);
  assert.equal(tokenMatches(undefined, REAL_TOKEN), false);
  assert.equal(tokenMatches(`${REAL_TOKEN}x`, REAL_TOKEN), false);
});

test("3. valid token → 200 with counts and user rows carrying EXACTLY the allowed fields", async () => {
  const { res, nextError, loads, calls } = await invoke({ headers: { [ADMIN_USER_AUDIT_TOKEN_HEADER]: REAL_TOKEN } });
  assert.equal(nextError, null);
  assert.equal(res.statusCode, 200);
  assert.equal(loads.count, 1);
  const body = res.body;
  assert.equal(body.ok, true);
  assert.equal(body.generatedAt, NOW.toISOString());
  assert.equal(body.totalStaffUsers, 4);
  assert.equal(body.adminCount, 2);
  assert.equal(body.activeAdminCount, 1);
  assert.deepEqual(body.countsByRole, { ADMIN: 2, OPERATIONS: 1, ANALYST: 0, TECH: 0, SUPPORT: 1 });
  assert.equal(body.truncated, false);
  assert.equal(body.users.length, 4);
  for (const row of body.users) {
    assert.deepEqual(Object.keys(row).sort(), [...ALLOWED_USER_FIELDS].sort());
    assert.equal(typeof row.createdAt, "string");
  }
  assert.deepEqual(body.users[0], { id: "u-1", email: "owner@example.com", name: "Owner", role: "ADMIN", isActive: true, createdAt: "2026-01-01T00:00:00.000Z" });
  // The select sent to the database is exactly the allowlist, and the query ignores the request.
  const findMany = calls.find((c) => c.method === "findMany");
  assert.deepEqual(findMany.args.select, { ...ALLOWED_USER_SELECT });
  assert.deepEqual(findMany.args.where, { role: { not: EXCLUDED_ROLE } });
  assert.equal(findMany.args.take, USER_ROW_LIMIT);
  assert.ok(!JSON.stringify(calls).includes("ignored"), "request body/query never reach a query");
  assert.deepEqual(calls.map((c) => c.method).sort(), ["findMany", "groupBy"]);
});

test("4. CLIENT users are excluded: filtered in the query AND dropped even when the database layer returns them", async () => {
  const strict = await invoke({ headers: { [ADMIN_USER_AUDIT_TOKEN_HEADER]: REAL_TOKEN } });
  assert.ok(!strict.res.body.users.some((u) => u.role === "CLIENT"));
  assert.ok(!JSON.stringify(strict.res.body).includes(LEAKED_CLIENT_EMAIL));
  for (const call of strict.calls) assert.deepEqual(call.args.where, { role: { not: "CLIENT" } });
  assert.equal(strict.res.body.countsByRole.CLIENT, undefined);

  const leaky = await invoke({ headers: { [ADMIN_USER_AUDIT_TOKEN_HEADER]: REAL_TOKEN }, leaky: true });
  assert.equal(leaky.res.statusCode, 200);
  assert.equal(leaky.res.body.users.length, 4);
  assert.ok(!leaky.res.body.users.some((u) => u.role === "CLIENT"));
  assert.ok(!JSON.stringify(leaky.res.body).includes(LEAKED_CLIENT_EMAIL));
  assert.equal(leaky.res.body.countsByRole.CLIENT, undefined);
  assert.equal(leaky.res.body.totalStaffUsers, 4, "a leaked CLIENT group never counts as staff");
  assert.equal(isStaffRow({ role: "client" }), false);
  assert.equal(isStaffRow({ role: "ADMIN" }), true);
});

test("5. password / token / invite / clientId fields can never appear — even when the database layer leaks full rows", async () => {
  for (const leaky of [false, true]) {
    const { res, nextError, calls } = await invoke({ headers: { [ADMIN_USER_AUDIT_TOKEN_HEADER]: REAL_TOKEN }, leaky });
    assert.equal(nextError, null, `leaky=${leaky}`);
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes(LEAKED_HASH), `no password hash (leaky=${leaky})`);
    assert.ok(!serialized.includes(LEAKED_INVITE), `no invite token hash (leaky=${leaky})`);
    const keys = collectKeys(res.body);
    for (const forbidden of FORBIDDEN_USER_FIELDS) assert.ok(!keys.has(forbidden), `no "${forbidden}" key (leaky=${leaky})`);
    for (const key of keys) assert.doesNotMatch(key, /password|token|secret|hash|credential/i, `key "${key}" looks credential-shaped`);
    for (const call of calls.filter((c) => c.method === "findMany")) {
      for (const forbidden of FORBIDDEN_USER_FIELDS) assert.equal(call.args.select[forbidden], undefined, `select never includes ${forbidden}`);
    }
  }
  // The final guard itself refuses credential-shaped or off-allowlist keys.
  assert.throws(() => assertSafeOutput({ users: [{ ...projectUserRow(fixtureRows()[0]), passwordHash: "x" }] }), /Forbidden key "passwordHash"/);
  assert.throws(() => assertSafeOutput({ meta: { resetToken: "x" }, users: [] }), /Forbidden key "resetToken"/);
  assert.throws(() => assertSafeOutput({ users: [{ id: "1", email: "a@b", name: null, role: "ADMIN", isActive: true, createdAt: null, updatedAt: null }] }), /Forbidden key "updatedAt"/);
  assert.throws(() => assertSafeOutput({ users: [{ id: "1", email: "a@b", role: "ADMIN" }] }), /outside the allowlist/);
  assert.throws(() => assertSafeOutput({ users: [{ ...projectUserRow(fixtureRows()[0]), role: "CLIENT" }] }), /not a staff role/);
  // Projection drops everything but the allowlist.
  assert.deepEqual(Object.keys(projectUserRow(fixtureRows()[0])).sort(), [...ALLOWED_USER_FIELDS].sort());
});

test("6. no database mutation is possible: no write/raw/transaction call in source, reader exposes only findMany/groupBy, any other access throws", async () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf8");
  assert.ok(!/\b(prisma|user|model|reader|db|tx|client)\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/.test(source), "no Prisma write call");
  assert.ok(!/\.(createMany|updateMany|deleteMany|upsert)\s*\(/.test(source), "no bulk write of any kind");
  assert.ok(!/\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe|transaction|connect|disconnect)\b/.test(source), "no raw SQL or transaction");
  // Judge code, not the header comment that lists what the module must avoid.
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/jobRunner|runTrackedJob|enqueue|scheduler|aggregation|sync\.job/i.test(codeOnly), "no job, scheduler or aggregation code path");
  assert.ok(!/logger|console\./.test(codeOnly), "module never logs");
  // Every .update( in the module is a SHA-256 digest update (one per side of the constant-time compare).
  const updateCalls = (source.match(/\.update\(/g) ?? []).length;
  const digestUpdates = (source.match(/createHash\("sha256"\)\.update\(/g) ?? []).length;
  assert.equal(updateCalls, 2);
  assert.equal(digestUpdates, updateCalls, "no .update( other than the hash digests");

  const reader = readOnlyUserReader({ user: { findMany: async () => [], groupBy: async () => [], update: async () => "x", delete: async () => "x", create: async () => "x" } });
  assert.deepEqual(Object.keys(reader).sort(), ["findMany", "groupBy"]);
  assert.equal(reader.update, undefined);
  assert.equal(reader.delete, undefined);
  assert.equal(reader.create, undefined);
  assert.ok(Object.isFrozen(reader));
  assert.throws(() => readOnlyUserReader({ user: { findMany: async () => [] } }), /read methods are unavailable/);

  // The trap-backed fake throws on any non-read access; a successful run therefore proves only reads happened.
  const { res, calls } = await invoke({ headers: { [ADMIN_USER_AUDIT_TOKEN_HEADER]: REAL_TOKEN } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual([...new Set(calls.map((c) => c.method))].sort(), ["findMany", "groupBy"]);
});

test("statically: the only top-level import is node:crypto; Prisma is reached only via a dynamic import after the gates", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf8");
  const topLevelImports = [...source.matchAll(/^import .*?from "([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(topLevelImports, ["node:crypto"]);
  assert.equal((source.match(/database\/prisma\.js/g) ?? []).length, 1);
  assert.match(source, /await import\("\.\.\/\.\.\/database\/prisma\.js"\)/);
  assert.ok(source.indexOf("evaluateGates(env, req?.headers)") < source.indexOf("await loadDependencies()"), "gates run before the database is loaded");
});

test("at runtime: importing the route module does not load Prisma (loader-hook proof in a child process)", () => {
  const hook = `
export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (result.url.includes("@prisma/client") || result.url.includes("/database/prisma.js") || result.url.includes("/.prisma/")) {
    throw new Error("PRISMA_LOADED:" + result.url);
  }
  return result;
}`;
  const script = `
import { register } from "node:module";
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});
const mod = await import(${JSON.stringify(pathToFileURL(ROUTE_PATH).href)});
if (typeof mod.adminUserAuditPreviewHandler !== "function") throw new Error("handler missing");
console.log("ROUTE_IMPORTED_WITHOUT_PRISMA");
`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.join(here, ".."),
    env: { PATH: process.env.PATH, NODE_ENV: "test" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(output, /ROUTE_IMPORTED_WITHOUT_PRISMA/);
});

test("router mounts the temporary route exactly once, as POST, via the handler (token gate, not the JWT middleware)", () => {
  const router = fs.readFileSync(ROUTER_PATH, "utf8");
  assert.equal((router.match(/adminUserAuditPreviewHandler/g) ?? []).length, 2, "imported once, mounted once");
  assert.match(router, /router\.post\(PREVIEW_ADMIN_USER_AUDIT_ROUTE, adminUserAuditPreviewHandler\);/);
  assert.match(router, /TEMPORARY/);
  assert.equal(PREVIEW_ADMIN_USER_AUDIT_ROUTE, "/internal/audit/admin-users");
  assert.equal(ADMIN_USER_AUDIT_TOKEN_ENV, "ADMIN_USER_AUDIT_TOKEN");
  assert.deepEqual([...STAFF_ROLES], ["ADMIN", "OPERATIONS", "ANALYST", "TECH", "SUPPORT"]);
});

test("countsByRole zero-fills every staff role and ignores CLIENT/unknown groups", () => {
  assert.deepEqual(buildCountsByRole([{ role: "ADMIN", _count: { _all: 1 } }, { role: "CLIENT", _count: { _all: 9 } }, { role: "WEIRD", _count: { _all: 2 } }]), { ADMIN: 1, OPERATIONS: 0, ANALYST: 0, TECH: 0, SUPPORT: 0 });
  assert.deepEqual(buildCountsByRole(undefined), { ADMIN: 0, OPERATIONS: 0, ANALYST: 0, TECH: 0, SUPPORT: 0 });
});

test("empty database: zero counts, empty users, no error", async () => {
  const { res, nextError } = await invoke({ headers: { [ADMIN_USER_AUDIT_TOKEN_HEADER]: REAL_TOKEN }, rows: [] });
  assert.equal(nextError, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totalStaffUsers, 0);
  assert.equal(res.body.adminCount, 0);
  assert.equal(res.body.activeAdminCount, 0);
  assert.deepEqual(res.body.users, []);
});

test("a database error is replaced by a generic error: no host, no driver message, short code only", async () => {
  const driverError = new Error("Can't reach database server at `db.internal.example:5432` with password `hunter2`");
  driverError.name = "PrismaClientInitializationError";
  driverError.code = "P1001";
  const { res, nextError } = await invoke({ headers: { [ADMIN_USER_AUDIT_TOKEN_HEADER]: REAL_TOKEN }, failWith: driverError });
  assert.equal(res.body, undefined);
  assert.ok(nextError instanceof Error);
  assert.equal(nextError.statusCode, 500);
  assert.equal(nextError.code, "P1001");
  assert.equal(nextError.message, "Admin user audit failed (PrismaClientInitializationError).");
  assert.ok(!nextError.message.includes("db.internal.example"));
  assert.ok(!nextError.message.includes("hunter2"));
});
