/**
 * A durable run that contains ONE account's ONE source object.
 *
 * Awin offers cannot be certified any other way. /sync/all plans the whole estate, the manual
 * route correctly refuses an unbounded offers sync, and /sync/worker only advances a unit that
 * already exists — so there was no way to create the first Awin offers page unit at all.
 *
 * What this is NOT is a second scheduler. The unit descriptor comes from the same
 * planAccountUnits the estate plan uses and is filtered, never rebuilt; the run is created,
 * deduped and raced through the same getOrCreateRun; and pages 2..N are appended by the same
 * materialiseFollowOnUnits the Optimise walk uses. Only the first page is planned, because
 * pre-creating 25 units would certify a queue rather than a resumable walk.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getSyncStatusHandler,
  SCOPED_DURABLE_SOURCES,
  triggerScopedDurableSync,
  triggerSyncAll,
  triggerSyncWorker,
} from "../src/controllers/sync.controller.js";
import {
  ORCHESTRATION_JOB_NAME,
  PLANNER_VERSION,
  SyncOrchestrationService,
  UNIT_JOB_NAME,
} from "../src/jobs/syncOrchestration.service.js";
import { AWIN_OFFERS_PAGE_LIMIT, AWIN_OFFERS_PAGES_PER_UNIT } from "../src/jobs/syncSourcePlan.js";

const ROUTES_SRC = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
const NOW = new Date("2026-09-15T00:00:00.000Z");
const now = () => NOW;
const ACCOUNTS = {
  boostiny: ["default"],
  optimise_sea: ["default"],
  optimise_mena: ["default"],
  optimise_uk: [],
  trackier: ["default"],
};
const listAccounts = async (platform) => ACCOUNTS[platform] ?? ["default"];
const loadAccountState = async () => ({ lastSuccessfulSync: null });

function createStore() {
  const rows = [];
  let seq = 0;
  const clone = (r) => JSON.parse(JSON.stringify(r));
  const match = (row, where = {}) => {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "AND") { if (!cond.every((w) => match(row, w))) return false; continue; }
      if (key === "payload") {
        let value = row.payload;
        for (const p of cond.path ?? []) value = value?.[p];
        if ("equals" in cond && value !== cond.equals) return false;
        continue;
      }
      const value = row[key];
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        if ("in" in cond && !cond.in.includes(value)) return false;
        if ("not" in cond && value === cond.not) return false;
        if ("lt" in cond && !(value != null && new Date(value) < new Date(cond.lt))) return false;
        if ("equals" in cond && value !== cond.equals) return false;
      } else if (value !== cond) return false;
    }
    return true;
  };
  const sort = (list, orderBy) => {
    const specs = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...list].sort((a, b) => {
      for (const spec of specs) {
        const [field, dir] = Object.entries(spec)[0];
        const av = a[field] instanceof Date ? a[field].getTime() : a[field];
        const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
        if (av === bv) continue;
        return (av > bv ? 1 : -1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    });
  };
  /** Prisma's atomic `{ increment }` is how a claim counts an attempt; a plain assign would store the operator. */
  const apply = (row, data) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && !(value instanceof Date) && "increment" in value) {
        row[key] = (row[key] ?? 0) + value.increment;
      } else {
        row[key] = value;
      }
    }
  };
  const jobRun = {
    async create({ data }) {
      seq += 1;
      const row = { id: `row-${String(seq).padStart(4, "0")}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(NOW.getTime() + seq), ...data };
      rows.push(row); return clone(row);
    },
    async createMany({ data }) { for (const row of data) await jobRun.create({ data: row }); return { count: data.length }; },
    async update({ where, data }) { const row = rows.find((r) => r.id === where.id); apply(row, data); return clone(row); },
    async updateMany({ where, data }) { let count = 0; for (const row of rows) if (match(row, where)) { apply(row, data); count += 1; } return { count }; },
    async deleteMany({ where }) { let count = 0; for (let i = rows.length - 1; i >= 0; i -= 1) if (match(rows[i], where)) { rows.splice(i, 1); count += 1; } return { count }; },
    async findUnique({ where }) { const row = rows.find((r) => r.id === where.id); return row ? clone(row) : null; },
    async findFirst({ where, orderBy }) { const list = sort(rows.filter((r) => match(r, where)), orderBy); return list.length ? clone(list[0]) : null; },
    async findMany({ where, orderBy }) { return sort(rows.filter((r) => match(r, where ?? {})), orderBy).map(clone); },
  };
  return { rows, prisma: { jobRun, async $transaction(fn) { return fn({ jobRun }); } } };
}

function harness() {
  const { rows, prisma } = createStore();
  const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts, loadAccountState });
  const supplierCalls = [];
  const locals = {
    syncOrchestration: orchestration,
    syncPlatformAccount: async (platform, accountLabel, options) => {
      supplierCalls.push({ platform, accountLabel, options });
      // What a bounded Awin offers unit reports: one page staged, another remaining.
      return {
        [accountLabel ?? "default"]: {
          coupons: AWIN_OFFERS_PAGE_LIMIT,
          campaignPage: {
            index: Math.floor((options?.campaignPageOffset ?? 0) / AWIN_OFFERS_PAGE_LIMIT),
            offset: options?.campaignPageOffset ?? 0,
            nextOffset: (options?.campaignPageOffset ?? 0) + AWIN_OFFERS_PAGE_LIMIT,
            hasMore: true,
            reason: null,
            carry: [...(options?.campaignPageCarry ?? []), "zzdigestzz"],
          },
        },
      };
    },
  };
  const call = async (handler, query = {}, params = {}) => {
    const headers = {};
    const res = {
      statusCode: null, body: null, headers,
      set(name, value) { headers[String(name).toLowerCase()] = value; return this; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; if (this.statusCode === null) this.statusCode = 200; return this; },
    };
    await handler({ query, params, body: {}, app: { locals } }, res, (error) => { throw error; });
    return res;
  };
  const durable = (params = { platform: "awin", accountLabel: "default" }, query = { sourceObject: "offers" }) =>
    call(triggerScopedDurableSync, query, params);
  const enqueueAll = (query = {}) => call(triggerSyncAll, query);
  const worker = () => call(triggerSyncWorker);
  const status = (query = {}) => call(getSyncStatusHandler, query);
  const parents = () => rows.filter((r) => r.jobName === ORCHESTRATION_JOB_NAME);
  const unitsOf = (runId) => rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId);
  return { rows, prisma, orchestration, supplierCalls, durable, enqueueAll, worker, status, parents, unitsOf };
}

/* ============================================================ 1. exactly one unit is planned */

describe("the scoped durable run plans one Awin offers unit and nothing else", () => {
  it("answers 202 with the run, the planner version and a safe plan summary", async () => {
    const h = harness();
    const res = await h.durable();
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.runId);
    assert.equal(res.body.created, true);
    assert.equal(res.body.plannerVersion, PLANNER_VERSION);
    assert.deepEqual(res.body.scope, { platform: "awin", accountLabel: "default", sourceObject: "offers" });
    // Counts only — no supplier payload anywhere in the response.
    const serialized = JSON.stringify(res.body);
    for (const forbidden of ["promotionId", "voucher", "advertiser", "accessToken", "publisherId"]) {
      assert.ok(!serialized.includes(forbidden), `the 202 leaked ${forbidden}`);
    }
  });

  it("creates EXACTLY one unit, and it is awin/default/offers", async () => {
    const h = harness();
    const res = await h.durable();
    const units = h.unitsOf(res.body.runId);
    assert.equal(units.length, 1, `expected one unit, got ${units.length}`);
    const p = units[0].payload;
    assert.equal(p.platform, "awin");
    assert.equal(p.accountLabel, "default");
    assert.equal(p.sourceObject, "offers");
  });

  it("the unit descriptor is the first page, with an empty carry", async () => {
    const h = harness();
    const res = await h.durable();
    const p = h.unitsOf(res.body.runId)[0].payload;
    assert.equal(p.campaignPageIndex, 0);
    assert.equal(p.campaignPageOffset, 0);
    assert.equal(p.campaignPageLimit, AWIN_OFFERS_PAGE_LIMIT);
    assert.equal(p.campaignPageLimit, 200);
    assert.equal(p.campaignPageBudget, AWIN_OFFERS_PAGES_PER_UNIT);
    assert.equal(p.campaignPageBudget, 1);
    assert.equal(p.campaignPageCarry, undefined, "the first page carries prior page digests");
  });

  it("no other platform, account, source object or post-sync unit is enqueued", async () => {
    const h = harness();
    const res = await h.durable();
    const units = h.unitsOf(res.body.runId);
    for (const unit of units) {
      assert.equal(unit.payload.platform, "awin", `${unit.payload.platform} was enqueued`);
      assert.equal(unit.payload.sourceObject, "offers", `${unit.payload.sourceObject} was enqueued`);
      assert.equal(unit.payload.kind, "network", "a non-network unit was enqueued");
    }
    const serialized = JSON.stringify(units.map((u) => u.payload));
    for (const forbidden of ["trackier", "optimise", "impact", "partnerize", "boostiny", "programmes", "transactions", "promotion", "aggregation"]) {
      assert.ok(!serialized.includes(forbidden), `${forbidden} entered the scoped run`);
    }
  });

  it("the run records planner version 7 and promoteAfter false", async () => {
    const h = harness();
    const res = await h.durable();
    const parent = h.parents().find((r) => r.id === res.body.runId);
    assert.equal(parent.payload.plannerVersion, PLANNER_VERSION);
    assert.equal(PLANNER_VERSION, 7);
    assert.equal(parent.payload.options.promoteAfter, false, "a one-source run asked to promote");
    assert.equal(parent.payload.options.fastSync, false);
    assert.equal(parent.payload.options.scopeKey, "awin:default:offers");
  });
});

/* ====================================================== 2. duplicate requests reuse one run */

describe("a second identical request reuses the active run", () => {
  it("returns the same runId and created:false", async () => {
    const h = harness();
    const first = await h.durable();
    const second = await h.durable();
    assert.equal(second.statusCode, 202);
    assert.equal(second.body.runId, first.body.runId, "a second Awin walk was created");
    assert.equal(second.body.created, false);
    assert.equal(h.parents().length, 1, "two competing parents exist");
    assert.equal(h.unitsOf(first.body.runId).length, 1, "the reuse re-planned the first page");
  });

  it("three concurrent requests converge on one run", async () => {
    const h = harness();
    const results = await Promise.all([h.durable(), h.durable(), h.durable()]);
    const ids = new Set(results.map((r) => r.body.runId));
    assert.equal(ids.size, 1, "racers created competing Awin walks");
    const active = h.parents().filter((r) => ["PENDING", "RUNNING"].includes(r.status));
    assert.equal(active.length, 1);
  });

  it("a different account never adopts this account's run", async () => {
    const h = harness();
    const a = await h.durable({ platform: "awin", accountLabel: "default" });
    const b = await h.durable({ platform: "awin", accountLabel: "uk" });
    // It is not a reuse. The estate runs ONE orchestration parent at a time, so a second scoped
    // run is refused as incompatible and told which run blocks it — rather than silently
    // adopting a walk over a different account, which is the failure that matters here.
    assert.notEqual(b.body.runId, a.body.runId, "another account adopted this account's run");
    assert.equal(b.statusCode, 409);
    assert.equal(b.body.code, "active_run_incompatible");
    assert.equal(b.body.activeRunId, a.body.runId, "the refusal did not name the blocking run");
    assert.equal(h.parents().filter((r) => ["PENDING", "RUNNING"].includes(r.status)).length, 1);
  });
});

/* ========================================== 3. continuation comes from the existing path */

describe("the worker advances page 0 and the existing planner appends page 1", () => {
  it("executes the first page and appends exactly one successor", async () => {
    const h = harness();
    const res = await h.durable();
    const runId = res.body.runId;

    const worked = await h.worker();
    assert.equal(worked.statusCode, 200, JSON.stringify(worked.body));
    // The supplier call carried this unit's own slice.
    assert.equal(h.supplierCalls.length, 1);
    assert.equal(h.supplierCalls[0].platform, "awin");
    assert.equal(h.supplierCalls[0].options.sourceObject, "offers");
    assert.equal(h.supplierCalls[0].options.campaignPageOffset, 0);
    assert.equal(h.supplierCalls[0].options.campaignPageLimit, 200);

    const units = h.unitsOf(runId);
    assert.equal(units.length, 2, `expected page 0 plus one successor, got ${units.length}`);
    const next = units.find((u) => u.payload.campaignPageOffset === 200);
    assert.ok(next, "page 1 was not appended");
    assert.equal(next.payload.campaignPageIndex, 1);
    assert.equal(next.payload.campaignPageLimit, 200);
    assert.equal(next.payload.campaignPageBudget, 1);
    assert.deepEqual(next.payload.campaignPageCarry, ["zzdigestzz"], "the carry did not travel");
    assert.equal(next.payload.sourceObject, "offers");
  });

  it("only ONE successor is appended per completed page", async () => {
    const h = harness();
    const res = await h.durable();
    await h.worker();
    await h.worker();
    const offsets = h.unitsOf(res.body.runId).map((u) => u.payload.campaignPageOffset).sort((a, b) => a - b);
    assert.deepEqual(offsets, [0, 200, 400], "the walk pre-created or skipped pages");
  });

  it("no post-sync unit is ever created by this run", async () => {
    const h = harness();
    const res = await h.durable();
    await h.worker();
    await h.worker();
    for (const unit of h.unitsOf(res.body.runId)) {
      assert.equal(unit.payload.kind, "network", `a ${unit.payload.kind} unit appeared`);
    }
  });
});

/* ================================================== 4. the guard rails around the route */

describe("the route refuses what it is not for", () => {
  it("an unsupported platform is refused", async () => {
    const h = harness();
    const res = await h.durable({ platform: "trackier", accountLabel: "default" }, { sourceObject: "coupons" });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "scoped_durable_platform_unsupported");
    assert.equal(h.parents().length, 0, "a refused request still created a run");
  });

  it("an unsupported Awin source object is refused", async () => {
    const h = harness();
    for (const sourceObject of ["programmes", "transactions"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await h.durable({ platform: "awin", accountLabel: "default" }, { sourceObject });
      assert.equal(res.statusCode, 400, sourceObject);
      assert.equal(res.body.code, "scoped_durable_source_unsupported");
    }
    assert.equal(h.parents().length, 0);
  });

  it("a missing sourceObject is refused", async () => {
    const h = harness();
    const res = await h.durable({ platform: "awin", accountLabel: "default" }, {});
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "scoped_durable_source_required");
  });

  it("the allow-list is exactly Awin offers — not a free parameter", () => {
    assert.deepEqual(Object.keys(SCOPED_DURABLE_SOURCES), ["awin"]);
    assert.deepEqual([...SCOPED_DURABLE_SOURCES.awin], ["offers"]);
    assert.ok(Object.isFrozen(SCOPED_DURABLE_SOURCES));
  });

  it("the route is admin-only on top of SYNC_TRIGGER, and registered before the dynamic patterns", () => {
    const at = ROUTES_SRC.indexOf('"/sync/:platform/:accountLabel/durable"');
    const dynamicAccount = ROUTES_SRC.indexOf('"/sync/:platform/:accountLabel"');
    const dynamicPlatform = ROUTES_SRC.indexOf('"/sync/:platform"');
    assert.ok(at > 0, "the durable route is not registered");
    assert.ok(at < dynamicAccount, "the dynamic two-segment route would capture it");
    assert.ok(at < dynamicPlatform);
    const block = ROUTES_SRC.slice(at, ROUTES_SRC.indexOf(");", at));
    assert.match(block, /authenticate,/);
    assert.match(block, /requireAdminRole,/);
    assert.match(block, /requirePermission\(PERMISSIONS\.SYNC_TRIGGER\),/);
    assert.match(block, /auditAction\(/);
  });
});

/* ===================================================== 5. nothing else moved */

describe("existing entrypoints are unchanged", () => {
  it("/sync/all still plans the whole estate", async () => {
    const h = harness();
    const res = await h.enqueueAll();
    assert.equal(res.statusCode, 202);
    const platforms = new Set(h.unitsOf(res.body.runId).map((u) => u.payload.platform));
    assert.ok(platforms.size > 1, "the estate plan collapsed to one platform");
    assert.ok(platforms.has("trackier"), "trackier left the estate plan");
    const parent = h.parents().find((r) => r.id === res.body.runId);
    assert.equal(parent.payload.options.promoteAfter, true, "/sync/all stopped asking to promote");
    assert.equal(parent.payload.options.scopeKey, undefined, "/sync/all gained a scope");
  });

  it("an estate run does NOT adopt an active scoped run, and vice versa", async () => {
    const h = harness();
    const scoped = await h.durable();
    const all = await h.enqueueAll();
    assert.notEqual(all.body?.runId, scoped.body.runId, "/sync/all adopted the Awin-only run");

    const h2 = harness();
    const estate = await h2.enqueueAll();
    const narrow = await h2.durable();
    assert.notEqual(narrow.body.runId, estate.body.runId, "the scoped request adopted the estate run");
  });

  it("no schema change rides along", () => {
    const service = readFileSync(new URL("../src/jobs/syncOrchestration.service.js", import.meta.url), "utf8");
    for (const forbidden of ["ALTER TABLE", "CREATE TABLE", "prisma.$executeRaw", "migrate"]) {
      assert.ok(!service.includes(forbidden), forbidden);
    }
  });
});
