/**
 * Phase 8B — durable incremental is a breadth of the one run kind, not a second kind.
 *
 * `kind` used to force fastSync true for "incremental", which was the only way it reached the
 * plan. It planned an identical unit set either way, so the coercion bought nothing and cost the
 * run payload its accuracy. With it gone, breadth lives entirely in options.fastSync, and reuse
 * follows the one relation that is actually true of it: a non-fast run does everything a fast run
 * would and more.
 *
 * These tests need no database: the unit-identity claim is a property of the planner alone, and
 * the predicate shapes are read from source. The stateful half — reuse, collapse and the parent
 * payload agreeing with its units — lives in syncAllOrchestration.test.js, beside the in-memory
 * JobRun store it needs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { PLANNER_VERSION, buildSyncPlan } from "../src/jobs/syncOrchestration.service.js";

const SERVICE_SRC = readFileSync(new URL("../src/jobs/syncOrchestration.service.js", import.meta.url), "utf8");
const CONTROLLER_SRC = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const LAST_SYNC = "2026-09-10T00:00:00.000Z";
const planOpts = {
  listAccounts: async (platform) =>
    platform === "boostiny" ? [{ accountLabel: "default", lastSuccessfulSync: LAST_SYNC }] : [],
  loadAccountState: async () => ({ lastSuccessfulSync: LAST_SYNC }),
  now: new Date("2026-09-18T00:00:00.000Z"),
};

/** A unit's identity: what work it is, ignoring the breadth flag carried alongside it. */
const identities = (plan) =>
  plan.units.map((u) =>
    [u.kind, u.platform ?? "-", u.accountLabel ?? "-", u.sourceObject ?? "-", u.windowStart ?? "-", u.windowEnd ?? "-", u.campaignPageIndex ?? "-"].join("|"),
  );
const breadths = (plan) => [...new Set(plan.units.map((u) => u.options?.fastSync))];

describe("Phase 8B — full and fast plan the same units", () => {
  it("full(false) and fast(true) produce identical unit identities", async () => {
    const full = await buildSyncPlan({ kind: "full", fastSync: false, ...planOpts });
    const fast = await buildSyncPlan({ kind: "full", fastSync: true, ...planOpts });
    assert.ok(full.units.length > 0, "the fixture plans real units");
    assert.deepEqual(identities(fast), identities(full), "breadth does not change which units exist");
    assert.deepEqual(full.exclusions, fast.exclusions);
    assert.deepEqual(full.deferred, fast.deferred);
    // Only the flag differs, and it differs uniformly.
    assert.deepEqual(breadths(full), [false]);
    assert.deepEqual(breadths(fast), [true]);
  });

  it("kind no longer changes the plan at all — including its breadth flag", async () => {
    const full = await buildSyncPlan({ kind: "full", fastSync: false, ...planOpts });
    const incremental = await buildSyncPlan({ kind: "incremental", ...planOpts });
    assert.deepEqual(identities(incremental), identities(full));
    // The retired coercion: "incremental" with no fastSync option used to yield true here while
    // the run payload recorded false. It must now follow options alone.
    assert.deepEqual(breadths(incremental), [false], "kind does not force fastSync any more");

    const incrementalFast = await buildSyncPlan({ kind: "incremental", fastSync: true, ...planOpts });
    assert.deepEqual(breadths(incrementalFast), [true], "options still decide breadth");
  });

  it("the coercion is gone from the PLANNER, not merely unreachable", () => {
    const code = codeOnly(SERVICE_SRC);
    const planner = code.split("export async function buildSyncPlan(")[1].split("\nexport ")[0];
    assert.ok(!planner.includes('kind === "incremental"'), "the kind coercion is back in the planner");
    assert.ok(!planner.includes("fastSync: kind"), "kind must not reach the breadth flag");
    assert.match(planner, /const networkOptions = \{ fastSync: Boolean\(fastSync\), promoteAfter: false \};/);
    // kind survives ONLY as a reporting label, which the phase deliberately keeps.
    const reporting = code.split("jobName: kind ===")[1]?.split("\n")[0] ?? "";
    assert.match(reporting, /"scheduledSyncAll"/, "the status display name still distinguishes kinds");
  });
});

