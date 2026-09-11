/**
 * TEMPORARY Preview-only bootstrap of ONE fixed ADMIN user — route tests.
 *
 * Proves: (1) 404 outside Preview, (2) missing/wrong bootstrap token rejected,
 * (3) an existing user causes zero writes, (4) a new user creates exactly one
 * ADMIN, (5) the password is hashed with the production auth hashing logic,
 * (6) plaintext password / hash never appear in responses, errors or logs,
 * (7) no unrelated database mutation method can be reached — plus fail-closed
 * 403 without the token env, body validation, lazy loading (loader-hook proof)
 * and the router mount.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ADMIN_BOOTSTRAP_TOKEN_ENV,
  ADMIN_BOOTSTRAP_TOKEN_HEADER,
  BOOTSTRAP_EMAIL,
  BOOTSTRAP_ROLE,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PREVIEW_ADMIN_BOOTSTRAP_ROUTE,
  SAFE_USER_FIELDS,
  SAFE_USER_SELECT,
  assertSafeOutput,
  bootstrapUserAccess,
  createAdminBootstrapPreviewHandler,
  evaluateGates,
  normalizeEmail,
  readPassword,
  tokenMatches,
} from "../src/routes/internal/adminBootstrapPreview.js";
import { hashPassword as authHashPassword, verifyPassword as authVerifyPassword } from "../src/modules/auth/auth.service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_PATH = path.join(here, "..", "src", "routes", "internal", "adminBootstrapPreview.js");
const ROUTER_PATH = path.join(here, "..", "src", "routes", "index.js");
const REQUEST_LOGGER_PATH = path.join(here, "..", "src", "platform", "logging", "requestLogger.js");
const AUTH_SERVICE_PATH = path.join(here, "..", "src", "modules", "auth", "auth.service.js");

const REAL_TOKEN = "temporary-admin-bootstrap-token-value";
const previewEnv = { VERCEL_ENV: "preview", [ADMIN_BOOTSTRAP_TOKEN_ENV]: REAL_TOKEN };
const PASSWORD = "Sentinel-Plaintext-Passw0rd!";
const OTHER_HASH = "$2b$12$OTHERUSERHASHSENTINEL000000000000000000000000000000000";

function mockRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

/**
 * Fake Prisma: `user` is a Proxy that throws on ANY member other than
 * findUnique / create. Rows live in `store`; create appends. `failCreateWith`
 * makes create throw (e.g. a P2002 race). `hashPassword` is injectable.
 */
