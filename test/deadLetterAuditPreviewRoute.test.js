/**
 * TEMPORARY preview-only, READ-ONLY dead-letter queue audit route.
 *
 * These prove the GATE, the read-only access pattern, the allowlist output, the
 * lastError sanitizer, and the attempt / maxAttempts arithmetic that is the
 * evidence for the suspected JobRunner retry-accounting defect. No job is
 * executed, nothing is enqueued, nothing is written.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DLQ_AUDIT_TOKEN_ENV,
  DLQ_AUDIT_TOKEN_HEADER,
  ERROR_SCAN_LIMIT,
  FORBIDDEN_OUTPUT_KEYS,
  JOB_STATUSES,
  MAX_EXAMPLE_LENGTH,
  PREVIEW_DLQ_AUDIT_ROUTE,
  SAMPLE_LIMIT,
  SAMPLE_OUTPUT_FIELDS,
  SAMPLE_SELECT,
  ageIndication,
  assertNoForbiddenKeys,
  buildAttemptAnalysis,
  buildStatusCounts,
  classifyError,
  createDeadLetterAuditPreviewHandler,
  isPreviewRuntime,
  normalizeErrorSignature,
  readOnlyJobRunReader,
  sanitizeErrorText,
  supplierDominance,
  tokenMatches,
} from "../src/routes/internal/deadLetterAuditPreview.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_PATH = path.join(here, "..", "src", "routes", "internal", "deadLetterAuditPreview.js");
const ROUTER_PATH = path.join(here, "..", "src", "routes", "index.js");
const PRISMA_MODULE_PATH = path.join(here, "..", "src", "database", "prisma.js");

const REAL_TOKEN = "temporary-dlq-audit-token-value";
const previewEnv = { VERCEL_ENV: "preview", [DLQ_AUDIT_TOKEN_ENV]: REAL_TOKEN };
const NOT_FOUND = { ok: false, message: "Not found." };
const NOW = new Date("2026-09-10T12:00:00.000Z");

// Sentinels that must never appear in any response.
const LEAKED_PAYLOAD = "PAYLOAD-SENTINEL-apikey-LIVE";
const LEAKED_RESULT = "RESULT-SENTINEL-value";
const LEAKED_CORRELATION = "corr-SENTINEL-0001";
const LEAKED_BEARER = "Bearer SUPERSECRETTOKENVALUE1234567890";
const LEAKED_EMAIL = "ops-person@example.com";
const LEAKED_CONNECTION = "postgresql://dbuser:dbpass@db.internal.example:5432/prod?sslmode=require";
const LEAKED_QUERY = "agencyId=118&contactId=9001&apikey=QUERYKEY";

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

function hoursAgo(h) {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000);
}

function daysAgo(d) {
  return hoursAgo(d * 24);
}

/**
 * Six DEAD_LETTER rows shaped to exercise every branch of the attempt analysis,
 * plus rows in every other status. Every row carries forbidden fields and a
 * secret-bearing lastError so leaks are detectable.
 */
function fixtureRows() {
  const dl = (id, jobName, attempt, maxAttempts, completedAt, lastError, createdAt = daysAgo(10)) => ({
    id,
    jobName,
    status: "DEAD_LETTER",
    priority: 100,
    attempt,
    maxAttempts,
    progress: 0,
    payload: { token: LEAKED_PAYLOAD },
    result: { value: LEAKED_RESULT },
    lastError,
    correlationId: LEAKED_CORRELATION,
    startedAt: completedAt ? new Date(completedAt.getTime() - 5000) : null,
    completedAt,
    createdAt,
    updatedAt: completedAt ?? createdAt,
  });
  return [
    // signature rows: attempt = maxAttempts - 1
    dl("dl-1", "promotion", 2, 3, hoursAgo(0.5), `Request failed with status code 401 ${LEAKED_BEARER} for ${LEAKED_EMAIL}`),
    dl("dl-2", "promotion", 2, 3, hoursAgo(5), `Request failed with status code 401 ${LEAKED_BEARER} for ${LEAKED_EMAIL}`),
    dl("dl-3", "promotion", 2, 3, daysAgo(2), `connect ECONNREFUSED ${LEAKED_CONNECTION}`),
    dl("dl-4", "aggregation", 2, 3, daysAgo(5), `GET https://supplier.example/v1/x?${LEAKED_QUERY} -> status code 429`),
    dl("dl-5", "conversion-promotion", 1, 2, daysAgo(9), "Cannot read properties of undefined (reading 'campaignId')"),
    // non-signature: attempt = maxAttempts
    dl("dl-6", "merchant-matching", 3, 3, daysAgo(12), "Cannot read properties of undefined (reading 'campaignId')"),
    // other statuses
    { id: "p-1", jobName: "promotion", status: "PENDING", attempt: 0, maxAttempts: 3, progress: 0, payload: {}, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: hoursAgo(1), updatedAt: hoursAgo(1) },
    { id: "p-2", jobName: "aggregation", status: "PENDING", attempt: 0, maxAttempts: 3, progress: 0, payload: {}, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: hoursAgo(1), updatedAt: hoursAgo(1) },
    { id: "r-1", jobName: "promotion", status: "RUNNING", attempt: 1, maxAttempts: 3, progress: 40, payload: {}, result: null, lastError: null, correlationId: null, startedAt: hoursAgo(0.1), completedAt: null, createdAt: hoursAgo(0.2), updatedAt: hoursAgo(0.1) },
    { id: "c-1", jobName: "promotion", status: "COMPLETED", attempt: 1, maxAttempts: 3, progress: 100, payload: {}, result: { ok: true }, lastError: null, correlationId: null, startedAt: daysAgo(1), completedAt: daysAgo(1), createdAt: daysAgo(1), updatedAt: daysAgo(1) },
    { id: "c-2", jobName: "aggregation", status: "COMPLETED", attempt: 1, maxAttempts: 3, progress: 100, payload: {}, result: { ok: true }, lastError: null, correlationId: null, startedAt: daysAgo(1), completedAt: daysAgo(1), createdAt: daysAgo(1), updatedAt: daysAgo(1) },
    { id: "c-3", jobName: "merchant-matching", status: "COMPLETED", attempt: 1, maxAttempts: 3, progress: 100, payload: {}, result: { ok: true }, lastError: null, correlationId: null, startedAt: daysAgo(1), completedAt: daysAgo(1), createdAt: daysAgo(1), updatedAt: daysAgo(1) },
    { id: "x-1", jobName: "promotion", status: "CANCELLED", attempt: 0, maxAttempts: 3, progress: 0, payload: {}, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: daysAgo(4), createdAt: daysAgo(4), updatedAt: daysAgo(4) },
  ];
}

