import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { runWithConcurrency } from "../src/core/concurrency.js";
import {
  DB_POOL_LIMIT_DEFAULT,
  DB_POOL_RESERVE,
  DB_WORK_CONCURRENCY_CEILING,
  createPermitPool,
  maxConcurrentDbDemand,
  resolveAccountConcurrency,
  resolveDbPoolLimit,
} from "../src/core/dbPermits.js";
import {
  DB_POOL_LIMIT,
  SAFE_SYNC_ACCOUNT_CONCURRENCY,
  SYNC_ACCOUNT_CONCURRENCY,
} from "../src/jobs/syncConfig.js";
import { createFakeConnectionPool } from "./helpers/fakeConnectionPool.js";
import { functionBody, guardsFor } from "./helpers/jsGuardScan.js";

// ---------------------------------------------------------------------------
// The invariant: account fan-out demand must fit the pool with the reserve intact.
// ---------------------------------------------------------------------------

test("the shipped configuration satisfies the invariant", () => {
  const demand = maxConcurrentDbDemand({ accountConcurrency: SAFE_SYNC_ACCOUNT_CONCURRENCY });
  assert.ok(
    demand + DB_POOL_RESERVE <= DB_POOL_LIMIT,
    `demand ${demand} plus reserve ${DB_POOL_RESERVE} must fit pool ${DB_POOL_LIMIT}`,
  );
});

test("a request of 3 against pool 5 and a per-account fan-out of 4 resolves to 1", () => {
  assert.equal(
    resolveAccountConcurrency({ requested: 3, poolLimit: 5, perAccountConcurrency: 4 }),
    1,
  );
  assert.equal(SYNC_ACCOUNT_CONCURRENCY, 3, "the request is still 3");
  assert.equal(SAFE_SYNC_ACCOUNT_CONCURRENCY, 1, "what the pool affords is 1");
});

test("the effective cap is derived from the budget, not hardcoded", () => {
  // Same per-account fan-out, bigger pool: more accounts become affordable.
  assert.equal(resolveAccountConcurrency({ requested: 8, poolLimit: 9, perAccountConcurrency: 4 }), 2);
  assert.equal(resolveAccountConcurrency({ requested: 8, poolLimit: 13, perAccountConcurrency: 4 }), 3);
  // Same pool, smaller per-account fan-out: likewise.
  assert.equal(resolveAccountConcurrency({ requested: 8, poolLimit: 5, perAccountConcurrency: 1 }), 4);
  assert.equal(resolveAccountConcurrency({ requested: 8, poolLimit: 5, perAccountConcurrency: 2 }), 2);
});

test("a request smaller than the budget is honoured, never raised", () => {
  assert.equal(resolveAccountConcurrency({ requested: 1, poolLimit: 21, perAccountConcurrency: 4 }), 1);
  assert.equal(resolveAccountConcurrency({ requested: 2, poolLimit: 21, perAccountConcurrency: 4 }), 2);
});

test("a very large configured account concurrency is still clamped to the budget", () => {
  for (const requested of [3, 50, 1000, Number.MAX_SAFE_INTEGER]) {
    const resolved = resolveAccountConcurrency({ requested, poolLimit: 5, perAccountConcurrency: 4 });
    assert.equal(resolved, 1, `${requested} must not widen the cap`);
    assert.ok(maxConcurrentDbDemand({ accountConcurrency: resolved }) + DB_POOL_RESERVE <= 5);
  }
});

test("small and degenerate pool values never produce a zero or negative cap", () => {
  for (const poolLimit of [1, 2, 3, 4, 5]) {
    const resolved = resolveAccountConcurrency({ requested: 3, poolLimit, perAccountConcurrency: 4 });
    assert.ok(resolved >= 1, `pool ${poolLimit} must still allow one account`);
    assert.equal(resolved, 1, `pool ${poolLimit} affords a single account at a fan-out of 4`);
  }
});

test("malformed configuration falls back safely rather than widening anything", () => {
  assert.equal(resolveDbPoolLimit(undefined), DB_POOL_LIMIT_DEFAULT);
  assert.equal(resolveDbPoolLimit(""), DB_POOL_LIMIT_DEFAULT);
  assert.equal(resolveDbPoolLimit("not-a-number"), DB_POOL_LIMIT_DEFAULT);
  assert.equal(resolveDbPoolLimit(0), DB_POOL_LIMIT_DEFAULT);
  assert.equal(resolveDbPoolLimit(-4), DB_POOL_LIMIT_DEFAULT);
  assert.equal(resolveDbPoolLimit("8"), 8, "a sane value is honoured");

  for (const requested of [undefined, null, "", "abc", 0, -1, Number.NaN, Infinity]) {
    const resolved = resolveAccountConcurrency({ requested, poolLimit: 5, perAccountConcurrency: 4 });
    assert.equal(resolved, 1, `${String(requested)} must fall back to a single account`);
  }
});