function fakePrisma(store, { failCreateWith = null } = {}) {
  const calls = [];
  const model = {
    async findUnique(args) {
      calls.push({ method: "findUnique", args });
      const row = store.find((r) => r.email === args?.where?.email) ?? null;
      if (!row) return null;
      if (!args?.select) return { ...row };
      return Object.fromEntries(Object.keys(args.select).filter((k) => args.select[k]).map((k) => [k, row[k]]));
    },
    async create(args) {
      calls.push({ method: "create", args });
      if (failCreateWith) throw failCreateWith;
      const row = { id: `u-${store.length + 1}`, createdAt: new Date(), updatedAt: new Date(), clientId: null, inviteTokenHash: null, ...args.data };
      store.push(row);
      if (!args?.select) return { ...row };
      return Object.fromEntries(Object.keys(args.select).filter((k) => args.select[k]).map((k) => [k, row[k]]));
    },
  };
  const trap = new Proxy(model, {
    get(target, prop) {
      if (prop === "findUnique" || prop === "create") return target[prop];
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

async function invoke({ env = previewEnv, headers = { [ADMIN_BOOTSTRAP_TOKEN_HEADER]: REAL_TOKEN }, body = { password: PASSWORD }, store = [], failCreateWith = null, hashPassword = authHashPassword } = {}) {
  const loads = { count: 0 };
  const hashes = [];
  const fake = fakePrisma(store, { failCreateWith });
  const handler = createAdminBootstrapPreviewHandler({
    env,
    loadDependencies: async () => {
      loads.count += 1;
      return { prisma: fake.prisma, hashPassword: async (p) => { const h = await hashPassword(p); hashes.push(h); return h; } };
    },
  });
  const res = mockRes();
  let nextError = null;
  await handler({ headers, body, query: { password: "ignored-query" } }, res, (err) => { nextError = err; });
  return { res, nextError, loads, calls: fake.calls, store, hashes };
}

function serialize(value) { return JSON.stringify(value ?? null); }

// ---------------------------------------------------------------------------

test("1. non-preview runtime (production / development / unset): 404 like an unknown route, nothing loaded, nothing written", async () => {
  for (const env of [{}, { VERCEL_ENV: "production", [ADMIN_BOOTSTRAP_TOKEN_ENV]: REAL_TOKEN }, { VERCEL_ENV: "development", [ADMIN_BOOTSTRAP_TOKEN_ENV]: REAL_TOKEN }]) {
    const { res, loads, store, hashes } = await invoke({ env });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { ok: false, message: "Not found." });
    assert.equal(loads.count, 0);
    assert.equal(store.length, 0);
    assert.equal(hashes.length, 0);
  }
});

test("2a. fail closed: token env unset or blank in Preview → 403, nothing loaded, nothing written", async () => {
  for (const env of [{ VERCEL_ENV: "preview" }, { VERCEL_ENV: "preview", [ADMIN_BOOTSTRAP_TOKEN_ENV]: "" }, { VERCEL_ENV: "preview", [ADMIN_BOOTSTRAP_TOKEN_ENV]: "  " }]) {
    const { res, loads, store } = await invoke({ env });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.ok, false);
    assert.equal(loads.count, 0);
    assert.equal(store.length, 0);
  }
});

test("2b. missing bootstrap token → 401; wrong token → 403; nothing loaded, nothing written, no token echoed", async () => {
  for (const headers of [{}, { [ADMIN_BOOTSTRAP_TOKEN_HEADER]: "" }, { "x-audit-token": REAL_TOKEN }]) {
    const { res, loads, store } = await invoke({ headers });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { ok: false, message: "Bootstrap token required." });
    assert.equal(loads.count, 0);
    assert.equal(store.length, 0);
  }
  for (const wrong of ["wrong", REAL_TOKEN.slice(0, -1), `${REAL_TOKEN} `, REAL_TOKEN.toUpperCase()]) {
    const { res, loads, store } = await invoke({ headers: { [ADMIN_BOOTSTRAP_TOKEN_HEADER]: wrong } });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { ok: false, message: "Invalid bootstrap token." });
    assert.equal(loads.count, 0);
    assert.equal(store.length, 0);
    assert.ok(!serialize(res.body).includes(REAL_TOKEN));
    assert.ok(!serialize(res.body).includes(wrong));
  }
  assert.ok(!serialize(evaluateGates(previewEnv, { [ADMIN_BOOTSTRAP_TOKEN_HEADER]: "nope" })).includes(REAL_TOKEN));
  assert.equal(tokenMatches(REAL_TOKEN, REAL_TOKEN), true);
  assert.equal(tokenMatches("", REAL_TOKEN), false);
  assert.equal(tokenMatches(REAL_TOKEN, ""), false);
  const source = fs.readFileSync(ROUTE_PATH, "utf8");
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /timingSafeEqual/);
});

test("password comes only from the JSON body and is validated before anything is loaded", async () => {
  const cases = [
    { body: null }, { body: {} }, { body: { password: 12345678 } }, { body: [PASSWORD] },
    { body: { password: "short" } }, { body: { password: "x".repeat(PASSWORD_MAX_BYTES + 1) } }, { body: { password: "€".repeat(30) } },
  ];
  for (const { body } of cases) {
    const { res, loads, store } = await invoke({ body });
    assert.equal(res.statusCode, 400, `expected 400 for ${serialize(body).slice(0, 40)}`);
    assert.equal(res.body.ok, false);
    assert.equal(loads.count, 0);
    assert.equal(store.length, 0);
    assert.ok(!serialize(res.body).includes("short"), "validation error never echoes the input");
  }
  assert.deepEqual(readPassword({ password: PASSWORD }), { password: PASSWORD });
  assert.ok(readPassword(undefined).error, "no body → error");
  assert.ok(readPassword("string-body").error, "non-object body → error");
  assert.equal(PASSWORD_MIN_LENGTH, 8);
  // A query-string password is never used (the fixture always sends one and gets 400 without a body password).
  const { res } = await invoke({ body: {} });
  assert.equal(res.statusCode, 400);
});

