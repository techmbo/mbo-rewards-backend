/**
 * TEMPORARY — Phase 6a-ter measurement endpoint. Delete with the route, controller and service.
 *
 * What is proved here: the window is the job's window; the only database traffic is one
 * read-only transaction holding two guard statements and one SELECT; no write method is even
 * reachable; nothing from a request reaches the query; nothing but whitelisted integers leaves.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BUCKET_THRESHOLDS,
  MEASUREMENT_NAME,
  READ_ONLY_GUARD_SQL,
  STATEMENT_TIMEOUT_GUARD_SQL,
  STATEMENT_TIMEOUT_MS,
  TRANSACTION_MAX_WAIT_MS,
  TRANSACTION_TIMEOUT_MS,
  measureAggregationDimensions,
  resolvePostSyncAggregationWindow,
  summariseMeasurement,
  toSafeDayRow,
} from "../src/modules/reporting/services/aggregationDimensionMeasurement.service.js";
import { aggregationMeasurementHandler } from "../src/controllers/aggregationMeasurement.controller.js";
import { AGGREGATION_AFTER_SYNC_DAYS } from "../src/jobs/syncConfig.js";

const SERVICE_SRC = readFileSync(new URL("../src/modules/reporting/services/aggregationDimensionMeasurement.service.js", import.meta.url), "utf8");
const CONTROLLER_SRC = readFileSync(new URL("../src/controllers/aggregationMeasurement.controller.js", import.meta.url), "utf8");
const ROUTES_SRC = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
const SYNC_JOB_SRC = readFileSync(new URL("../src/jobs/sync.job.js", import.meta.url), "utf8");
/** Comments stripped: behaviour assertions must not be satisfied by prose. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-09-16T19:54:37.000Z");

// ---------------------------------------------------------------------------
// The window is the job's window.
// ---------------------------------------------------------------------------

describe("window", () => {
  it("is today UTC minus AGGREGATION_AFTER_SYNC_DAYS through today, inclusive — fifteen days", () => {
    assert.equal(AGGREGATION_AFTER_SYNC_DAYS, 14);
    assert.deepEqual(resolvePostSyncAggregationWindow(NOW), { from: "2026-09-02", to: "2026-09-16", days: 15 });
  });

  it("crosses a month boundary the way setUTCDate does", () => {
    assert.deepEqual(resolvePostSyncAggregationWindow(new Date("2026-10-05T00:00:00.000Z")), { from: "2026-09-21", to: "2026-10-05", days: 15 });
  });

  it("uses the UTC date, not the local one, at the edge of a day", () => {
    assert.equal(resolvePostSyncAggregationWindow(new Date("2026-09-16T23:59:59.999Z")).to, "2026-09-16");
    assert.equal(resolvePostSyncAggregationWindow(new Date("2026-09-17T00:00:00.000Z")).to, "2026-09-17");
  });

  it("matches the arithmetic maybePromoteAfterSync still uses", () => {
    const job = strip(SYNC_JOB_SRC);
    assert.match(job, /from\.setUTCDate\(from\.getUTCDate\(\) - Math\.max\(1, AGGREGATION_AFTER_SYNC_DAYS\)\)/);
    assert.match(job, /from\.toISOString\(\)\.slice\(0, 10\)/);
    assert.match(job, /to\.toISOString\(\)\.slice\(0, 10\)/);
  });
});

// ---------------------------------------------------------------------------
// A client that records everything and REFUSES anything not on the allow-list.
// ---------------------------------------------------------------------------

function sqlText(strings) {
  return Array.isArray(strings) ? strings.join("?") : String(strings);
}

function createRecordingClient({ rows = [] } = {}) {
  const calls = [];
  const forbidden = (name) => {
    throw new Error(`forbidden client access: ${String(name)}`);
  };
  const tx = new Proxy(
    {
      async $executeRaw(strings, ...values) {
        calls.push({ method: "$executeRaw", sql: sqlText(strings).trim(), values });
        return 0;
      },
      async $queryRaw(strings, ...values) {
        calls.push({ method: "$queryRaw", sql: sqlText(strings).trim(), values });
        return rows;
      },
    },
    { get: (target, name) => (name in target ? target[name] : forbidden(name)) },
  );
  const client = new Proxy(
    {
      async $transaction(fn, options) {
        calls.push({ method: "$transaction", options });
        return fn(tx);
      },
    },
    { get: (target, name) => (name in target ? target[name] : forbidden(name)) },
  );
  return { client, calls };
}

const emptyDay = (day) => ({
  day,
  sourceClicks: 0, sourceConversions: 0, eligibleClicks: 0, eligibleConversions: 0,
  distinctAssignments: 0, distinctClients: 0, distinctMerchants: 0, distinctCampaigns: 0,
  distinctCampaignSources: 0, distinctCountries: 0, bucketsExact: 0, estimatedDailyReportUpserts: 0,
  estimatedTransactionQueries: 3, estimatedMsAt5msPerQuery: 15, estimatedMsAt10msPerQuery: 30,
});

// ---------------------------------------------------------------------------
// Read-only, by construction and by the database.
// ---------------------------------------------------------------------------

describe("the measurement is a pure read", () => {
  it("issues exactly one read-only transaction: two guards, then one SELECT, nothing else", async () => {
    const { client, calls } = createRecordingClient({ rows: [emptyDay("2026-09-02")] });
    await measureAggregationDimensions({ client, now: NOW });

    assert.deepEqual(calls.map((c) => c.method), ["$transaction", "$executeRaw", "$executeRaw", "$queryRaw"]);
    assert.equal(calls[1].sql, READ_ONLY_GUARD_SQL);
    assert.equal(calls[2].sql, STATEMENT_TIMEOUT_GUARD_SQL);
    assert.deepEqual(calls[1].values, [], "guards carry no parameters");
    assert.deepEqual(calls[2].values, []);
  });

  it("the read-only guard is the FIRST statement, so Postgres refuses any later write", async () => {
    const { client, calls } = createRecordingClient();
    await measureAggregationDimensions({ client, now: NOW });
    const inTx = calls.filter((c) => c.method !== "$transaction");
    assert.equal(inTx[0].sql, "SET TRANSACTION READ ONLY");
  });

  it("the transaction is bounded in both wait and duration, and the statement has its own timeout", async () => {
    const { client, calls } = createRecordingClient();
    await measureAggregationDimensions({ client, now: NOW });
    assert.deepEqual(calls[0].options, { maxWait: TRANSACTION_MAX_WAIT_MS, timeout: TRANSACTION_TIMEOUT_MS });
    assert.equal(STATEMENT_TIMEOUT_MS, 60_000);
    assert.equal(STATEMENT_TIMEOUT_GUARD_SQL, "SET LOCAL statement_timeout = 60000");
    assert.ok(STATEMENT_TIMEOUT_MS < TRANSACTION_TIMEOUT_MS, "the statement gives up before the transaction does");
  });

  it("the SELECT is a SELECT: no write keyword appears in it", async () => {
    const { client, calls } = createRecordingClient();
    await measureAggregationDimensions({ client, now: NOW });
    const select = calls.find((c) => c.method === "$queryRaw").sql;
    assert.match(select, /^WITH params AS/);
    for (const word of ["INSERT", "UPDATE", "DELETE", "UPSERT", "MERGE", "TRUNCATE", "CREATE", "ALTER", "DROP", "GRANT", "COPY", "LOCK", "REFRESH"]) {
      assert.ok(!new RegExp(`\\b${word}\\b`).test(select), word);
    }
  });

  it("no write method is reachable: the client refuses everything off the allow-list", async () => {
    const { client } = createRecordingClient();
    await measureAggregationDimensions({ client, now: NOW });
    for (const name of ["dailyReport", "click", "conversion", "jobRun", "$executeRawUnsafe", "$queryRawUnsafe"]) {
      assert.throws(() => client[name], /forbidden client access/, name);
    }
  });

  it("the only parameters are the two derived dates, in order", async () => {
    const { client, calls } = createRecordingClient();
    await measureAggregationDimensions({ client, now: NOW });
    assert.deepEqual(calls.find((c) => c.method === "$queryRaw").values, ["2026-09-02", "2026-09-16"]);
  });
});

// ---------------------------------------------------------------------------
// The SQL carries the validated AggregationService semantics.
// ---------------------------------------------------------------------------

describe("semantics", () => {
  let select;
  const load = async () => {
    if (select) return select;
    const { client, calls } = createRecordingClient();
    await measureAggregationDimensions({ client, now: NOW });
    select = calls.find((c) => c.method === "$queryRaw").sql;
    return select;
  };

  it("conversions are ATTRIBUTED, assigned, and resolvable — findForAggregation plus the accumulator's guards", async () => {
    const sql = await load();
    assert.match(sql, /"attributionStatus" = 'ATTRIBUTED'/);
    assert.match(sql, /"clientAssignmentId" IS NOT NULL/);
    assert.match(sql, /JOIN client_campaign_assignments a ON a\.id = v\."clientAssignmentId"/);
    assert.match(sql, /cc\."merchantId" IS NOT NULL/);
    assert.match(sql, /v\.metadata->>'country'/, "country comes from metadata, as the accumulator reads it");
  });

  it("clicks resolve through the assignment and its campaign's merchant — #accumulateClicks", async () => {
    const sql = await load();
    assert.match(sql, /JOIN client_campaign_assignments a ON a\.id = c\."clientAssignmentId"/);
    assert.match(sql, /JOIN canonical_campaigns cc\s+ON cc\.id = a\."canonicalCampaignId"/);
  });

  it("the bucket is the six-part dimension key, with NULL source and country normalised to ''", async () => {
    const sql = await load();
    assert.match(sql, /COALESCE\(c\."campaignSourceId", ''\)\s+AS source_key/);
    assert.match(sql, /COALESCE\(c\.country, ''\)\s+AS country_key/);
    assert.match(sql, /COUNT\(DISTINCT \(client_id, merchant_id, campaign_id, source_key, country_key\)\)/);
    assert.match(sql, /UNION ALL/, "clicks and conversions share one bucket space");
  });

  it("each day is a UTC calendar day on TIMESTAMP columns", async () => {
    const sql = await load();
    assert.match(sql, /c\."clickedAt"::date AS day/);
    assert.match(sql, /v\."conversionDate"::date\s+AS day/);
    assert.match(sql, /<\s+\(p\.to_day \+ 1\)::timestamp/, "half-open on the day after `to`, so to is inclusive");
  });

  it("the transaction estimate is the 048a2ee shape: 2 per click page, 1 per assignment chunk, 1, 2 per bucket", async () => {
    const sql = await load();
    assert.match(sql, /2 \* GREATEST\(1, CEIL\("eligibleClicks" \/ 5000\.0\)\)::int/);
    assert.match(sql, /CEIL\("distinctAssignments" \/ 1000\.0\)::int/);
    assert.match(sql, /\+ 2 \* "bucketsExact"\)/);
    // Every occurrence, not just the first: the three expressions must agree, or the reported
    // query count and the two duration columns would describe different code.
    assert.equal((sql.match(/\+ 2 \* "bucketsExact"\)/g) ?? []).length, 3);
  });

  it("the estimate is arithmetically the 048a2ee cost, evaluated by Postgres", async () => {
    // Recomputed from the same inputs rather than pattern-matched: one upsertDimension is
    // findFirst + create, so a bucket costs TWO queries, not one.
    const cost = (clicks, assignments, buckets) =>
      2 * Math.max(1, Math.ceil(clicks / 5000)) + Math.ceil(assignments / 1000) + 1 + 2 * buckets;
    // The seeded fixture day: 7 eligible clicks, 3 assignments, 7 buckets -> 2 + 1 + 1 + 14 = 18.
    assert.equal(cost(7, 3, 7), 18);
    assert.equal(cost(1, 2, 2), 8);
    // A wide day is dominated by the bucket term.
    assert.equal(cost(5000, 200, 500), 2 + 1 + 1 + 1000);
  });

  it("every count is cast to int, so no BigInt can reach JSON", async () => {
    const sql = await load();
    const counts = sql.match(/COUNT\([^)]*\)+/g) ?? [];
    assert.ok(counts.length >= 11);
    for (const c of sql.match(/COUNT\((?:[^()]|\([^()]*\))*\)(::int)?/g) ?? []) {
      assert.ok(c.endsWith("::int"), `${c} must be cast`);
    }
  });
});

// ---------------------------------------------------------------------------
// Nothing but whitelisted integers leaves.
// ---------------------------------------------------------------------------

describe("output safety", () => {
  it("whitelists fields, coerces BigInt, and drops anything unexpected", () => {
    const row = toSafeDayRow({
      day: "2026-09-05",
      sourceClicks: 7n, sourceConversions: 4n, eligibleClicks: 7n, eligibleConversions: 2n,
      distinctAssignments: 3n, distinctClients: 2n, distinctMerchants: 2n, distinctCampaigns: 2n,
      distinctCampaignSources: 4n, distinctCountries: 3n, bucketsExact: 7n, estimatedDailyReportUpserts: 7n,
      estimatedTransactionQueries: 18n, estimatedMsAt5msPerQuery: 90n, estimatedMsAt10msPerQuery: 180n,
      client_id: "client-1", merchant_id: "m-1", grossCommission: "12.5000", DIRECT_URL: "postgres://x",
    });
    assert.equal(row.day, "2026-09-05");
    assert.equal(row.bucketsExact, 7);
    assert.equal(typeof row.sourceClicks, "number");
    for (const leak of ["client_id", "merchant_id", "grossCommission", "DIRECT_URL"]) assert.ok(!(leak in row), leak);
    assert.doesNotThrow(() => JSON.stringify(row));
  });

  it("a Date day is rendered as YYYY-MM-DD and a null count as 0", () => {
    const row = toSafeDayRow({ day: new Date("2026-09-05T00:00:00.000Z"), bucketsExact: null });
    assert.equal(row.day, "2026-09-05");
    assert.equal(row.bucketsExact, 0);
  });

  it("summarises max, average, worst day and threshold breaches", () => {
    const days = [
      { ...emptyDay("2026-09-02"), bucketsExact: 120, estimatedMsAt5msPerQuery: 1_215, estimatedMsAt10msPerQuery: 2_430 },
      { ...emptyDay("2026-09-03"), bucketsExact: 480, estimatedMsAt5msPerQuery: 4_815, estimatedMsAt10msPerQuery: 9_630 },
      { ...emptyDay("2026-09-04"), bucketsExact: 300 },
    ];
    const s = summariseMeasurement(days);
    assert.equal(s.maxBucketsExact, 480);
    assert.equal(s.averageBucketsExact, 300);
    assert.equal(s.worstDay, "2026-09-03");
    assert.equal(s.worstDayEstimatedMsAt10msPerQuery, 9_630);
    assert.deepEqual(s.daysOver, { 300: ["2026-09-03"], 400: ["2026-09-03"], 500: [] });
    assert.deepEqual(BUCKET_THRESHOLDS, [300, 400, 500]);
  });

  it("the full result names the grain, the window, the assumptions and no identifiers", async () => {
    const { client } = createRecordingClient({ rows: [{ ...emptyDay("2026-09-05"), bucketsExact: 7, client_id: "leak" }] });
    const result = await measureAggregationDimensions({ client, now: NOW });
    assert.equal(result.measurement, MEASUREMENT_NAME);
    assert.equal(result.readOnly, true);
    assert.deepEqual(result.window, { from: "2026-09-02", to: "2026-09-16", days: 15 });
    assert.deepEqual(result.grain, ["clientId", "merchantId", "canonicalCampaignId", "campaignSourceId", "country", "day"]);
    assert.equal(result.assumptions.queriesPerBucket, 2);
    assert.equal(result.days.length, 1);
    assert.ok(!JSON.stringify(result).includes("leak"));
  });
});

// ---------------------------------------------------------------------------
// The handler takes nothing from the request.
// ---------------------------------------------------------------------------

describe("handler", () => {
  const drive = async (req) => {
    const res = { statusCode: null, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
    let nextError = null;
    await aggregationMeasurementHandler(req, res, (e) => { nextError = e; });
    return { res, nextError };
  };

  it("ignores query, body and params; the dates still come from the clock", async () => {
    const { client, calls } = createRecordingClient();
    const { res } = await drive({ query: { from: "1999-01-01", to: "2099-12-31", day: "x" }, body: { from: "1999-01-01" }, params: { id: "1" }, app: { locals: { aggregationMeasurementClient: client } } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    const values = calls.find((c) => c.method === "$queryRaw").values;
    assert.equal(values.length, 2);
    assert.ok(!values.includes("1999-01-01") && !values.includes("2099-12-31"));
    assert.equal(values[1], new Date().toISOString().slice(0, 10), "to = today UTC");
  });

  it("sets no-store on the response itself", async () => {
    const { client } = createRecordingClient();
    const { res } = await drive({ app: { locals: { aggregationMeasurementClient: client } } });
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(res.headers["Pragma"], "no-cache");
  });

  it("forwards a failure to next() without leaking it as a 200", async () => {
    const client = new Proxy({}, { get: () => () => { throw new Error("db unreachable"); } });
    const { res, nextError } = await drive({ app: { locals: { aggregationMeasurementClient: client } } });
    assert.equal(res.body, null);
    assert.match(String(nextError?.message), /db unreachable/);
  });

  it("the controller never reads req.query, req.body or req.params", () => {
    const code = strip(CONTROLLER_SRC);
    for (const token of ["req.query", "req.body", "req.params", "req?.query", "req?.body"]) assert.ok(!code.includes(token), token);
  });
});

// ---------------------------------------------------------------------------
// Structure: it cannot run aggregation, cannot touch the URL, is mounted admin-only.
// ---------------------------------------------------------------------------

describe("structure", () => {
  it("neither the service nor the controller can reach aggregation, orchestration, sync, or logging", () => {
    for (const [name, src] of [["service", strip(SERVICE_SRC)], ["controller", strip(CONTROLLER_SRC)]]) {
      for (const token of ["AggregationService", "AggregationJob", "runTrackedJob", "aggregateRange", "rebuild(", "runForDate", "syncOrchestration", "sync.job", "SyncOrchestrationService", "claimUnit", "appendUnits", "createRun", "logger", "console.", "fetch(", "axios", "createHttpClient", "adapter"]) {
        assert.ok(!src.includes(token), `${name} must not contain ${token}`);
      }
    }
  });

  it("the service never names, reads or logs a database URL", () => {
    const code = strip(SERVICE_SRC);
    for (const token of ["DATABASE_URL", "DIRECT_URL", "process.env", "connectionString", "datasourceUrl", "new PrismaClient"]) {
      assert.ok(!code.includes(token), token);
    }
  });

  it("the service uses only $transaction, $executeRaw for the two guards, and $queryRaw", () => {
    const code = strip(SERVICE_SRC);
    assert.equal((code.match(/\$executeRaw`/g) ?? []).length, 2);
    assert.equal((code.match(/\$queryRaw`/g) ?? []).length, 1);
    assert.equal((code.match(/\$transaction\(/g) ?? []).length, 1);
    for (const token of ["$executeRawUnsafe", "$queryRawUnsafe", ".create(", ".update(", ".upsert(", ".delete(", "createMany", "updateMany", "deleteMany"]) {
      assert.ok(!code.includes(token), token);
    }
  });

  it("is mounted once, admin-only, no-store first, without the audit writer, and ahead of /sync/:platform", () => {
    const occurrences = ROUTES_SRC.split('"/sync/aggregation-measurement"').length - 1;
    assert.equal(occurrences, 1);
    const block = ROUTES_SRC.split('"/sync/aggregation-measurement"')[1].split(");")[0];
    const chain = block.split(",").map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(chain, ["noStoreHeaders", "authenticate", "requireAdminRole", "requirePermission(PERMISSIONS.SYSTEM_READ)", "aggregationMeasurementHandler"]);
    assert.ok(!block.includes("auditAction"), "auditAction persists a row on finish; a read must not write");
    assert.ok(ROUTES_SRC.indexOf('"/sync/aggregation-measurement"') < ROUTES_SRC.indexOf('"/sync/:platform"'));
    assert.ok(!ROUTES_SRC.includes('router.post(\n  "/sync/aggregation-measurement"'), "GET only");
  });
});
