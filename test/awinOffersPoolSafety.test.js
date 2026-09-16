import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { runWithConcurrency } from "../src/core/concurrency.js";
import {
  DB_WORK_CONCURRENCY_CEILING,
  DB_WORK_CONCURRENCY_DEFAULT,
  createPermitPool,
  resolveDbConcurrency,
} from "../src/core/dbPermits.js";
import { createFakeConnectionPool } from "./helpers/fakeConnectionPool.js";
import { functionBody } from "./helpers/jsGuardScan.js";

/** Production's pool, per the runtime error on Awin sequence 97. */
const POOL = { limit: 5, timeoutMs: 10_000 };

// ---------------------------------------------------------------------------
// The limits themselves.
// ---------------------------------------------------------------------------

test("no fan-out may be configured wider than the pool leaves room for", () => {
  assert.ok(DB_WORK_CONCURRENCY_CEILING < POOL.limit, "a fan-out must leave the pool headroom");
  assert.equal(resolveDbConcurrency(undefined), DB_WORK_CONCURRENCY_DEFAULT);
  assert.equal(resolveDbConcurrency(50), DB_WORK_CONCURRENCY_CEILING, "the old 50 must clamp");
  assert.equal(resolveDbConcurrency(25), DB_WORK_CONCURRENCY_CEILING, "the old 25 must clamp");
  assert.equal(resolveDbConcurrency("not-a-number"), DB_WORK_CONCURRENCY_DEFAULT);
  assert.equal(resolveDbConcurrency(""), DB_WORK_CONCURRENCY_DEFAULT);
  assert.equal(resolveDbConcurrency(0), 1);
  assert.equal(resolveDbConcurrency(-9), 1);
  assert.equal(resolveDbConcurrency(2), 2, "a safe request is honoured");
});

test("a custom fallback is itself clamped, so no caller can opt out", () => {
  assert.equal(resolveDbConcurrency(undefined, 50), DB_WORK_CONCURRENCY_CEILING);
  assert.equal(resolveDbConcurrency(undefined, 0), 1);
  assert.equal(resolveDbConcurrency(undefined, 3), 3);
});

// ---------------------------------------------------------------------------
// The failure, reproduced against a pool that behaves like production's.
// ---------------------------------------------------------------------------

/** One Awin offer row's database work, in the order upsertRawEntity performs it. */
async function offerRowWork(pool, { fieldPaths, fieldConcurrency }) {
  // persistRawPayload(RECEIVED): findUnique + create
  await pool.query();
  await pool.query();
  if (fieldConcurrency > 0) {
    // schema observation: one stats upsert plus one upsert per field path
    await pool.query();
    await runWithConcurrency(fieldPaths, fieldConcurrency, () => pool.query());
  }
  // upsertCouponFromSync: entity.findUnique then create/update
  await pool.query();
  await pool.query();
  // persistRawPayload(STAGED): findUnique + update
  await pool.query();
  await pool.query();
}

const FIELD_PATHS = Array.from({ length: 18 }, (_, i) => `field-${i}`);

test("the old shape exhausts the pool: 50 rows wide, each fanning out 25 more", async () => {
  const pool = createFakeConnectionPool({ ...POOL, timeoutMs: 120, queryMs: 2 });
  const rows = Array.from({ length: 60 }, (_, i) => i);

  const failures = [];
  await runWithConcurrency(rows, 50, async () => {
    try {
      await offerRowWork(pool, { fieldPaths: FIELD_PATHS, fieldConcurrency: 25 });
    } catch (error) {
      failures.push(error);
    }
  });

  const stats = pool.stats();
  assert.equal(stats.peakInUse, POOL.limit, "the pool saturates");
  assert.ok(stats.peakWaiting > POOL.limit, `queue depth ${stats.peakWaiting} must exceed the pool`);
  assert.ok(failures.length > 0, "the old shape must actually fail");
  assert.match(failures[0].message, /Timed out fetching a new connection from the connection pool/);
  assert.match(failures[0].message, /connection limit: 5/);
});

test("the new shape never queues more than the pool can serve", async () => {
  const pool = createFakeConnectionPool({ ...POOL, timeoutMs: 120, queryMs: 2 });
  const rows = Array.from({ length: 400 }, (_, i) => i);

  const failures = [];
  // Observation is lifted out of the rows, so a row no longer fans out at all.
  await runWithConcurrency(rows, resolveDbConcurrency(50), async () => {
    try {
      await offerRowWork(pool, { fieldPaths: FIELD_PATHS, fieldConcurrency: 0 });
    } catch (error) {
      failures.push(error);
    }
  });

  const stats = pool.stats();
  assert.deepEqual(failures, [], "no row may time out");
  assert.equal(stats.timeouts, 0);
  assert.ok(
    stats.peakInUse <= POOL.limit,
    `peak ${stats.peakInUse} connections must stay within the pool`,
  );
  assert.ok(
    stats.peakWaiting <= DB_WORK_CONCURRENCY_CEILING,
    `queue depth ${stats.peakWaiting} must stay bounded by the fan-out`,
  );
});