test("no configuration combination can multiply past the budget", () => {
  for (const poolLimit of [1, 5, 9, 13, 40]) {
    for (const perAccount of [1, 2, 3, 4]) {
      for (const requested of [1, 3, 50, 10_000]) {
        const accounts = resolveAccountConcurrency({ requested, poolLimit, perAccountConcurrency: perAccount });
        const demand = maxConcurrentDbDemand({
          accountConcurrency: accounts,
          perAccountConcurrency: perAccount,
        });
        const budget = Math.max(1, resolveDbPoolLimit(poolLimit) - DB_POOL_RESERVE);
        assert.ok(
          demand <= budget || accounts === 1,
          `pool ${poolLimit} / per-account ${perAccount} / requested ${requested} demanded ${demand} against budget ${budget}`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Behaviour against a pool that acts like production's.
// ---------------------------------------------------------------------------

const POOL = { limit: 5, timeoutMs: 10_000 };

/** One account's DB-heavy work: a bounded fan-out at the per-account ceiling. */
async function accountWork(pool, rows = 40) {
  await runWithConcurrency(
    Array.from({ length: rows }, (_, i) => i),
    DB_WORK_CONCURRENCY_CEILING,
    async () => {
      await pool.query();
      await pool.query();
    },
  );
}

test("many accounts gated by the cap never exceed the pool", async () => {
  const pool = createFakeConnectionPool({ ...POOL, timeoutMs: 150, queryMs: 1 });
  const permits = createPermitPool(SAFE_SYNC_ACCOUNT_CONCURRENCY);
  const failures = [];

  // Nine accounts: three Optimise regions, each with three accounts, as a full sync would.
  await Promise.all(
    Array.from({ length: 9 }, async () => {
      await permits.acquire();
      try {
        await accountWork(pool);
      } catch (error) {
        failures.push(error);
      } finally {
        permits.release();
      }
    }),
  );

  const stats = pool.stats();
  assert.deepEqual(failures, [], "no account may time out");
  assert.equal(stats.timeouts, 0);
  assert.ok(stats.peakInUse <= POOL.limit, `peak ${stats.peakInUse} must stay within the pool`);
  assert.ok(
    stats.peakInUse <= DB_WORK_CONCURRENCY_CEILING,
    `peak ${stats.peakInUse} must stay within one account's share`,
  );
  assert.equal(permits.available(), SAFE_SYNC_ACCOUNT_CONCURRENCY, "every permit returned");
});

test("without the cap nine accounts demand far more than the pool holds", async () => {
  // Demand is what the cap governs, and it exceeds the pool regardless of how fast queries are.
  const pool = createFakeConnectionPool({ ...POOL, timeoutMs: 10_000, queryMs: 0 });
  await Promise.all(Array.from({ length: 9 }, () => accountWork(pool, 10)));
  const stats = pool.stats();
  assert.equal(
    stats.peakWaiting + POOL.limit,
    9 * DB_WORK_CONCURRENCY_CEILING,
    "all nine accounts' fan-outs are in flight at once",
  );
  assert.ok(stats.peakWaiting > POOL.limit, `queue depth ${stats.peakWaiting} must exceed the pool`);
});

test("that demand becomes P2024 once queries are slow enough to hold connections", async () => {
  // Whether the queue turns into a timeout is a function of query latency, so this fixes a
  // latency at which it does, rather than pretending depth alone is the failure.
  const pool = createFakeConnectionPool({ ...POOL, timeoutMs: 150, queryMs: 30 });
  const failures = [];
  await Promise.all(
    Array.from({ length: 9 }, async () => {
      try {
        await accountWork(pool, 5);
      } catch (error) {
        failures.push(error);
      }
    }),
  );
  assert.ok(failures.length > 0, "the uncapped shape must actually fail");
  assert.match(failures[0].message, /Timed out fetching a new connection from the connection pool/);
  assert.match(failures[0].message, /connection limit: 5/);
});

test("the cap holds at that same latency", async () => {
  const pool = createFakeConnectionPool({ ...POOL, timeoutMs: 150, queryMs: 30 });
  const permits = createPermitPool(SAFE_SYNC_ACCOUNT_CONCURRENCY);
  const failures = [];
  await Promise.all(
    Array.from({ length: 9 }, async () => {
      await permits.acquire();
      try {
        await accountWork(pool, 5);
      } catch (error) {
        failures.push(error);
      } finally {
        permits.release();
      }
    }),
  );
  assert.deepEqual(failures, [], "no account may time out at the latency that broke the uncapped run");
  assert.ok(pool.stats().peakInUse <= POOL.limit);
});

test("one account still runs at full speed under the cap", async () => {
  const pool = createFakeConnectionPool({ ...POOL, timeoutMs: 150, queryMs: 1 });
  const permits = createPermitPool(SAFE_SYNC_ACCOUNT_CONCURRENCY);
  await permits.acquire();
  try {
    await accountWork(pool);
  } finally {
    permits.release();
  }
  const stats = pool.stats();
  assert.equal(stats.timeouts, 0);
  assert.equal(
    stats.peakInUse,
    DB_WORK_CONCURRENCY_CEILING,
    "a lone account must still use its whole share",
  );
});

// ---------------------------------------------------------------------------
// Deadlock freedom: account permits are taken once, and never from inside.
// ---------------------------------------------------------------------------

test("account permits and fan-out permits compose in one direction only", async () => {
  const accounts = createPermitPool(1);
  const rules = createPermitPool(3);
  let done = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      await accounts.acquire();
      try {
        await rules.acquire();
        try {
          await new Promise((r) => setTimeout(r, 1));
        } finally {
          rules.release();
        }
        done += 1;
      } finally {
        accounts.release();
      }
    }),
  );
  assert.equal(done, 6, "every task completed; the ordering cannot cycle");
  assert.equal(accounts.available(), 1);
  assert.equal(rules.available(), 3);
});

const syncJob = await readFile(new URL("../src/jobs/sync.job.js", import.meta.url), "utf8");

test("the account permit is acquired exactly once, at the top of the account's work", () => {
  const body = functionBody(syncJob, "syncAccountsWithConcurrency");
  assert.equal(
    body.split("accountPermits.acquire(").length - 1,
    1,
    "a second acquisition inside the same holder could deadlock",
  );
  assert.equal(body.split("accountPermits.release(").length - 1, 1);
  assert.ok(body.includes("} finally {"), "the permit must be released even when the account throws");
  assert.ok(
    guardsFor(body, "accountPermits.release(")[0].includes("finally"),
    "release must sit in the finally block",
  );
});

test("nothing else in the sync job acquires an account permit", () => {
  assert.equal(
    syncJob.split("accountPermits.acquire(").length - 1,
    1,
    "only the account fan-out may take an account permit",
  );
});

test("the account fan-out is sized by the budget, not by the raw request", () => {
  const body = functionBody(syncJob, "syncAccountsWithConcurrency");
  assert.ok(body.includes("SAFE_SYNC_ACCOUNT_CONCURRENCY"));
  assert.ok(!body.includes("runWithConcurrency(accountLabels, SYNC_ACCOUNT_CONCURRENCY"));
  assert.ok(
    syncJob.includes("const accountPermits = createPermitPool(SAFE_SYNC_ACCOUNT_CONCURRENCY)"),
    "the process-wide cap must come from the derived value",
  );
});

// ---------------------------------------------------------------------------
// The worker path must not change.
// ---------------------------------------------------------------------------

test("a named account still syncs directly, bypassing the account fan-out", () => {
  const body = functionBody(syncJob, "syncPlatformAccount");
  for (const [call, label] of [
    ["syncOptimiseRegion(region, accountLabel)", "optimise"],
    ["syncBoostinyAccount(accountLabel)", "boostiny"],
    ["syncTrackierAccount(accountLabel)", "trackier"],
  ]) {
    assert.ok(body.includes(call), `${label} single-account path must remain a direct call`);
    assert.ok(
      guardsFor(body, call)[0].includes("accountLabel"),
      `${label} must take that path only when an account is named`,
    );
  }
  assert.ok(
    !guardsFor(body, "syncOptimiseRegion(region, accountLabel)")[0].includes("accountPermits"),
    "one-unit worker execution must not wait on an account permit",
  );
});
