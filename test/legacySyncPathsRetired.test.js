/**
 * Phase 8A — the legacy sync paths are retired.
 *
 * Two things were retired together, for one reason: neither could survive a long-running runtime.
 * The in-process scheduler armed a setInterval per process — meaning per INSTANCE, guarded only by
 * module memory — and /api/sync/incremental handed work to the fire-and-forget launcher and
 * answered 202 before any of it had happened.
 *
 * These tests exist because both failures are invisible in the shape that matters. A reintroduced
 * `startSyncScheduler()` in src/index.js does nothing on Vercel and is caught by no other test in
 * the suite: nothing else reads that file. So the guard has to name it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY_INCREMENTAL_RETIRED_CODE,
  triggerIncrementalSync,
} from "../src/controllers/sync.controller.js";
import { getSchedulerStatus } from "../src/jobs/syncScheduler.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const INDEX_SRC = read("src/index.js");
const SCHEDULER_SRC = read("src/jobs/syncScheduler.js");
const CONTROLLER_SRC = read("src/controllers/sync.controller.js");
const ROUTES_SRC = read("src/routes/index.js");
const CONFIG_SRC = read("src/jobs/syncConfig.js");

/** Every .js file under src/, so a guard cannot be dodged by moving the call somewhere new. */
function runtimeSources(dir = "src", acc = []) {
  const base = new URL(`../${dir}/`, import.meta.url).pathname;
  for (const entry of readdirSync(base)) {
    const abs = join(base, entry);
    if (statSync(abs).isDirectory()) runtimeSources(`${dir}/${entry}`, acc);
    else if (entry.endsWith(".js")) acc.push([`${dir}/${entry}`, readFileSync(abs, "utf8")]);
  }
  return acc;
}