/**
 * In-memory Prisma-shaped jobRun model implementing exactly the read subset the
 * route may use. Every call is recorded. Any other method access throws, and
 * a "leaky" mode ignores `select` to prove the projection is what protects the
 * output, not the fake.
 */
function fakePrisma(rows, { leaky = false } = {}) {
  const calls = [];

  const matches = (row, where = {}) => {
    for (const [field, cond] of Object.entries(where)) {
      const value = row[field];
      if (cond === null) {
        if (value !== null && value !== undefined) return false;
      } else if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        if ("gte" in cond && !(value != null && value >= cond.gte)) return false;
        if ("lt" in cond && !(value != null && value < cond.lt)) return false;
      } else if (value !== cond) return false;
    }
    return true;
  };

  const sortRows = (list, orderBy) => {
    const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...list].sort((a, b) => {
      for (const clause of clauses) {
        const [field, dir] = Object.entries(clause)[0];
        const av = a[field] ?? null;
        const bv = b[field] ?? null;
        if (av === bv) continue;
        if (av === null) return 1;
        if (bv === null) return -1;
        const cmp = av < bv ? -1 : 1;
        return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  };

  const jobRun = {
    async count(args = {}) {
      calls.push({ method: "count", args });
      return rows.filter((row) => matches(row, args.where)).length;
    },
    async groupBy(args = {}) {
      calls.push({ method: "groupBy", args });
      const groups = new Map();
      for (const row of rows.filter((r) => matches(r, args.where))) {
        const key = args.by.map((field) => String(row[field])).join("|");
        const group = groups.get(key) ?? { ...Object.fromEntries(args.by.map((field) => [field, row[field]])), _count: { _all: 0 }, _min: {}, _max: {} };
        group._count._all += 1;
        for (const field of Object.keys(args._min ?? {})) {
          const v = row[field] ?? null;
          if (v !== null && (group._min[field] == null || v < group._min[field])) group._min[field] = v;
          if (group._min[field] === undefined) group._min[field] = null;
        }
        for (const field of Object.keys(args._max ?? {})) {
          const v = row[field] ?? null;
          if (v !== null && (group._max[field] == null || v > group._max[field])) group._max[field] = v;
          if (group._max[field] === undefined) group._max[field] = null;
        }
        groups.set(key, group);
      }
      return [...groups.values()];
    },
    async findMany(args = {}) {
      calls.push({ method: "findMany", args });
      let list = sortRows(rows.filter((row) => matches(row, args.where)), args.orderBy);
      if (typeof args.take === "number") list = list.slice(0, args.take);
      if (leaky || !args.select) return list.map((row) => ({ ...row }));
      return list.map((row) => Object.fromEntries(Object.keys(args.select).filter((k) => args.select[k]).map((k) => [k, row[k]])));
    },
  };

  // Any write method access is an immediate failure, not a silent no-op.
  const trap = new Proxy(jobRun, {
    get(target, prop) {
      if (prop in target || typeof prop === "symbol" || prop === "then") return target[prop];
      throw new Error(`fake jobRun: forbidden method accessed: ${String(prop)}`);
    },
  });

  return { prisma: { jobRun: trap }, calls };
}

async function invoke({ env = previewEnv, headers = {}, rows = fixtureRows(), leaky = false, loads = { count: 0 } } = {}) {
  const fake = fakePrisma(rows, { leaky });
  const handler = createDeadLetterAuditPreviewHandler({
    env,
    now: () => NOW,
    loadDependencies: async () => {
      loads.count += 1;
      return { prisma: fake.prisma };
    },
  });
  const res = mockRes();
  let nextError = null;
  await handler({ headers, body: { sql: "DELETE FROM job_runs", take: 10000 }, query: { jobName: "x" } }, res, (error) => {
    nextError = error;
  });
  return { res, nextError, calls: fake.calls, loads };
}

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Gate — Prisma is never loaded on a rejected request
// ---------------------------------------------------------------------------

test("production / non-preview runtime: 404 and the database layer is never loaded", async () => {
  for (const vercelEnv of ["production", "development", undefined, "", "Preview", "PREVIEW"]) {
    const { res, loads, calls } = await invoke({
      env: { VERCEL_ENV: vercelEnv, [DLQ_AUDIT_TOKEN_ENV]: REAL_TOKEN },
      headers: { [DLQ_AUDIT_TOKEN_HEADER]: REAL_TOKEN },
    });
    assert.equal(res.statusCode, 404, `VERCEL_ENV=${vercelEnv} must 404`);
    assert.deepEqual(res.body, NOT_FOUND);
    assert.equal(loads.count, 0, "Prisma not loaded");
    assert.equal(calls.length, 0, "no query executed");
  }
  assert.equal(isPreviewRuntime({ VERCEL_ENV: "preview" }), true);
  assert.equal(isPreviewRuntime({ VERCEL_ENV: "production" }), false);
  assert.equal(isPreviewRuntime({}), false);
});

test("missing token header: identical 404, database never loaded", async () => {
  const { res, loads, calls } = await invoke({ headers: {} });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, NOT_FOUND);
  assert.equal(loads.count, 0);
  assert.equal(calls.length, 0);
});