describe("Phase 8B — reuse is breadth-aware, identity is exact", () => {
  const conditionsOf = (name) => codeOnly(SERVICE_SRC).split(`function ${name}(`)[1].split("\n}")[0];

  it("identityConditions stays exact on fastSync, because its callers CANCEL runs", () => {
    const body = conditionsOf("identityConditions");
    assert.match(body, /path: \["options", "fastSync"\], equals: Boolean\(options\.fastSync\)/);
    assert.match(body, /path: \["options", "promoteAfter"\], equals: options\.promoteAfter !== false/);
    assert.match(body, /path: \["plannerVersion"\], equals: plannerVersion/);
    // No breadth relaxation anywhere in the duplicate predicate.
    assert.ok(!body.includes("if (!options.fastSync)"), "identity must not be breadth-aware");
  });

  it("compatibilityConditions relaxes fastSync for a fast request and only for a fast request", () => {
    const body = conditionsOf("compatibilityConditions");
    assert.match(body, /if \(!options\.fastSync\) \{/, "the condition is added only for a non-fast request");
    assert.match(body, /path: \["options", "fastSync"\], equals: false/);
    // promoteAfter and plannerVersion are never relaxed.
    assert.match(body, /path: \["options", "promoteAfter"\], equals: options\.promoteAfter !== false/);
    assert.match(body, /path: \["plannerVersion"\], equals: plannerVersion/);
  });

  it("collapse reads the EXACT predicate and reuse reads the breadth-aware one", () => {
    const code = codeOnly(SERVICE_SRC);
    const listCompatible = code.split("async listActiveCompatibleRuns(")[1].split("\n  }")[0];
    assert.match(listCompatible, /identityConditions\(\{ options, plannerVersion \}\)/, "collapse must use exact identity");
    assert.ok(!listCompatible.includes("compatibilityConditions("), "collapse must not use the breadth predicate");

    const findActive = code.split("async findActiveRun(")[1].split("\n  }")[0];
    assert.match(findActive, /compatibilityConditions\(\{ options, plannerVersion \}\)/);

    // Reusing a broader run must collapse duplicates of THAT run, keyed by its own options.
    const getOrCreate = code.split("async getOrCreateRun(")[1].split("\n  }")[0];
    assert.match(getOrCreate, /const canonicalOptions = existing\.payload\?\.options \?\? options;/);
    assert.match(getOrCreate, /#collapseDuplicatesOf\(existing\.id, \{ options: canonicalOptions, plannerVersion \}\)/);
  });
});

describe("Phase 8B — the API surface and its blast radius", () => {
  it("/sync/all reports truthfully when a fast request is answered with a broader run", () => {
    const handler = codeOnly(CONTROLLER_SRC)
      .split("export async function triggerSyncAll(")[1]
      .split("\n}\n")[0];
    assert.match(handler, /const reusedBroaderRun = !run\.created && Boolean\(fastSync\) && run\.options\?\.fastSync === false;/);
    assert.match(handler, /reusedBroaderRun,/, "the flag is returned, not only computed");
    assert.match(handler, /res\.status\(202\)/);
    assert.match(handler, /created: run\.created/);
  });

  it("/sync/incremental is still retired — Phase 8B does not revive it", () => {
    const incremental = codeOnly(CONTROLLER_SRC)
      .split("export async function triggerIncrementalSync(")[1]
      .split("\n}\n")[0];
    assert.match(incremental, /res\.status\(410\)/);
    assert.match(incremental, /code: LEGACY_INCREMENTAL_RETIRED_CODE/);
    assert.ok(!incremental.includes("getOrCreateRun"), "still not a redirect");
  });

  it("the machine-auth cron surface is untouched by this phase", () => {
    const cron = readFileSync(new URL("../src/controllers/internalCron.controller.js", import.meta.url), "utf8");
    assert.match(cron, /kind: "full"/, "sync-start still asks for a full run");
    assert.ok(!cron.includes("fastSync: true"), "no fast mode was added to the cron surface");
  });

  it("no schema change, no migration, and the planner version is unmoved", () => {
    // This change did not move the shape. The version has since moved for reasons of its own
    // (Awin offers became durable-paged at 7), so what is pinned is that it did not move HERE.
    assert.equal(typeof PLANNER_VERSION, "number");
    assert.match(SERVICE_SRC, new RegExp(`export const PLANNER_VERSION = ${PLANNER_VERSION};`));
    for (const forbidden of ["prisma.$executeRaw", "ALTER TABLE", "CREATE TABLE", "migrate"]) {
      assert.ok(!SERVICE_SRC.includes(forbidden), forbidden);
    }
  });
});