test("3. existing user: zero writes, hashing never runs, only email/role/isActive returned", async () => {
  const store = [{ id: "u-existing", email: BOOTSTRAP_EMAIL, name: "Existing", role: "OPERATIONS", isActive: false, passwordHash: OTHER_HASH, inviteTokenHash: "inv-SENTINEL", clientId: null }];
  const before = JSON.stringify(store);
  const { res, nextError, loads, calls, hashes } = await invoke({ store });
  assert.equal(nextError, null);
  assert.equal(res.statusCode, 200);
  assert.equal(loads.count, 1);
  assert.deepEqual(calls.map((c) => c.method), ["findUnique"]);
  assert.deepEqual(calls[0].args, { where: { email: BOOTSTRAP_EMAIL }, select: { ...SAFE_USER_SELECT } });
  assert.equal(hashes.length, 0, "password is never hashed when the user exists");
  assert.equal(JSON.stringify(store), before, "no row changed");
  assert.deepEqual(res.body, { ok: true, created: false, message: "User already exists. Nothing was changed.", user: { email: BOOTSTRAP_EMAIL, role: "OPERATIONS", isActive: false } });
  assert.deepEqual(Object.keys(res.body.user).sort(), [...SAFE_USER_FIELDS].sort());
  assert.ok(!serialize(res.body).includes(OTHER_HASH));
  assert.ok(!serialize(res.body).includes("inv-SENTINEL"));
  assert.ok(!serialize(res.body).includes("Existing"), "name is not part of the safe metadata");
});

test("4. new user: exactly one ADMIN row is created with the fixed identity; a second call creates nothing", async () => {
  const store = [{ id: "u-other", email: "someone-else@example.com", role: "SUPPORT", isActive: true, passwordHash: OTHER_HASH }];
  const first = await invoke({ store, body: { password: PASSWORD, email: "attacker@example.com", role: "CLIENT", isActive: false } });
  assert.equal(first.nextError, null);
  assert.equal(first.res.statusCode, 201);
  assert.deepEqual(first.calls.map((c) => c.method), ["findUnique", "create"]);
  const create = first.calls[1].args;
  assert.deepEqual(Object.keys(create.data).sort(), ["email", "isActive", "name", "passwordHash", "role"]);
  assert.equal(create.data.email, BOOTSTRAP_EMAIL, "body email is ignored; identity is fixed");
  assert.equal(create.data.role, BOOTSTRAP_ROLE);
  assert.equal(create.data.isActive, true);
  assert.equal(create.data.name, null);
  assert.deepEqual(create.select, { ...SAFE_USER_SELECT });
  assert.equal(store.length, 2);
  const created = store.find((r) => r.email === BOOTSTRAP_EMAIL);
  assert.equal(created.role, "ADMIN");
  assert.equal(created.isActive, true);
  assert.equal(store[0].passwordHash, OTHER_HASH, "the other user is untouched");
  assert.deepEqual(first.res.body, { ok: true, created: true, message: "Bootstrap admin created.", user: { email: BOOTSTRAP_EMAIL, role: "ADMIN", isActive: true } });

  const second = await invoke({ store });
  assert.equal(second.res.statusCode, 200);
  assert.equal(second.res.body.created, false);
  assert.deepEqual(second.calls.map((c) => c.method), ["findUnique"]);
  assert.equal(store.length, 2, "still exactly one bootstrap admin");
  assert.equal(normalizeEmail("  MBO@MarketingBlueOcean.com "), BOOTSTRAP_EMAIL);
  assert.equal(BOOTSTRAP_EMAIL, "mbo@marketingblueocean.com");
});

test("4b. a unique-violation race on create is treated as 'already exists' and never overwrites", async () => {
  const store = [];
  const raceError = new Error("Unique constraint failed on the fields: (`email`)");
  raceError.code = "P2002";
  const fake = fakePrisma(store, { failCreateWith: raceError });
  let phase = 0;
  const handler = createAdminBootstrapPreviewHandler({
    env: previewEnv,
    loadDependencies: async () => ({
      prisma: { user: {
        findUnique: async (args) => { phase += 1; return phase === 1 ? null : { email: BOOTSTRAP_EMAIL, role: "ADMIN", isActive: true }; },
        create: fake.prisma.user.create,
      } },
      hashPassword: authHashPassword,
    }),
  });
  const res = mockRes(); let nextError = null;
  await handler({ headers: { [ADMIN_BOOTSTRAP_TOKEN_HEADER]: REAL_TOKEN }, body: { password: PASSWORD } }, res, (e) => { nextError = e; });
  assert.equal(nextError, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.created, false);
  assert.equal(store.length, 0);
});