test("wrong token: identical 404, database never loaded", async () => {
  for (const wrong of ["nope", `${REAL_TOKEN}x`, REAL_TOKEN.slice(0, -1), REAL_TOKEN.toUpperCase(), "", " "]) {
    const { res, loads, calls } = await invoke({ headers: { [DLQ_AUDIT_TOKEN_HEADER]: wrong } });
    assert.equal(res.statusCode, 404, `token "${wrong.slice(0, 4)}…" must 404`);
    assert.deepEqual(res.body, NOT_FOUND, "byte-identical to the no-token body");
    assert.equal(loads.count, 0);
    assert.equal(calls.length, 0);
  }
});

test("token env missing or empty: identical 404, database never loaded", async () => {
  for (const env of [{ VERCEL_ENV: "preview" }, { VERCEL_ENV: "preview", [DLQ_AUDIT_TOKEN_ENV]: "" }]) {
    const { res, loads } = await invoke({ env, headers: { [DLQ_AUDIT_TOKEN_HEADER]: REAL_TOKEN } });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, NOT_FOUND);
    assert.equal(loads.count, 0);
  }
});

test("token comparison is constant-time-shaped and exact", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf8");
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /crypto\.timingSafeEqual\(providedDigest, expectedDigest\)/);
  assert.equal(tokenMatches(REAL_TOKEN, REAL_TOKEN), true);
  assert.equal(tokenMatches("other", REAL_TOKEN), false);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches(undefined, REAL_TOKEN), false);
  assert.equal(tokenMatches(REAL_TOKEN, undefined), false);
  assert.equal(tokenMatches(["array"], REAL_TOKEN), false);
  assert.equal(tokenMatches("a", REAL_TOKEN), false, "differing lengths must not throw");
  assert.equal(DLQ_AUDIT_TOKEN_HEADER, "x-audit-token");
  assert.equal(DLQ_AUDIT_TOKEN_ENV, "DLQ_AUDIT_TOKEN");
});

test("statically: the only top-level import is node:crypto; Prisma is reached only via a dynamic import after the gate", () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf8");
  const staticImports = [...source.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(staticImports, ["node:crypto"]);
  assert.equal((source.match(/database\/prisma\.js/g) ?? []).length, 1);
  assert.match(source, /await import\("\.\.\/\.\.\/database\/prisma\.js"\)/);
  const gateIndex = source.indexOf("if (!isPreviewRuntime(env)) return notFound(res);");
  const tokenIndex = source.indexOf("if (!tokenMatches(");
  const loadIndex = source.indexOf("await loadDependencies()");
  assert.ok(gateIndex > 0 && tokenIndex > gateIndex && loadIndex > tokenIndex, "runtime gate, then token gate, then dependency load");
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
    env: { ...process.env, AUDIT_ROUTE_URL: pathToFileURL(ROUTE_PATH).href, AUDIT_PRISMA_URL: pathToFileURL(PRISMA_MODULE_PATH).href },
  });
  assert.match(output, /ROUTE_IMPORTED_WITHOUT_PRISMA/);
  assert.match(output, /CONTROL_OK/, "the hook demonstrably intercepts a real Prisma import");
});

// ---------------------------------------------------------------------------
// Valid token — the audit runs, read-only, and returns only sanitized data
// ---------------------------------------------------------------------------

test("valid Preview token reaches the audit; only count / groupBy / findMany are used; nothing from the request reaches a query", async () => {
  const { res, nextError, calls, loads } = await invoke({ headers: { [DLQ_AUDIT_TOKEN_HEADER]: REAL_TOKEN } });
  assert.equal(nextError, null);
  assert.equal(res.statusCode, 200);
  assert.equal(loads.count, 1);
  assert.ok(calls.length > 0);
  assert.deepEqual(new Set(calls.map((c) => c.method)), new Set(["groupBy", "count", "findMany"]));
  assert.equal(res.body.meta.queriesExecuted, calls.length);
  const serializedArgs = JSON.stringify(calls.map((c) => c.args));
  assert.ok(!serializedArgs.includes("DELETE"), "request body never reaches a query");
  assert.ok(!serializedArgs.includes("10000"));
  assert.ok(!/"jobName":"x"/.test(serializedArgs), "request query never reaches a query");
  assert.deepEqual(res.body.meta, {
    readOnly: true,
    writesPerformed: 0,
    supplierApiCalls: 0,
    jobsExecuted: 0,
    generatedAt: NOW.toISOString(),
    queriesExecuted: calls.length,
    sampleLimit: SAMPLE_LIMIT,
    errorScanLimit: ERROR_SCAN_LIMIT,
    errorRowsScanned: 6,
    ageAnchor: "generatedAt",
  });
});

