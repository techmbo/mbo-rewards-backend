/**
 * GET /sync/plan-preview — what a new /sync/all WOULD plan, and nothing else.
 *
 * The value of a preview is that it cannot lie about the run it describes, and cannot cost
 * anything to ask for. These tests hold both ends: the preview goes through the SAME planner
 * `/sync/all` enqueues with (identical units for identical account state), and the request writes
 * no JobRun row, takes no lock, touches no supplier and updates no timestamp.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { previewSyncPlanHandler, triggerSyncAll } from "../src/controllers/sync.controller.js";
import {
  ORCHESTRATION_JOB_NAME,
  UNIT_JOB_NAME,
  SyncOrchestrationService,
  buildSyncPlan,
  summarisePlan,
} from "../src/jobs/syncOrchestration.service.js";

const CONTROLLER_SRC = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");
const ROUTES_SRC = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
const SERVICE_SRC = readFileSync(new URL("../src/jobs/syncOrchestration.service.js", import.meta.url), "utf8");

const NOW = new Date("2026-09-15T00:00:00.000Z");
const now = () => NOW;
const ACCOUNTS = {
  boostiny: ["default"],
  optimise_sea: ["second", "default"],
  optimise_mena: [],
  optimise_uk: ["default"],
  trackier: ["default"],
};
const listAccounts = async (platform) => ACCOUNTS[platform] ?? ["default"];
// A never-synced estate plans its full initial lookback; one account is recent, so the preview
// has both shapes in it.
const loadAccountState = async (platform) =>
  platform === "trackier" ? { lastSuccessfulSync: new Date("2026-09-13T00:00:00.000Z") } : { lastSuccessfulSync: null };

/** A JobRun store that RECORDS every call, so "read-only" can be asserted rather than assumed. */
function createStore() {
  const rows = [];
  const calls = [];
  let seq = 0;
  const clone = (r) => JSON.parse(JSON.stringify(r));
  const jobRun = {
    async create({ data }) {
      calls.push("create");
      seq += 1;
      const row = { id: `row-${seq}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(NOW.getTime() + seq), ...data };
      rows.push(row);
      return clone(row);
    },
    async createMany({ data }) { calls.push("createMany"); for (const row of data) await jobRun.create({ data: row }); return { count: data.length }; },
    async update({ where, data }) { calls.push("update"); const row = rows.find((r) => r.id === where.id); Object.assign(row, data); return clone(row); },
    async updateMany() { calls.push("updateMany"); return { count: 0 }; },
    async deleteMany() { calls.push("deleteMany"); return { count: 0 }; },
    async findUnique({ where }) { calls.push("findUnique"); const row = rows.find((r) => r.id === where.id); return row ? clone(row) : null; },
    async findFirst() { calls.push("findFirst"); return null; },
    async findMany({ where }) { calls.push("findMany"); return rows.filter((r) => r.jobName === where?.jobName).map(clone); },
  };
  return { rows, calls, prisma: { jobRun, async $transaction(fn) { calls.push("$transaction"); return fn({ jobRun }); } } };
}

function harness() {
  const { rows, calls, prisma } = createStore();
  const supplierCalls = [];
  const lockCalls = [];
  const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts, loadAccountState });
  // Any lock acquisition would go through here; a preview must never reach it.
  for (const method of ["acquire", "renew", "release", "withLock"]) {
    const original = orchestration.locks[method].bind(orchestration.locks);
    orchestration.locks[method] = async (...args) => { lockCalls.push(method); return original(...args); };
  }
  const locals = {
    syncOrchestration: orchestration,
    syncPlatformAccount: async (...args) => { supplierCalls.push(args); return {}; },
  };
  const call = async (handler, query = {}) => {
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ query, app: { locals } }, res, (error) => { throw error; });
    return res;
  };
  return {
    rows, calls, supplierCalls, lockCalls, orchestration,
    preview: (query) => call(previewSyncPlanHandler, query),
    enqueue: (query) => call(triggerSyncAll, query),
  };
}

const WRITE_CALLS = ["create", "createMany", "update", "updateMany", "deleteMany", "$transaction"];

describe("the preview is a pure read", () => {
  it("creates no JobRun row, takes no lock, calls no supplier", async () => {
    const h = harness();
    const res = await h.preview();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.preview, true);

    assert.deepEqual(h.rows, [], "no row of any kind exists afterwards");
    const writes = h.calls.filter((c) => WRITE_CALLS.includes(c));
    assert.deepEqual(writes, [], `the preview issued write calls: ${writes.join(", ")}`);
    assert.deepEqual(h.lockCalls, [], "no lock is acquired, renewed or released");
    assert.deepEqual(h.supplierCalls, [], "no account sync, and therefore no supplier request");
    assert.equal(h.rows.filter((r) => r.jobName === ORCHESTRATION_JOB_NAME).length, 0);
    assert.equal(h.rows.filter((r) => r.jobName === UNIT_JOB_NAME).length, 0);
  });

  it("asking twice changes nothing and answers the same", async () => {
    const h = harness();
    const first = await h.preview();
    const second = await h.preview();
    assert.deepEqual(first.body.plan, second.body.plan, "a preview has no side effect to observe");
    assert.deepEqual(h.rows, []);
  });

  it("previewing does not consume or resume the active run an enqueue would", async () => {
    const h = harness();
    await h.preview();
    // A preview must not have created a run that a later enqueue would then "resume".
    const enqueued = await h.enqueue();
    assert.equal(enqueued.body.created, true, "the first real enqueue still creates the run");
  });
});

describe("the preview describes the run /sync/all would create", () => {
  it("its plan matches buildSyncPlan for the same account and timestamp state", async () => {
    const h = harness();
    const expected = await buildSyncPlan({
      kind: "full", fastSync: false, promoteAfter: true, listAccounts, loadAccountState, now: NOW,
    });
    const preview = (await h.preview()).body.plan;

    assert.equal(preview.totalUnits, expected.units.length);
    assert.deepEqual(preview, summarisePlan(expected, { kind: "full", options: { fastSync: false, promoteAfter: true } }));

    // And the same aggregates recomputed independently from the planner's own output.
    const byPlatform = {};
    for (const unit of expected.units) byPlatform[unit.platform] = (byPlatform[unit.platform] ?? 0) + 1;
    assert.deepEqual(preview.byPlatform, byPlatform);
    assert.equal(
      preview.windowedUnits + preview.catalogUnits,
      expected.units.length,
      "every unit is either windowed or a catalog pull",
    );
    assert.equal(preview.windowedUnits, expected.units.filter((u) => u.windowStart && u.windowEnd).length);
  });

  it("the units it describes are exactly the units an enqueue then creates", async () => {
    const h = harness();
    const preview = (await h.preview()).body.plan;
    await h.enqueue();
    const created = h.rows.filter((r) => r.jobName === UNIT_JOB_NAME);

    assert.equal(preview.totalUnits, created.length, "the forecast is the real count");
    const byPlatform = {};
    const byAccount = {};
    const bySourceObject = {};
    for (const row of created) {
      const p = row.payload;
      byPlatform[p.platform] = (byPlatform[p.platform] ?? 0) + 1;
      byAccount[`${p.platform}/${p.accountLabel}`] = (byAccount[`${p.platform}/${p.accountLabel}`] ?? 0) + 1;
      bySourceObject[p.sourceObject] = (bySourceObject[p.sourceObject] ?? 0) + 1;
    }
    assert.deepEqual(preview.byPlatform, byPlatform);
    assert.deepEqual(preview.byAccount, byAccount);
    assert.deepEqual(preview.bySourceObject, bySourceObject);
  });

  it("carries the options it planned with, and honours ?fast=true like /sync/all does", async () => {
    const h = harness();
    const plain = (await h.preview()).body.plan;
    assert.deepEqual(plain.options, { fastSync: false, promoteAfter: true });
    assert.equal(plain.kind, "full");

    const fast = (await h.preview({ fast: "true" })).body.plan;
    assert.deepEqual(fast.options, { fastSync: true, promoteAfter: true });
    const expected = await buildSyncPlan({
      kind: "full", fastSync: true, promoteAfter: true, listAccounts, loadAccountState, now: NOW,
    });
    assert.deepEqual(fast, summarisePlan(expected, { kind: "full", options: { fastSync: true, promoteAfter: true } }));
  });
});

describe("what the preview reports", () => {
  it("counts per platform, per account and per source object", async () => {
    const plan = (await harness().preview()).body.plan;
    assert.equal(plan.byPlatform.optimise_sea, plan.byAccount["optimise_sea/default"] + plan.byAccount["optimise_sea/second"]);
    assert.ok(!("optimise_mena" in plan.byPlatform), "a region with no connected account plans nothing");
    assert.ok(plan.bySourceObject.campaigns > 0 && plan.bySourceObject.conversions > 0);
    assert.equal(
      Object.values(plan.byPlatform).reduce((a, b) => a + b, 0),
      plan.totalUnits,
      "the per-platform counts account for every unit",
    );
    assert.equal(Object.values(plan.byAccount).reduce((a, b) => a + b, 0), plan.totalUnits);
    assert.equal(Object.values(plan.bySourceObject).reduce((a, b) => a + b, 0), plan.totalUnits);
  });

  it("reports the window boundaries of each windowed source", async () => {
    const plan = (await harness().preview()).body.plan;
    const boostiny = plan.windowSpans.find((s) => s.platform === "boostiny" && s.sourceObject === "api_reports");
    assert.ok(boostiny.windows > 1, "a 180-day lookback is many windows");
    assert.equal(boostiny.latest, "2026-09-15", "the span ends today");
    assert.ok(boostiny.earliest < boostiny.latest);
    assert.match(boostiny.earliest, /^\d{4}-\d{2}-\d{2}$/);

    // An account synced two days ago plans one short window instead of the initial lookback.
    const trackier = plan.windowSpans.find((s) => s.platform === "trackier" && s.sourceObject === "conversions");
    assert.equal(trackier.windows, 1);
    assert.equal(trackier.earliest, "2026-09-11");
    assert.equal(trackier.latest, "2026-09-15");

    // Catalog sources never appear here: they carry no window to report.
    assert.ok(!plan.windowSpans.some((s) => s.sourceObject === "campaigns"));
    assert.equal(plan.windowSpans.reduce((sum, s) => sum + s.windows, 0), plan.windowedUnits);
  });

  it("names the deferred Optimise commission groups and says the total may grow", async () => {
    const plan = (await harness().preview()).body.plan;
    assert.equal(plan.totalUnitsMayIncrease, true);
    assert.equal(plan.deferredSourceCount, 3, "one per connected Optimise account");
    assert.equal(plan.deferredSourceCount, plan.deferredSources.length);
    assert.ok(plan.deferredSources.every((d) => d.sourceObject === "commission_groups" && d.after === "campaigns"));
    assert.ok(plan.deferredSources.every((d) => d.platform.startsWith("optimise")));
    assert.deepEqual(plan.exclusions, [], "nothing is excluded from a Phase 5 plan");
    // Deferred work is not counted as a planned unit yet.
    assert.ok(!("commission_groups" in plan.bySourceObject));
  });

  it("an estate with nothing deferred says the total is final", async () => {
    const h = harness();
    const plan = summarisePlan(
      await buildSyncPlan({
        kind: "full", promoteAfter: true, now: NOW,
        listAccounts: async (platform) => (platform === "boostiny" ? ["default"] : []),
        loadAccountState: async () => ({ lastSuccessfulSync: null }),
      }),
      { kind: "full", options: {} },
    );
    assert.equal(plan.deferredSourceCount, 0);
    assert.equal(plan.totalUnitsMayIncrease, false);
    assert.deepEqual(h.rows, []);
  });
});

describe("nothing unsafe leaves through the preview", () => {
  it("the payload carries counts and dates only — no ids, no credentials, no supplier rows", async () => {
    const serialised = JSON.stringify((await harness().preview()).body);
    for (const forbidden of [
      "campaignIds", "campaignId", "apiKey", "api_key", "accessToken", "access_token",
      "refreshToken", "secret", "password", "token", "Bearer", "postgres://", "DATABASE_URL",
      "rawData", "payload", "credentials", "lockKey",
    ]) {
      assert.ok(!serialised.includes(forbidden), `${forbidden} must not appear in a preview`);
    }
    assert.ok(!/https?:\/\//.test(serialised), "no URL of any kind");
    // Only the keys the contract promises.
    const plan = (await harness().preview()).body.plan;
    assert.deepEqual(Object.keys(plan).sort(), [
      "byAccount", "byPlatform", "bySourceObject", "catalogUnits", "deferredSourceCount",
      "deferredSources", "exclusions", "kind", "options", "totalUnits", "totalUnitsMayIncrease",
      "windowSpans", "windowedUnits",
    ]);
  });
});

describe("the summary is safe and order-independent by contract", () => {
  it("window boundaries do not depend on the order units arrive in", () => {
    const unit = (sourceObject, windowStart, windowEnd) => ({
      kind: "network", platform: "boostiny", accountLabel: "default", sourceObject, windowStart, windowEnd,
    });
    const units = [
      unit("api_reports", "2026-03-01", "2026-03-14"),
      unit("api_reports", "2026-01-01", "2026-01-14"),
      unit("api_reports", "2026-02-01", "2026-02-14"),
    ];
    const span = summarisePlan({ units }, {}).windowSpans[0];
    assert.equal(span.earliest, "2026-01-01", "the earliest day, not the first unit's day");
    assert.equal(span.latest, "2026-03-14", "the latest day, not the last unit's day");
    assert.equal(span.windows, 3);
    // Reversing the input cannot change the answer.
    assert.deepEqual(summarisePlan({ units: [...units].reverse() }, {}).windowSpans, [span]);
  });

  it("only the named fields of a deferred source or an exclusion are echoed", () => {
    const summary = summarisePlan(
      {
        units: [],
        deferred: [{
          platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", after: "campaigns",
          campaignIds: ["zzsecretzz"], apiKey: "zzkeyzz",
        }],
        exclusions: [{
          platform: "cj", accountLabel: "default", sourceObject: "products", reason: "zzreasonzz",
          rawPayload: { token: "zztokenzz" },
        }],
      },
      {},
    );
    assert.deepEqual(summary.deferredSources, [
      { platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", after: "campaigns" },
    ]);
    assert.deepEqual(summary.exclusions, [
      { platform: "cj", accountLabel: "default", sourceObject: "products", reason: "zzreasonzz" },
    ]);
    const serialised = JSON.stringify(summary);
    for (const leak of ["zzsecretzz", "zzkeyzz", "zztokenzz", "campaignIds", "apiKey", "rawPayload"]) {
      assert.ok(!serialised.includes(leak), `${leak} must not survive the summary`);
    }
  });
});

describe("the response is never shared-cacheable", () => {
  /** Serves the real route chain on an ephemeral port so the wire headers can be read. */
  async function serve(build) {
    const express = (await import("express")).default;
    const app = express();
    app.use(express.json());
    build(app);
    app.use((error, _req, res, _next) => {
      res.status(error.statusCode ?? error.status ?? 500).json({ ok: false, message: error.message });
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      request: (path) => fetch(`${base}${path}`),
      stop: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it("Cache-Control is no-store on the answer", async () => {
    const { noStoreHeaders } = await import("../src/platform/security/index.js");
    const h = harness();
    const app = await serve((a) =>
      a.get("/sync/plan-preview", noStoreHeaders, (req, res, next) => {
        req.app.locals.syncOrchestration = h.orchestration;
        return previewSyncPlanHandler(req, res, next);
      }),
    );
    try {
      const res = await app.request("/sync/plan-preview");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("pragma"), "no-cache");
      assert.ok(!/public/i.test(res.headers.get("cache-control") ?? ""), "never shared-cacheable");
      assert.equal((await res.json()).preview, true);
    } finally {
      await app.stop();
    }
  });

  it("no-store also covers the 401/403 the guards short-circuit with", async () => {
    const { noStoreHeaders } = await import("../src/platform/security/index.js");
    const refuse = (_req, res) => res.status(403).json({ ok: false, message: "forbidden" });
    const app = await serve((a) => a.get("/sync/plan-preview", noStoreHeaders, refuse, previewSyncPlanHandler));
    try {
      const res = await app.request("/sync/plan-preview");
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("cache-control"), "no-store", "a refusal is account state too");
    } finally {
      await app.stop();
    }
  });

  it("the handler sets no Cache-Control of its own — which is why the route must", async () => {
    const h = harness();
    const app = await serve((a) =>
      a.get("/unguarded", (req, res, next) => {
        req.app.locals.syncOrchestration = h.orchestration;
        return previewSyncPlanHandler(req, res, next);
      }),
    );
    try {
      const res = await app.request("/unguarded");
      assert.equal(res.status, 200);
      // The handler emits NO cache directive. Locally that means an absent header; in production
      // the hosting platform fills the gap with `public, max-age=0, must-revalidate`, which is
      // exactly what /api/sync/plan-preview returned before this fix. The route-level middleware
      // is what closes it — the handler is not the right place, because a 401/403 never reaches it.
      assert.equal(res.headers.get("cache-control"), null);
    } finally {
      await app.stop();
    }
  });
});

describe("source guards", () => {
  it("the route carries the shared no-store middleware, ahead of the auth guards", () => {
    const route = ROUTES_SRC.split('"/sync/plan-preview",')[1].split(");")[0];
    assert.match(route, /noStoreHeaders/, "the existing internal-API cache-control mechanism");
    assert.ok(
      route.indexOf("noStoreHeaders") < route.indexOf("authenticate"),
      "before the guards, so a 401/403 is covered too",
    );
    // The shared middleware is reused, not a second caching mechanism invented for this route.
    assert.match(ROUTES_SRC, /import \{[^}]*noStoreHeaders[^}]*\} from "\.\.\/platform\/security\/index\.js";/s);
    assert.ok(!route.includes("Cache-Control"), "the header is not hand-written into the route");
  });

  it("the route is admin-only, a GET, and registered before the /sync/:platform patterns", () => {
    const route = ROUTES_SRC.split('"/sync/plan-preview",')[1].split(");")[0];
    assert.match(route, /authenticate/);
    assert.match(route, /requireAdminRole/);
    assert.match(route, /requirePermission\(PERMISSIONS\.SYSTEM_READ\)/);
    assert.match(ROUTES_SRC, /router\.get\(\n\s+"\/sync\/plan-preview"/);
    assert.ok(
      ROUTES_SRC.indexOf('"/sync/plan-preview"') < ROUTES_SRC.indexOf('"/sync/:platform"'),
      "otherwise the wildcard would capture it",
    );
    // It is not wired as a trigger: no audit of a state change, because there is no state change.
    assert.ok(!route.includes("auditAction"));
  });

  it("the handler writes nothing and reuses the one planner", () => {
    const handler = CONTROLLER_SRC.split("export async function previewSyncPlanHandler(")[1].split("\n}\n")[0];
    assert.match(handler, /await orchestration\.previewPlan\(/, "the service's own planner");
    assert.match(handler, /summarisePlan\(/);
    for (const forbidden of [
      "createRun", "getOrCreateRun", "claimUnit", "completeUnit", "failUnit", "appendUnits",
      "refreshRun", "withLock", "acquire", "accountSyncFor", "materialiseFollowOnUnits",
    ]) {
      assert.ok(!handler.includes(forbidden), `${forbidden} has no place in a preview`);
    }
  });

  it("previewPlan is the same call createRun makes, and writes nothing", () => {
    const preview = SERVICE_SRC.split("  async previewPlan(")[1].split("\n  }")[0];
    for (const field of ["kind,", "fastSync:", "promoteAfter:", "listAccounts:", "loadAccountState:", "now:"]) {
      assert.ok(preview.includes(field), `previewPlan must pass ${field} like createRun does`);
    }
    for (const forbidden of ["jobRun.create", "jobRun.update", "jobRun.delete", "$transaction", "locks"]) {
      assert.ok(!preview.includes(forbidden), forbidden);
    }
    // There is still exactly one planner: both paths call buildSyncPlan.
    const createRun = SERVICE_SRC.split("  async createRun(")[1].split("\n  }")[0];
    assert.match(createRun, /await buildSyncPlan\(/);
    assert.match(preview, /await buildSyncPlan\(/);
    assert.equal(SERVICE_SRC.split("export async function buildSyncPlan(").length - 1, 1, "one planner, not two");
  });
});