test("5. the stored hash is produced by the auth service's hashPassword (bcrypt, same cost) and verifies with verifyPassword", async () => {
  const store = [];
  const { store: rows, hashes } = await invoke({ store });
  const created = rows.find((r) => r.email === BOOTSTRAP_EMAIL);
  assert.equal(hashes.length, 1);
  assert.equal(created.passwordHash, hashes[0]);
  assert.equal(await authVerifyPassword(PASSWORD, created.passwordHash), true);
  assert.equal(await authVerifyPassword(`${PASSWORD}x`, created.passwordHash), false);
  const cost = (hash) => hash.match(/^\$2[aby]\$(\d{2})\$/)[1];
  const authCost = cost(await authHashPassword("reference-password"));
  assert.equal(cost(created.passwordHash), authCost, "same bcrypt cost as the auth service");
  const authSource = fs.readFileSync(AUTH_SERVICE_PATH, "utf8");
  assert.match(authSource, new RegExp(`const SALT_ROUNDS = ${Number(authCost)};`));
  // The module has no hashing implementation of its own: it imports hashPassword from the auth service.
  const source = fs.readFileSync(ROUTE_PATH, "utf8");
  assert.ok(!/bcrypt|scrypt|pbkdf2|argon/i.test(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/BCRYPT_HASH_PATTERN|bcrypt hash/g, "")), "no local hashing implementation");
  assert.match(source, /import\("\.\.\/\.\.\/modules\/auth\/auth\.service\.js"\)/);
  assert.match(source, /const \[\{ prisma \}, \{ hashPassword \}\]/);
});