test("the route performs no writes: no write method in source, the read-only reader exposes none, and a write attempt would throw", async () => {
  const source = fs.readFileSync(ROUTE_PATH, "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, ""); // comments removed; regex literals kept
  // Receiver-aware: crypto.createHash(...).update(...) is the SHA-256 step, not a model write.
  assert.ok(!/\b(prisma|jobRun|model|reader|db|tx|client)\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/.test(source), "no Prisma write call");
  assert.ok(!/\.(createMany|updateMany|deleteMany|upsert)\s*\(/.test(source), "no bulk write of any kind");
  // Every .update( in the module is a SHA-256 digest update (one per side of the constant-time compare).
  const updateCalls = (source.match(/\.update\(/g) ?? []).length;
  const digestUpdates = (source.match(/createHash\("sha256"\)\.update\(/g) ?? []).length;
  assert.equal(updateCalls, 2);
  assert.equal(digestUpdates, updateCalls, "no .update( other than the hash digests");
  assert.ok(!/\$executeRaw|\$executeRawUnsafe|\$queryRaw|\$queryRawUnsafe|\$transaction/.test(source), "no raw SQL or transaction API");
  assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/.test(code), "no SQL keywords in code");
  assert.ok(!/jobRunner|\.execute\(|\.run\(|enqueue\(|optimise\.adapter|httpClient|axios|fetch\(/.test(code), "no job execution, enqueue or supplier client");
  assert.ok(!/req\.body|req\.query|req\.params/.test(source), "request input is never read");

  const reader = readOnlyJobRunReader({ jobRun: { count: async () => 0, groupBy: async () => [], findMany: async () => [], update: async () => "x", delete: async () => "x" } });
  assert.deepEqual(Object.keys(reader).sort(), ["count", "findMany", "groupBy"]);
  assert.equal(reader.update, undefined);
  assert.equal(reader.delete, undefined);
  assert.ok(Object.isFrozen(reader));
  assert.throws(() => readOnlyJobRunReader({}), /read methods are unavailable/);
});

test("payload, result, correlationId and raw lastError never appear in the output — even when the database layer leaks them", async () => {
  for (const leaky of [false, true]) {
    const { res, calls } = await invoke({ headers: { [DLQ_AUDIT_TOKEN_HEADER]: REAL_TOKEN }, leaky });
    assert.equal(res.statusCode, 200, `leaky=${leaky}`);
    const keys = collectKeys(res.body);
    for (const forbidden of FORBIDDEN_OUTPUT_KEYS) assert.ok(!keys.has(forbidden), `no "${forbidden}" key (leaky=${leaky})`);
    const serialized = JSON.stringify(res.body);
    for (const leaked of [LEAKED_PAYLOAD, LEAKED_RESULT, LEAKED_CORRELATION, "SUPERSECRETTOKENVALUE", LEAKED_EMAIL, "dbpass", "db.internal.example", "QUERYKEY", "agencyId=118", REAL_TOKEN]) {
      assert.ok(!serialized.includes(leaked), `must not contain ${leaked} (leaky=${leaky})`);
    }
    // The selects themselves never ask for the forbidden columns.
    for (const call of calls.filter((c) => c.method === "findMany")) {
      for (const forbidden of ["payload", "result", "correlationId"]) assert.equal(call.args.select[forbidden], undefined, `select never includes ${forbidden}`);
    }
    // Sample rows carry exactly the allowlist plus the derived category.
    for (const row of res.body.sample) {
      assert.deepEqual(Object.keys(row), [...SAMPLE_OUTPUT_FIELDS, "errorCategory"]);
    }
  }
  assert.deepEqual(Object.keys(SAMPLE_SELECT).filter((k) => !SAMPLE_OUTPUT_FIELDS.includes(k)), ["lastError"], "lastError is the only internal-only selected column");
  assert.throws(() => assertNoForbiddenKeys({ a: [{ payload: 1 }] }), /Forbidden key "payload"/);
  assert.throws(() => assertNoForbiddenKeys({ nested: { deeper: { lastError: "x" } } }), /Forbidden key "lastError"/);
});

test("sanitizer removes bearer tokens, authorization values, api keys, passwords, query strings, emails, connection strings and JWTs", () => {
  const input =
    `Authorization: Bearer abc.def.ghi-XYZ; ${LEAKED_BEARER}; apikey=LIVEKEY123456 api_key: "SECRET-VALUE" password=hunter2 ` +
    `token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ` +
    `${LEAKED_CONNECTION} https://supplier.example/v1/x?${LEAKED_QUERY} contact ${LEAKED_EMAIL} ` +
    `signature=ZmFrZS1zaWduYXR1cmUtdmFsdWUtdGhhdC1pcy1sb25n`;
  const out = sanitizeErrorText(input);
  for (const gone of ["abc.def.ghi", "SUPERSECRETTOKENVALUE", "LIVEKEY123456", "SECRET-VALUE", "hunter2", "eyJhbGciOiJIUzI1NiJ9", "dbuser", "dbpass", "sslmode=require", "QUERYKEY", "agencyId=118", LEAKED_EMAIL, "ZmFrZS1zaWduYXR1cmU"]) {
    assert.ok(!out.includes(gone), `sanitized text must not contain ${gone}`);
  }
  assert.match(out, /Bearer \[REDACTED\]/);
  assert.match(out, /\[REDACTED_EMAIL\]/);
  assert.match(out, /\[REDACTED_CONNECTION_STRING\]/);
  assert.match(out, /\?\[REDACTED_QUERY\]/);
  assert.ok(!out.includes("db.internal.example"), "database host removed with the connection string");
  assert.ok(out.includes("https://supplier.example/v1/x?[REDACTED_QUERY]"), "http URL keeps host and path, loses the query");
  // A URL with embedded credentials but a non-database scheme keeps the host, loses the credentials.
  assert.equal(sanitizeErrorText("GET https://user:pw@api.example/v1 failed"), "GET https://[REDACTED]@api.example/v1 failed");
  // UUIDs and long path segments survive the blob rule.
  assert.equal(sanitizeErrorText("job 3f3bc6b1-f861-4eb7-8a11-0e85d59be69a failed"), "job 3f3bc6b1-f861-4eb7-8a11-0e85d59be69a failed");
  assert.equal(sanitizeErrorText("GET https://h.example/v1/campaigns/7340528/commission-groups -> 403"), "GET https://h.example/v1/campaigns/7340528/commission-groups -> 403");
  assert.equal(sanitizeErrorText(null), "");
  assert.equal(sanitizeErrorText(undefined), "");
  // Ordinary error text survives so families remain meaningful.
  assert.equal(sanitizeErrorText("Request failed with status code 502"), "Request failed with status code 502");
});

test("BLOCKER regression: Authorization credentials are removed whole in header, query and JSON forms — quoted values with whitespace leave no tail", () => {
  const cases = [
    // [input, raw values that must be gone, fragments that must survive]
    ['{"authorization":"Basic dXNlcjpwYXNz"}', ["dXNlcjpwYXNz", "Basic dXNl"], ["authorization=[REDACTED]"]],
    ['{"Authorization":"Bearer abc.def"}', ["abc.def"], ["Authorization=[REDACTED]"]],
    ['authorization="ApiKey abc123"', ["abc123", "ApiKey abc"], ["authorization=[REDACTED]"]],
    ["authorization='Bearer x.y-z'", ["x.y-z"], ["authorization=[REDACTED]"]],
    ['{"Authorization": "Bearer abc def ghi"}', ["abc", "def", "ghi"], ["Authorization=[REDACTED]"]],
    ['{"headers":{"authorization":"Bearer t0k3n_value"}}', ["t0k3n_value"], ['{"headers":{"authorization=[REDACTED]}}']],
    ["Authorization: Basic dXNlcjpwYXNz", ["dXNlcjpwYXNz"], ["Authorization=[REDACTED]"]],
    ["Proxy-Authorization: Bearer proxy-secret-1", ["proxy-secret-1"], ["Proxy-Authorization=[REDACTED]"]],
    ["request to /x failed: 401 authorization=Token rawtokenvalue, retry later", ["rawtokenvalue"], ["401", "retry later"]],
    ['Request failed with status code 401 (config: {"headers":{"Authorization":"Bearer live.jwt.part"}})', ["live.jwt.part"], ["Request failed with status code 401"]],
    ['"token": "Bearer with spaces inside"', ["with spaces inside", "inside"], ['"token": [REDACTED]']],
    ["password='p a s s'; apikey=\"k e y\"", ["p a s s", "k e y"], ["password=[REDACTED]", "apikey=[REDACTED]"]],
  ];
  for (const [input, gone, kept] of cases) {
    const out = sanitizeErrorText(input);
    for (const raw of gone) assert.ok(!out.includes(raw), `${JSON.stringify(input)} → ${JSON.stringify(out)} must not contain ${JSON.stringify(raw)}`);
    for (const fragment of kept) assert.ok(out.includes(fragment), `${JSON.stringify(out)} must keep ${JSON.stringify(fragment)}`);
  }
  // Ordinary error text is untouched and still classifiable.
  assert.equal(sanitizeErrorText("Request failed with status code 401"), "Request failed with status code 401");
  assert.equal(classifyError(sanitizeErrorText('{"Authorization":"Bearer abc.def"} -> status code 401')), "UPSTREAM_AUTH_REJECTED");
});

test("classification and family signature", () => {
  assert.equal(classifyError("Request failed with status code 401"), "UPSTREAM_AUTH_REJECTED");
  assert.equal(classifyError("Request failed with status code 429"), "UPSTREAM_RATE_LIMITED");
  assert.equal(classifyError("Request failed with status code 503"), "UPSTREAM_5XX");
  assert.equal(classifyError("connect ECONNREFUSED 10.0.0.1:5432"), "NETWORK_CONNECTIVITY");
  assert.equal(classifyError("timeout of 30000ms exceeded"), "TIMEOUT");
  assert.equal(classifyError("Can't reach database server at `x`"), "DATABASE_CONNECTIVITY");
  assert.equal(classifyError("Invalid `prisma.jobRun.update()` invocation: Unique constraint failed"), "DATABASE_CONSTRAINT_OR_QUERY");
  assert.equal(classifyError("Cannot read properties of undefined (reading 'x')"), "CODE_DEFECT_TYPEERROR");
  assert.equal(classifyError("No handler registered for job foo"), "HANDLER_NOT_REGISTERED");
  assert.equal(classifyError("Job abc not found"), "JOB_ROW_MISSING");
  assert.equal(classifyError("Missing required environment variable: X"), "CONFIGURATION");
  assert.equal(classifyError(""), "NO_ERROR_MESSAGE");
  assert.equal(classifyError(null), "NO_ERROR_MESSAGE");
  assert.equal(classifyError("something novel happened"), "UNCLASSIFIED");
  assert.equal(normalizeErrorSignature("Job 3f3bc6b1-f861-7eb7-3a11-0e85d59be69a failed after 12 tries"), "job <uuid> failed after # tries");
  assert.ok(normalizeErrorSignature("x".repeat(500)).length <= 120);
});

test("sample is capped at 20 rows even when the database returns more, and the query asks for at most 20", async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    ...fixtureRows()[0],
    id: `bulk-${i}`,
    completedAt: hoursAgo(i + 1),
    createdAt: hoursAgo(i + 2),
  }));
  const { res, calls } = await invoke({ headers: { [DLQ_AUDIT_TOKEN_HEADER]: REAL_TOKEN }, rows });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sample.length, 20);
  assert.equal(SAMPLE_LIMIT, 20);
  const sampleCall = calls.find((c) => c.method === "findMany" && c.args.select?.id === true);
  assert.equal(sampleCall.args.take, 20);
  assert.equal(sampleCall.args.where.status, "DEAD_LETTER");
  // Ordered newest dead-letter first.
  assert.equal(res.body.sample[0].id, "bulk-0");
  assert.equal(res.body.statusCounts.DEAD_LETTER, 25);
});

test("attempt arithmetic: maxAttempts=3 + attempt=2 is a retry-accounting signature, attempt=3 is not; less/equal/greater buckets are exact", () => {
  const analysis = buildAttemptAnalysis([
    { jobName: "promotion", attempt: 2, maxAttempts: 3, _count: { _all: 4 } },
    { jobName: "aggregation", attempt: 3, maxAttempts: 3, _count: { _all: 2 } },
    { jobName: "aggregation", attempt: 1, maxAttempts: 2, _count: { _all: 1 } },
    { jobName: "merchant-matching", attempt: 0, maxAttempts: 1, _count: { _all: 1 } },
    { jobName: "merchant-matching", attempt: 5, maxAttempts: 3, _count: { _all: 1 } },
    { jobName: "conversion-promotion", attempt: 1, maxAttempts: 3, _count: { _all: 1 } },
  ]);
  assert.equal(analysis.total, 10);
  assert.equal(analysis.attemptLessThanMax, 7, "2/3 x4, 1/2, 0/1, 1/3");
  assert.equal(analysis.attemptEqualsMax, 2, "3/3 x2");
  assert.equal(analysis.attemptGreaterThanMax, 1, "5/3");
  assert.equal(analysis.attemptEqualsMaxMinusOne, 6, "2/3 x4, 1/2, 0/1 — NOT 1/3, NOT 3/3");
  assert.deepEqual(analysis.byCombination, { "2/3": 4, "3/3": 2, "1/2": 1, "0/1": 1, "5/3": 1, "1/3": 1 });
  assert.deepEqual(analysis.byAttempt, { 2: 4, 3: 2, 1: 2, 0: 1, 5: 1 });
  assert.deepEqual(analysis.byMaxAttempts, { 3: 8, 2: 1, 1: 1 });
  assert.deepEqual(analysis.byJobName.promotion, { total: 4, attemptLessThanMax: 4, attemptEqualsMax: 0, attemptGreaterThanMax: 0, attemptEqualsMaxMinusOne: 4 });
  assert.deepEqual(analysis.byJobName.aggregation, { total: 3, attemptLessThanMax: 1, attemptEqualsMax: 2, attemptGreaterThanMax: 0, attemptEqualsMaxMinusOne: 1 });
  assert.deepEqual(analysis.byJobName["conversion-promotion"], { total: 1, attemptLessThanMax: 1, attemptEqualsMax: 0, attemptGreaterThanMax: 0, attemptEqualsMaxMinusOne: 0 });
});

test("end-to-end aggregates over the fixture: status counts, DLQ by job, attempt evidence, age, families, derived analysis", async () => {
  const { res } = await invoke({ headers: { [DLQ_AUDIT_TOKEN_HEADER]: REAL_TOKEN } });
  assert.equal(res.statusCode, 200);
  const b = res.body;

  // A
  assert.deepEqual(b.statusCounts, { PENDING: 2, RUNNING: 1, COMPLETED: 3, FAILED: 0, CANCELLED: 1, DEAD_LETTER: 6, total: 13 });

  // B
  assert.deepEqual(b.dlqByJobName.map((e) => [e.jobName, e.count, e.percentageOfDlq]), [
    ["promotion", 3, 50],
    ["aggregation", 1, 16.67],
    ["conversion-promotion", 1, 16.67],
    ["merchant-matching", 1, 16.67],
  ]);
  const promo = b.dlqByJobName[0];
  assert.equal(promo.newestCompletedAt, hoursAgo(0.5).toISOString());
  assert.equal(promo.oldestCompletedAt, daysAgo(2).toISOString());
  assert.equal(promo.oldestCreatedAt, daysAgo(10).toISOString());

  // C
  assert.equal(b.attemptAnalysis.total, 6);
  assert.equal(b.attemptAnalysis.attemptLessThanMax, 5);
  assert.equal(b.attemptAnalysis.attemptEqualsMax, 1);
  assert.equal(b.attemptAnalysis.attemptGreaterThanMax, 0);
  assert.equal(b.attemptAnalysis.attemptEqualsMaxMinusOne, 5);
  assert.deepEqual(b.attemptAnalysis.byCombination, { "2/3": 4, "1/2": 1, "3/3": 1 });

  // D — anchored on NOW
  assert.deepEqual(b.ageDistribution.byCompletedAt, { lessThan1Hour: 1, oneTo24Hours: 1, oneTo3Days: 1, threeTo7Days: 1, olderThan7Days: 2, missing: 0 });
  assert.deepEqual(b.ageDistribution.byCreatedAt, { lessThan1Hour: 0, oneTo24Hours: 0, oneTo3Days: 0, threeTo7Days: 0, olderThan7Days: 6, missing: 0 });

  // E — one sanitized example per family, ≤ 200 chars, no raw secrets
  assert.ok(b.errorFamilies.length >= 3);
  for (const family of b.errorFamilies) {
    assert.deepEqual(Object.keys(family), ["category", "count", "affectedJobNames", "sanitizedExample"], "exact key allowlist — no signature");
    assert.ok(family.sanitizedExample.length <= MAX_EXAMPLE_LENGTH);
    assert.ok(typeof family.count === "number" && family.count > 0);
  }
  const auth = b.errorFamilies.find((f) => f.category === "UPSTREAM_AUTH_REJECTED");
  assert.equal(auth.count, 2);
  assert.deepEqual(auth.affectedJobNames, ["promotion"]);
  assert.match(auth.sanitizedExample, /Bearer \[REDACTED\]/);
  const typeError = b.errorFamilies.find((f) => f.category === "CODE_DEFECT_TYPEERROR");
  assert.equal(typeError.count, 2);
  assert.deepEqual(typeError.affectedJobNames, ["conversion-promotion", "merchant-matching"]);
  assert.equal(b.errorFamilies.reduce((n, f) => n + f.count, 0), 6);

  // F
  assert.equal(b.sample.length, 6);
  assert.equal(b.sample[0].id, "dl-1");
  assert.equal(b.sample[0].errorCategory, "UPSTREAM_AUTH_REJECTED");
  assert.equal(b.sample[0].attempt, 2);
  assert.equal(b.sample[0].maxAttempts, 3);

  // Derived
  assert.equal(b.retryAccountingEvidence.confirmedSignatureCount, 5);
  assert.equal(b.retryAccountingEvidence.percentageOfDlq, 83.33);
  assert.match(b.retryAccountingEvidence.signature, /RETRY_ACCOUNTING_SIGNATURE/);
  assert.deepEqual(b.retryAccountingEvidence.byJobName.promotion, { count: 3, jobDlqTotal: 3, percentageOfJobDlq: 100 });
  assert.deepEqual(b.retryAccountingEvidence.byJobName["merchant-matching"], { count: 0, jobDlqTotal: 1, percentageOfJobDlq: 0 });
  assert.equal(b.dominantJobName, "promotion");
  assert.equal(b.dominantJobPercentage, 50);
  assert.equal(b.ageIndication, "RECENT_ACTIVITY_PRESENT");
  assert.equal(b.newestDeadLetterAt, hoursAgo(0.5).toISOString());
  assert.equal(b.oldestDeadLetterAt, daysAgo(12).toISOString());
  assert.equal(b.supplierDominance, "NOT_DETERMINABLE_WITHOUT_SENSITIVE_PAYLOAD");
});

test("status counts zero-fill every status and tolerate unknown statuses", () => {
  assert.deepEqual(buildStatusCounts([]), { PENDING: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0, DEAD_LETTER: 0, total: 0 });
  assert.deepEqual(buildStatusCounts([{ status: "DEAD_LETTER", _count: { _all: 75 } }, { status: "PENDING", _count: { _all: 6 } }]), {
    PENDING: 6, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0, DEAD_LETTER: 75, total: 81,
  });
  assert.deepEqual(JOB_STATUSES, ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "DEAD_LETTER"]);
});

test("empty DLQ is handled safely: zeros, nulls, no division by zero, no families, no sample", async () => {
  const rows = fixtureRows().filter((r) => r.status !== "DEAD_LETTER");
  const { res, nextError } = await invoke({ headers: { [DLQ_AUDIT_TOKEN_HEADER]: REAL_TOKEN }, rows });
  assert.equal(nextError, null);
  assert.equal(res.statusCode, 200);
  const b = res.body;
  assert.equal(b.statusCounts.DEAD_LETTER, 0);
  assert.equal(b.statusCounts.total, 7);
  assert.deepEqual(b.dlqByJobName, []);
  assert.equal(b.attemptAnalysis.total, 0);
  assert.equal(b.attemptAnalysis.attemptEqualsMaxMinusOne, 0);
  assert.deepEqual(b.errorFamilies, []);
  assert.deepEqual(b.sample, []);
  assert.deepEqual(b.retryAccountingEvidence.byJobName, {});
  assert.equal(b.retryAccountingEvidence.confirmedSignatureCount, 0);
  assert.equal(b.retryAccountingEvidence.percentageOfDlq, 0);
  assert.equal(b.dominantJobName, null);
  assert.equal(b.dominantJobPercentage, 0);
  assert.equal(b.ageIndication, "EMPTY");
  assert.equal(b.newestDeadLetterAt, null);
  assert.equal(b.oldestDeadLetterAt, null);
  assert.equal(b.supplierDominance, "NOT_DETERMINABLE_WITHOUT_SENSITIVE_PAYLOAD");

  // Also when the database returns nothing at all.
  const { res: empty } = await invoke({ headers: { [DLQ_AUDIT_TOKEN_HEADER]: REAL_TOKEN }, rows: [] });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.body.statusCounts.total, 0);
});