describe("Phase 8A — the in-process scheduler is retired", () => {
  it("src/index.js neither imports nor calls the scheduler", () => {
    const code = codeOnly(INDEX_SRC);
    for (const token of ["startSyncScheduler", "stopSyncScheduler", "syncScheduler.js"]) {
      assert.ok(!code.includes(token), `${token} is back in src/index.js`);
    }
    // The rest of startup and shutdown is untouched: this phase removed two lines, not a lifecycle.
    assert.match(code, /const server = app\.listen\(port, \(\) => \{/);
    assert.match(code, /warmListCaches\(\)/);
    assert.match(code, /server\.close\(async \(\) => \{/);
    assert.match(code, /await closeRedis\(\);/);
    assert.match(code, /await prisma\.\$disconnect\(\);/);
    assert.match(code, /process\.on\("SIGTERM"/);
  });

  it("the scheduler module starts no work and holds no timer", () => {
    const code = codeOnly(SCHEDULER_SRC);
    for (const token of [
      "startSyncScheduler",
      "stopSyncScheduler",
      "triggerScheduledSync",
      "setInterval",
      "setTimeout",
      "runSyncInBackground",
      "syncAll",
      "sync.job.js",
      "ENABLE_SCHEDULER",
    ]) {
      assert.ok(!code.includes(token), `${token} is back in syncScheduler.js`);
    }
    // syncState is imported for a status READ only; nothing here can launch.
    assert.match(code, /import \{ getSyncStatus \} from "\.\/syncState\.js";/);
  });

  it("the status descriptor keeps every field its consumers read, and reports the retirement", () => {
    const status = getSchedulerStatus();
    // /health reads enabled + running; networkOps reads enabled + intervalMinutes + lastAttemptAt.
    for (const key of [
      "enabled",
      "retired",
      "running",
      "startedAt",
      "intervalMinutes",
      "initialDelayMs",
      "lastAttemptAt",
      "lastSkipReason",
      "syncStatus",
    ]) {
      assert.ok(key in status, `${key} missing from the retired descriptor`);
    }
    assert.equal(status.enabled, false);
    assert.equal(status.retired, true);
    assert.equal(status.running, false);
    // Null rather than a stale 360: there is no cadence to report.
    assert.equal(status.intervalMinutes, null);
    assert.equal(status.initialDelayMs, null);
  });

  it("the scheduler-only config is gone and the shared sync config is not", () => {
    const code = codeOnly(CONFIG_SRC);
    for (const gone of [
      "ENABLE_SCHEDULER",
      "SYNC_INTERVAL_MINUTES",
      "SYNC_SCHEDULER_INITIAL_DELAY_MS",
    ]) {
      assert.ok(!code.includes(gone), `${gone} should have been removed`);
    }
    for (const kept of [
      "FAST_SYNC",
      "AUTO_PROMOTE_AFTER_SYNC",
      "AUTO_AGGREGATE_AFTER_SYNC",
      "AGGREGATION_AFTER_SYNC_DAYS",
    ]) {
      assert.ok(code.includes(kept), `${kept} must not be touched by this phase`);
    }
  });
});

describe("Phase 8A — no runtime source launches sync in the background", () => {
  it("nothing under src/ calls the fire-and-forget launcher", () => {
    const offenders = runtimeSources()
      .filter(([path]) => path !== "src/jobs/syncState.js")
      .filter(([, source]) => codeOnly(source).includes("runSyncInBackground"));
    assert.deepEqual(offenders.map(([path]) => path), []);
  });

  it("syncState still EXPORTS the launcher for the operator CLI, which this phase does not touch", () => {
    // scripts/run-sync.js is operator-invoked and awaits the promise, so it is not fire-and-forget
    // in practice. Removing the export would break it; that is a separate decision.
    const code = codeOnly(read("src/jobs/syncState.js"));
    assert.match(code, /export function runSyncInBackground\(/);
    assert.match(code, /export async function runExclusiveSync\(/, "the awaited runner is untouched");
  });

  it("no runtime source under src/ schedules its own work", () => {
    const offenders = runtimeSources().filter(([, source]) => {
      const code = codeOnly(source);
      return code.includes("setInterval(") || code.includes("setImmediate(");
    });
    assert.deepEqual(offenders.map(([path]) => path), []);
  });
});

describe("Phase 8A — /api/sync/incremental is retired at 410", () => {
  function fakeRes() {
    const sent = {};
    return {
      sent,
      status(code) {
        sent.status = code;
        return this;
      },
      json(body) {
        sent.body = body;
        return this;
      },
    };
  }

  it("answers 410 with the stable refusal contract", async () => {
    const res = fakeRes();
    await triggerIncrementalSync({}, res);
    assert.equal(res.sent.status, 410);
    assert.equal(res.sent.body.ok, false);
    assert.equal(res.sent.body.code, "legacy_incremental_retired");
    assert.equal(res.sent.body.code, LEGACY_INCREMENTAL_RETIRED_CODE);
    assert.equal(typeof res.sent.body.message, "string");
    assert.match(res.sent.body.message, /durable orchestration/i);
  });

  it("starts nothing: no launcher, no durable run, no supplier work", async () => {
    const handler = codeOnly(CONTROLLER_SRC)
      .split("export async function triggerIncrementalSync(")[1]
      .split("\n}\n")[0];
    for (const forbidden of [
      "triggerScheduledSync",
      "runSyncInBackground",
      "getOrCreateRun",
      "claimUnit",
      "syncPlatformAccount",
      "await ",
    ]) {
      assert.ok(!handler.includes(forbidden), `${forbidden} in the retired handler`);
    }
  });

  it("the controller no longer imports the legacy launcher, but keeps the status read", () => {
    const code = codeOnly(CONTROLLER_SRC);
    assert.ok(!code.includes("triggerScheduledSync"), "the legacy import is gone");
    assert.match(code, /import \{ getSchedulerStatus \} from "\.\.\/jobs\/syncScheduler\.js";/);
  });

  it("the route stays registered behind its existing auth chain, so callers get 410 and not 404", () => {
    const block = ROUTES_SRC.split('"/sync/incremental"')[1].split(");")[0];
    assert.match(block, /authenticate/);
    assert.match(block, /requirePermission\(PERMISSIONS\.SYNC_TRIGGER\)/);
    assert.match(block, /auditAction\("sync\.incremental", "sync"\)/);
    assert.match(block, /triggerIncrementalSync/);
  });
});

describe("Phase 8A — the durable scheduling surface is untouched", () => {
  it("the machine-authed cron routes are unchanged", () => {
    assert.match(
      ROUTES_SRC,
      /router\.post\("\/internal\/cron\/sync-start", requireCronSecret, cronSyncStartHandler\);/,
    );
    assert.match(
      ROUTES_SRC,
      /router\.post\("\/internal\/cron\/sync-drain", requireCronSecret, cronSyncDrainHandler\);/,
    );
  });

  it("the worker and full-sync routes still reach the durable planner", () => {
    const code = codeOnly(CONTROLLER_SRC);
    assert.match(code, /export async function triggerSyncAll\(/);
    assert.match(code, /getOrCreateRun\(\{/);
    assert.match(code, /export async function triggerSyncWorker\(/);
    assert.match(code, /SyncOrchestrationService/);
  });

  it("neither GitHub workflow was touched: drain stays scheduled, start stays dispatch-only", () => {
    const drain = read(".github/workflows/sync-drain.yml");
    const start = read(".github/workflows/sync-start.yml");
    assert.match(drain, /^ {4}- cron: "\*\/5 \* \* \* \*"$/m, "the drain schedule changed");
    assert.match(drain, /^ {2}workflow_dispatch:$/m);
    assert.match(start, /^ {2}workflow_dispatch:$/m);
    assert.ok(!/^ {2}schedule:$/m.test(start), "sync-start must stay workflow_dispatch-only");
    // Neither workflow should have learned about the retired endpoint.
    for (const [name, source] of [["drain", drain], ["start", start]]) {
      assert.ok(!source.includes("sync/incremental"), `${name} references the retired route`);
    }
  });
});