test("6. plaintext password and hash never appear in the response, in errors, or in logs", async () => {
  for (const store of [[], [{ id: "u", email: BOOTSTRAP_EMAIL, role: "ADMIN", isActive: true, passwordHash: OTHER_HASH }]]) {
    const { res, nextError } = await invoke({ store: [...store] });
    const out = serialize(res.body) + serialize(nextError?.message);
    assert.ok(!out.includes(PASSWORD), "no plaintext password");
    assert.ok(!/\$2[aby]\$\d{2}\$/.test(out), "no bcrypt hash");
    assert.ok(![...out.matchAll(/"([^"]+)":/g)].some((m) => /password|token|secret|hash/i.test(m[1])), "no credential-shaped key");
  }
  // Error path: a driver error mentioning the password/hash is replaced by a generic message.
  const driverError = new Error(`Can't reach database server at \`db.internal.example:5432\` (${PASSWORD}) ${OTHER_HASH}`);
  driverError.name = "PrismaClientInitializationError"; driverError.code = "P1001";
  const failing = createAdminBootstrapPreviewHandler({ env: previewEnv, loadDependencies: async () => { throw driverError; } });
  const res = mockRes(); let nextError = null;
  await failing({ headers: { [ADMIN_BOOTSTRAP_TOKEN_HEADER]: REAL_TOKEN }, body: { password: PASSWORD } }, res, (e) => { nextError = e; });
  assert.equal(res.body, undefined);
  assert.equal(nextError.statusCode, 500);
  assert.equal(nextError.code, "P1001");
  assert.equal(nextError.message, "Admin bootstrap failed (PrismaClientInitializationError).");
  assert.ok(!nextError.message.includes(PASSWORD) && !nextError.message.includes("db.internal.example"));
  // The output guard itself refuses plaintext, hashes and credential keys.
  assert.throws(() => assertSafeOutput({ ok: true, user: { email: "a", role: "ADMIN", isActive: true }, note: PASSWORD }, PASSWORD), /plaintext password/);
  assert.throws(() => assertSafeOutput({ ok: true, user: { email: "a", role: "ADMIN", isActive: true }, note: OTHER_HASH }, PASSWORD), /password hash/);
  assert.throws(() => assertSafeOutput({ ok: true, user: { email: "a", role: "ADMIN", isActive: true }, resetToken: "x" }, PASSWORD), /Forbidden key "resetToken"/);
  assert.throws(() => assertSafeOutput({ ok: true, user: { email: "a", role: "ADMIN", isActive: true, id: "u" } }, PASSWORD), /outside the allowlist/);
  // Logs: the module never logs, and the request logger never records request bodies.
  const codeOnly = fs.readFileSync(ROUTE_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/logger|console\./.test(codeOnly), "module never logs");
  const requestLogger = fs.readFileSync(REQUEST_LOGGER_PATH, "utf8");
  assert.ok(!/req\.body|request\.body/.test(requestLogger), "request logger never records bodies");
});

test("7. no unrelated database mutation is reachable: only findUnique/create exist, create refuses any other shape, source has no other write/raw/job call", async () => {
  const codeOnly = fs.readFileSync(ROUTE_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\.(update|updateMany|delete|deleteMany|upsert|createMany)\s*\(/.test(codeOnly.replace(/createHash\("sha256"\)\.update\(/g, "")), "no update/delete/upsert/bulk write");
  assert.ok(!/\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe|transaction|connect|disconnect)\b/.test(codeOnly), "no raw SQL or transaction");
  assert.ok(!/jobRunner|runTrackedJob|enqueue|scheduler|aggregation|sync\.job|migrate/i.test(codeOnly), "no job, scheduler, aggregation or migration path");
  // Exactly two create call sites: the raw model call inside the constrained wrapper, and the handler calling that wrapper.
  const createReceivers = [...codeOnly.matchAll(/(\w+)\.create\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(createReceivers, ["access", "model"]);
  const topLevelImports = [...fs.readFileSync(ROUTE_PATH, "utf8").matchAll(/^import .*?from "([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(topLevelImports, ["node:crypto"]);

  const rawModel = { findUnique: async () => null, create: async (args) => args.data, update: async () => "x", delete: async () => "x", deleteMany: async () => "x", upsert: async () => "x" };
  const access = bootstrapUserAccess({ user: rawModel });
  assert.deepEqual(Object.keys(access).sort(), ["create", "findUnique"]);
  assert.equal(access.update, undefined); assert.equal(access.delete, undefined); assert.equal(access.upsert, undefined);
  assert.ok(Object.isFrozen(access));
  const good = { email: BOOTSTRAP_EMAIL, name: null, role: "ADMIN", isActive: true, passwordHash: OTHER_HASH };
  assert.deepEqual(await access.create({ data: good }), good);
  for (const bad of [
    { ...good, email: "other@example.com" }, { ...good, role: "OPERATIONS" }, { ...good, role: "CLIENT" }, { ...good, isActive: false },
    { ...good, name: "x" }, { ...good, passwordHash: PASSWORD }, { ...good, clientId: "c1" }, { email: BOOTSTRAP_EMAIL, role: "ADMIN" }, {},
  ]) {
    await assert.rejects(async () => access.create({ data: bad }), /Refusing to create anything other than the fixed bootstrap admin/);
  }
  assert.throws(() => bootstrapUserAccess({ user: { findUnique: async () => null } }), /access methods are unavailable/);
  // The trap-backed fake throws on any non-allowlisted member; both successful paths therefore prove only findUnique/create were touched.
  const created = await invoke({ store: [] });
  assert.equal(created.res.statusCode, 201);
  assert.deepEqual([...new Set(created.calls.map((c) => c.method))].sort(), ["create", "findUnique"]);
});

test("at runtime: importing the route module loads neither Prisma, bcrypt nor the auth service (loader-hook proof in a child process)", () => {
  const hook = `
export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (/@prisma\\/client|\\/database\\/prisma\\.js|\\/\\.prisma\\/|\\/bcrypt\\/|\\/auth\\.service\\.js/.test(result.url)) {
    throw new Error("FORBIDDEN_LOAD:" + result.url);
  }
  return result;
}`;
  const script = `
import { register } from "node:module";
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});
const mod = await import(${JSON.stringify(pathToFileURL(ROUTE_PATH).href)});
if (typeof mod.adminBootstrapPreviewHandler !== "function") throw new Error("handler missing");
console.log("ROUTE_IMPORTED_WITHOUT_DB_OR_AUTH");
`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.join(here, ".."), env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(output, /ROUTE_IMPORTED_WITHOUT_DB_OR_AUTH/);
});

test("router mounts the temporary route exactly once, as POST, via the handler (token gate, not the JWT middleware)", () => {
  const router = fs.readFileSync(ROUTER_PATH, "utf8");
  assert.equal((router.match(/adminBootstrapPreviewHandler/g) ?? []).length, 2, "imported once, mounted once");
  assert.match(router, /router\.post\(PREVIEW_ADMIN_BOOTSTRAP_ROUTE, adminBootstrapPreviewHandler\);/);
  assert.equal(PREVIEW_ADMIN_BOOTSTRAP_ROUTE, "/internal/bootstrap/admin-user");
  assert.equal(ADMIN_BOOTSTRAP_TOKEN_ENV, "ADMIN_BOOTSTRAP_TOKEN");
});