test("age indication and supplier dominance helpers", () => {
  assert.equal(ageIndication({ lessThan1Hour: 0, oneTo24Hours: 0, oneTo3Days: 0, threeTo7Days: 0, olderThan7Days: 75 }), "HISTORICAL");
  assert.equal(ageIndication({ lessThan1Hour: 0, oneTo24Hours: 0, oneTo3Days: 2, threeTo7Days: 0, olderThan7Days: 73 }), "RECENT_NOT_LAST_24H");
  assert.equal(ageIndication({ lessThan1Hour: 0, oneTo24Hours: 1, oneTo3Days: 0, threeTo7Days: 0, olderThan7Days: 74 }), "RECENT_ACTIVITY_PRESENT");
  assert.equal(ageIndication({ lessThan1Hour: 3, oneTo24Hours: 0, oneTo3Days: 0, threeTo7Days: 0, olderThan7Days: 0 }), "RECENT_ACTIVITY_PRESENT");
  assert.equal(ageIndication({}), "EMPTY");
  assert.equal(supplierDominance([{ jobName: "promotion", count: 5 }]), "NOT_DETERMINABLE_WITHOUT_SENSITIVE_PAYLOAD");
  assert.deepEqual(supplierDominance([{ jobName: "optimise-conversion-sync", count: 5 }, { jobName: "boostiny-sync", count: 2 }, { jobName: "promotion", count: 1 }]), {
    determinedFrom: "jobName",
    bySupplier: { optimise: 5, boostiny: 2 },
  });
});