test("volume does not change the picture: the bound is on concurrency, not on row count", async () => {
  for (const rowCount of [10, 200, 2000]) {
    const pool = createFakeConnectionPool({ ...POOL, timeoutMs: 120, queryMs: 0 });
    await runWithConcurrency(
      Array.from({ length: rowCount }, (_, i) => i),
      resolveDbConcurrency(50),
      () => offerRowWork(pool, { fieldPaths: FIELD_PATHS, fieldConcurrency: 0 }),
    );
    const stats = pool.stats();
    assert.equal(stats.timeouts, 0, `${rowCount} rows must not time out`);
    assert.ok(stats.peakInUse <= POOL.limit, `${rowCount} rows peaked at ${stats.peakInUse}`);
  }
});

test("batch observation on its own also stays inside the pool", async () => {
  const pool = createFakeConnectionPool({ ...POOL, timeoutMs: 120, queryMs: 2 });
  await pool.query();
  await runWithConcurrency(FIELD_PATHS, resolveDbConcurrency(25), () => pool.query());
  const stats = pool.stats();
  assert.equal(stats.timeouts, 0);
  assert.ok(stats.peakInUse <= POOL.limit, `peak ${stats.peakInUse}`);
});

test("even the worst legal nesting of two bounded fan-outs would overrun the pool", () => {
  // Why observation is lifted out of the rows rather than merely narrowed: two bounded fan-outs
  // still multiply, and 4 x 4 is already past a pool of 5.
  const outer = resolveDbConcurrency(50);
  const inner = resolveDbConcurrency(25);
  assert.ok(
    outer * inner > POOL.limit,
    "nesting two bounded fan-outs is not a fix, which is why the inner one is removed",
  );
});

// ---------------------------------------------------------------------------
// The call sites, pinned where they are written.
// ---------------------------------------------------------------------------

const rawService = await readFile(new URL("../src/modules/raw/raw.service.js", import.meta.url), "utf8");

test("the coupon and offer fan-out is bounded against the pool", () => {
  const body = functionBody(rawService, "upsertCouponRows");
  assert.ok(
    body.includes("runWithConcurrency(prepared, COUPON_ROW_CONCURRENCY"),
    "the row fan-out must use the pool-safe bound",
  );
  assert.ok(
    rawService.includes("const COUPON_ROW_CONCURRENCY = resolveDbConcurrency(SYNC_UPSERT_CONCURRENCY)"),
    "the bound must be clamped, not taken from configuration as-is",
  );
});

test("a coupon or offer row never fans out schema observation of its own", () => {
  const body = functionBody(rawService, "upsertCouponRows");
  assert.ok(
    body.includes("observeSchema: false"),
    "per-row observation must be off so the row fan-out cannot nest another",
  );
  assert.ok(
    body.includes("persistRawPayloadsForPreparedRecords("),
    "the batch must still be observed, once, outside the rows",
  );
});

test("the staged-lineage write never re-observes a payload the same call already observed", () => {
  const body = functionBody(rawService, "upsertRawEntity");
  const stagedAt = body.indexOf('processingStatus: "STAGED"');
  assert.ok(stagedAt > 0);
  assert.ok(
    body.slice(stagedAt - 400, stagedAt + 200).includes("observeSchema: false"),
    "the second persist of the same payload must not observe it again",
  );
});

test("the batch staging path tells the coupon fan-out its rows are already observed", () => {
  const body = functionBody(rawService, "upsertManyRawEntities");
  assert.ok(
    body.includes("alreadyObserved: true"),
    "rows staged and observed by the batch pass must not be observed again per row",
  );
});

test("the field registry fan-out is sized against the pool", async () => {
  const observer = await readFile(
    new URL("../src/field-system/sourceSchemaObserver.service.js", import.meta.url),
    "utf8",
  );
  assert.ok(
    observer.includes("const FIELD_UPSERT_CONCURRENCY = resolveDbConcurrency("),
    "the leaf fan-out must be clamped too",
  );
  assert.ok(!observer.includes("FIELD_UPSERT_CONCURRENCY = 25"), "the unbounded 25 must be gone");
});

// ---------------------------------------------------------------------------
// The permit pool primitive, now shared.
// ---------------------------------------------------------------------------

test("the shared permit pool still caps and still returns every permit", async () => {
  const pool = createPermitPool(3);
  let live = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 50 }, async () => {
      await pool.acquire();
      live += 1;
      peak = Math.max(peak, live);
      try {
        await new Promise((r) => setTimeout(r, 1));
      } finally {
        live -= 1;
        pool.release();
      }
    }),
  );
  assert.equal(peak, 3);
  assert.equal(pool.available(), 3);
});

test("the commission fan-out still resolves through the shared clamp", async () => {
  const { resolveRuleConcurrency, SUPPLIER_COMMISSION_RULE_CONCURRENCY } = await import(
    "../src/modules/commercial/supplierCommissionRuleSync.service.js"
  );
  assert.equal(SUPPLIER_COMMISSION_RULE_CONCURRENCY, 3);
  assert.equal(resolveRuleConcurrency(8), DB_WORK_CONCURRENCY_CEILING);
  assert.equal(resolveRuleConcurrency(undefined), 3, "its own default is kept");
});