test("a database error is replaced by a generic error: no host, no message, code only", async () => {
  const handler = createDeadLetterAuditPreviewHandler({
    env: previewEnv,
    now: () => NOW,
    loadDependencies: async () => ({
      prisma: {
        jobRun: {
          count: async () => 0,
          findMany: async () => [],
          groupBy: async () => {
            throw Object.assign(new Error(`Can't reach database server at \`db.internal.example:5432\` (${LEAKED_CONNECTION})`), { code: "P1001", name: "PrismaClientInitializationError" });
          },
        },
      },
    }),
  });
  const res = mockRes();
  let nextError = null;
  await handler({ headers: { [DLQ_AUDIT_TOKEN_HEADER]: REAL_TOKEN }, body: {} }, res, (e) => {
    nextError = e;
  });
  assert.equal(res.body, null);
  assert.equal(nextError.statusCode, 500);
  assert.equal(nextError.code, "P1001");
  assert.equal(nextError.message, "Dead-letter audit failed (PrismaClientInitializationError).");
  assert.ok(!JSON.stringify({ ...nextError, message: nextError.message }).includes("db.internal.example"));
});

test("the route is registered exactly once, as a temporary POST endpoint, with its own gate", () => {
  const routerSource = fs.readFileSync(ROUTER_PATH, "utf8");
  assert.equal(PREVIEW_DLQ_AUDIT_ROUTE, "/internal/audit/dead-letter");
  assert.match(routerSource, /router\.post\(PREVIEW_DLQ_AUDIT_ROUTE, deadLetterAuditPreviewHandler\)/);
  assert.equal((routerSource.match(/PREVIEW_DLQ_AUDIT_ROUTE/g) ?? []).length, 2, "imported once, mounted once");
  assert.ok(!/router\.(get|put|patch|delete)\(PREVIEW_DLQ_AUDIT_ROUTE/.test(routerSource), "POST only");
  assert.ok(!/router\.post\(PREVIEW_DLQ_AUDIT_ROUTE,\s*authenticate/.test(routerSource), "the preview gate, not user auth, controls this route");
  const at = routerSource.indexOf("router.post(PREVIEW_DLQ_AUDIT_ROUTE");
  assert.match(routerSource.slice(Math.max(0, at - 800), at), /TEMPORARY/, "labelled temporary");
  // The production dead-letter endpoint is untouched.
  assert.match(routerSource, /"\/ops\/jobs\/dead-letter",\s*authenticate,\s*requirePermission\(PERMISSIONS\.OPS_READ\),\s*deadLetterHandler/);
});

// ---------------------------------------------------------------------------
// Real Prisma, rolled back: the groupBy / count / findMany shapes are valid
// ---------------------------------------------------------------------------

test("against Postgres in a rolled-back transaction: the Prisma query shapes are valid and the arithmetic holds on real rows", async () => {
  const { prisma } = await import("../src/database/prisma.js");
  const marker = `dlq-audit-test-${process.pid}-${Date.now()}`;
  const ROLLBACK = Symbol("rollback");
  const now = new Date();
  const ago = (ms) => new Date(now.getTime() - ms);

  const audit = async (tx) => {
    const handler = createDeadLetterAuditPreviewHandler({ env: previewEnv, now: () => now, loadDependencies: async () => ({ prisma: tx }) });
    const res = mockRes();
    let nextError = null;
    await handler({ headers: { [DLQ_AUDIT_TOKEN_HEADER]: REAL_TOKEN }, body: {} }, res, (e) => {
      nextError = e;
    });
    assert.equal(nextError, null, nextError ? `${nextError.message} (${nextError.code ?? "no code"})` : undefined);
    assert.equal(res.statusCode, 200);
    return res.body;
  };

  let asserted = false;
  try {
    await prisma.$transaction(
      async (tx) => {
        const before = await audit(tx);

        const row = (jobName, attempt, maxAttempts, completedAt, lastError) => ({
          jobName: `${marker}:${jobName}`,
          status: "DEAD_LETTER",
          attempt,
          maxAttempts,
          progress: 0,
          payload: { secret: LEAKED_PAYLOAD },
          result: { r: LEAKED_RESULT },
          lastError,
          correlationId: LEAKED_CORRELATION,
          startedAt: completedAt,
          completedAt,
        });
        await tx.jobRun.create({ data: row("promotion", 2, 3, ago(30 * 60 * 1000), `status code 401 ${LEAKED_BEARER}`) });
        await tx.jobRun.create({ data: row("promotion", 2, 3, ago(2 * 24 * 60 * 60 * 1000), `status code 401 ${LEAKED_BEARER}`) });
        await tx.jobRun.create({ data: row("aggregation", 3, 3, ago(9 * 24 * 60 * 60 * 1000), "Cannot read properties of undefined") });
        await tx.jobRun.create({ data: { jobName: `${marker}:promotion`, status: "PENDING", payload: {}, maxAttempts: 3 } });

        const after = await audit(tx);
        const delta = (pick) => pick(after) - pick(before);

        assert.equal(delta((b) => b.statusCounts.DEAD_LETTER), 3);
        assert.equal(delta((b) => b.statusCounts.PENDING), 1);
        assert.equal(delta((b) => b.statusCounts.total), 4);
        assert.equal(delta((b) => b.attemptAnalysis.attemptEqualsMaxMinusOne), 2);
        assert.equal(delta((b) => b.attemptAnalysis.attemptEqualsMax), 1);
        assert.equal(delta((b) => b.retryAccountingEvidence.confirmedSignatureCount), 2);
        assert.equal(delta((b) => b.ageDistribution.byCompletedAt.lessThan1Hour), 1);
        assert.equal(delta((b) => b.ageDistribution.byCompletedAt.oneTo3Days), 1);
        assert.equal(delta((b) => b.ageDistribution.byCompletedAt.olderThan7Days), 1);

        const ours = after.dlqByJobName.filter((e) => e.jobName.startsWith(marker));
        assert.deepEqual(ours.map((e) => [e.jobName.split(":")[1], e.count]), [["promotion", 2], ["aggregation", 1]]);
        assert.deepEqual(after.retryAccountingEvidence.byJobName[`${marker}:promotion`], { count: 2, jobDlqTotal: 2, percentageOfJobDlq: 100 });

        const serialized = JSON.stringify(after);
        for (const leaked of [LEAKED_PAYLOAD, LEAKED_RESULT, LEAKED_CORRELATION, "SUPERSECRETTOKENVALUE"]) assert.ok(!serialized.includes(leaked));
        for (const forbidden of FORBIDDEN_OUTPUT_KEYS) assert.ok(!collectKeys(after).has(forbidden));
        const family = after.errorFamilies.find((f) => f.affectedJobNames.includes(`${marker}:promotion`));
        assert.equal(family.category, "UPSTREAM_AUTH_REJECTED");
        assert.match(family.sanitizedExample, /Bearer \[REDACTED\]/);

        asserted = true;
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
  assert.equal(asserted, true);
  assert.equal(await prisma.jobRun.count({ where: { jobName: { startsWith: marker } } }), 0, "fixtures rolled back; nothing persisted");
  await prisma.$disconnect();
});
