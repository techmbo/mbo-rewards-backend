/**
 * Phase 20 — the one entrypoint the durable Awin backfill was missing.
 *
 * Every mechanism to derive Awin parents from already-staged offers exists: the bounded
 * materialization unit, its continuations, the stage barrier and the planner's support for a run
 * seeded with explicit units. There was simply no way to START one. /sync/all plans the whole
 * estate and would refetch; /sync/worker only advances a unit that already exists; and
 * /api/promotion/run is the unbounded drain this work exists to replace.
 *
 * What this route is NOT is a second orchestrator. It creates exactly one unit through the same
 * getOrCreateRun every other durable entrypoint uses, and then gets out of the way.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AWIN_BACKFILL_SCOPE_KEY,
  getSyncStatusHandler,
  triggerAwinStagedOfferBackfill,
  triggerSyncAll,
  triggerSyncWorker,
} from "../src/controllers/sync.controller.js";
import {
  ORCHESTRATION_JOB_NAME,
  PLANNER_VERSION,
  SyncOrchestrationService,
  UNIT_JOB_NAME,
  UNIT_KINDS,
} from "../src/jobs/syncOrchestration.service.js";
import { AWIN_MATERIALIZATION_PAGE_SIZE } from "../src/jobs/awinParentMaterializationUnit.js";

const ROUTES_SRC = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
const CONTROLLER_SRC = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");
const NOW = new Date("2026-09-21T00:00:00.000Z");
const now = () => NOW;
const listAccounts = async () => ["default"];
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
        if ("gte" in cond && !(value != null && new Date(value) >= new Date(cond.gte))) return false;
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
      const row = {
        id: `row-${String(seq).padStart(4, "0")}`, status: "PENDING", priority: 100, attempt: 0,
        maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null,
        correlationId: null, startedAt: null, completedAt: null,
        createdAt: new Date(NOW.getTime() + seq), ...data,
      };
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

function harness({ pageImpl } = {}) {
  const { rows, prisma } = createStore();
  const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts, loadAccountState });
  const supplierCalls = [];
  const materializationCalls = [];
  const locals = {
    syncOrchestration: orchestration,
    // Any supplier contact at all would have to come through here.
    syncPlatformAccount: async (platform, accountLabel, options) => {
      supplierCalls.push({ platform, accountLabel, options });
      return { [accountLabel ?? "default"]: { campaigns: 1 } };
    },
    awinParentMaterializationPage: async (input) => {
      materializationCalls.push(input);
      if (pageImpl) return pageImpl(input, materializationCalls.length);
      return {
        offersScanned: 3, advertisersFound: 2, parentsStaged: 2,
        skippedProgrammeBacked: 0, offersWithoutAdvertiser: 0,
        lastCursor: "e-00002", hasMore: false,
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
  return {
    rows, prisma, orchestration, supplierCalls, materializationCalls,
    backfill: () => call(triggerAwinStagedOfferBackfill),
    enqueueAll: (query = {}) => call(triggerSyncAll, query),
    worker: () => call(triggerSyncWorker),
    status: (query = {}) => call(getSyncStatusHandler, query),
    parents: () => rows.filter((r) => r.jobName === ORCHESTRATION_JOB_NAME),
    unitsOf: (runId) => rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId),
  };
}

describe("Phase 20 — the backfill route seeds exactly one materialization unit", () => {
  it("answers 202 with the run and a safe plan summary", async () => {
    const h = harness();
    const res = await h.backfill();

    assert.equal(res.statusCode, 202);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.runId);
    assert.equal(res.body.created, true);
    assert.equal(res.body.reused, false);
    assert.equal(res.body.plannerVersion, PLANNER_VERSION);
    assert.deepEqual(res.body.scope, { networkSource: "awin", scopeKey: AWIN_BACKFILL_SCOPE_KEY });
    assert.match(res.body.message, /No supplier fetch was started/);
    assert.ok(res.body.syncStatus, "the current durable status is reported");
    assert.deepEqual(res.body.plan, {
      initialUnits: 1,
      unitKind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION,
      networkUnits: 0,
      supplierFetch: false,
      pageSize: AWIN_MATERIALIZATION_PAGE_SIZE,
    });

    const serialized = JSON.stringify(res.body);
    for (const leak of ["promotionId", "voucher", "advertiser", "accessToken", "publisherId", "apiKey"]) {
      assert.ok(!serialized.includes(leak), `the 202 leaked ${leak}`);
    }
  });

  it("creates EXACTLY one unit, and it is the Awin materialization first page", async () => {
    const h = harness();
    const res = await h.backfill();
    const units = h.unitsOf(res.body.runId);

    assert.equal(units.length, 1, "exactly one initial unit");
    assert.equal(units[0].payload.kind, UNIT_KINDS.AWIN_PARENT_MATERIALIZATION);
    assert.equal(units[0].payload.networkSource, "awin");
    assert.equal(units[0].payload.cursorId, null, "a first page starts the walk");
    assert.equal(units[0].payload.pageSize, AWIN_MATERIALIZATION_PAGE_SIZE);
    assert.equal(units[0].status, "PENDING");
  });

  it("plans ZERO network units, so nothing can refetch", async () => {
    const h = harness();
    const res = await h.backfill();
    const units = h.unitsOf(res.body.runId);

    assert.equal(units.filter((u) => u.payload.kind === UNIT_KINDS.NETWORK).length, 0);
    for (const unit of units) {
      assert.equal(unit.payload.platform, undefined, "a network unit would carry a platform");
      assert.equal(unit.payload.sourceObject, undefined, "a network unit would carry a sourceObject");
    }
  });

  it("contacts no supplier — creating the run, and advancing it, call nothing", async () => {
    const h = harness();
    const res = await h.backfill();
    assert.deepEqual(h.supplierCalls, [], "the route itself fetched from a supplier");

    await h.worker();
    assert.deepEqual(h.supplierCalls, [], "advancing the run fetched from a supplier");
    assert.equal(h.materializationCalls.length, 1, "the worker ran the materialization page");
    assert.equal(res.body.plan.supplierFetch, false);
  });

  it("records promoteAfter, so the barrier and the promotion walks actually follow", async () => {
    const h = harness();
    const res = await h.backfill();
    const parent = h.parents().find((p) => p.id === res.body.runId);

    assert.equal(parent.payload.options.promoteAfter, true);
    assert.equal(parent.payload.options.fastSync, false);
    assert.equal(parent.payload.options.scopeKey, AWIN_BACKFILL_SCOPE_KEY);
  });
});

describe("Phase 20 — reuse safety", () => {
  it("a duplicate request reuses the active run instead of creating a second", async () => {
    const h = harness();
    const first = await h.backfill();
    const second = await h.backfill();

    assert.equal(second.statusCode, 202);
    assert.equal(second.body.runId, first.body.runId, "a second run was created");
    assert.equal(second.body.created, false);
    assert.equal(second.body.reused, true);
    assert.match(second.body.message, /already active/);
    assert.match(second.body.message, /No supplier fetch was started/);

    assert.equal(h.parents().length, 1, "exactly one orchestration parent");
    assert.equal(h.unitsOf(first.body.runId).length, 1, "the reused run did not gain a second first page");
  });

  it("an estate run is neither adopted by the backfill nor adopts it", async () => {
    const h = harness();
    const estate = await h.enqueueAll();
    assert.equal(estate.statusCode, 202);

    const backfill = await h.backfill();
    // The estate run carries no scopeKey, so it can never satisfy this request. Either the
    // backfill gets its own run, or creation is refused outright — never a silent adoption.
    if (backfill.statusCode === 202) {
      assert.notEqual(backfill.body.runId, estate.body.runId, "the backfill adopted the estate run");
      const parent = h.parents().find((p) => p.id === backfill.body.runId);
      assert.equal(parent.payload.options.scopeKey, AWIN_BACKFILL_SCOPE_KEY);
    } else {
      assert.equal(backfill.statusCode, 409);
      assert.equal(backfill.body.code, "active_run_incompatible");
    }
  });

  it("refuses with active_run_incompatible rather than creating a second parent", async () => {
    const h = harness();
    // A blocker the orchestration itself reports; the route must surface it as a clean 409.
    h.orchestration.getOrCreateRun = async () => {
      const error = new Error("An active sync run is incompatible with this request.");
      error.code = "active_run_incompatible";
      error.statusCode = 409;
      error.activeRunId = "row-0001";
      throw error;
    };

    const res = await h.backfill();
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, "active_run_incompatible");
    assert.equal(res.body.activeRunId, "row-0001");
    assert.match(res.body.message, /cancel it explicitly/);
    assert.equal(h.parents().length, 0, "the refusal created nothing");
  });
});

describe("Phase 20 — the worker takes over from there", () => {
  it("advances the run one unit, and the continuation is the orchestration's, not the route's", async () => {
    // A full first page, then a short second: the walk continues itself exactly once.
    const h = harness({
      pageImpl: (_input, call) =>
        call === 1
          ? {
              offersScanned: AWIN_MATERIALIZATION_PAGE_SIZE, advertisersFound: 5, parentsStaged: 5,
              skippedProgrammeBacked: 0, offersWithoutAdvertiser: 0,
              lastCursor: "e-00199", hasMore: true,
            }
          : {
              offersScanned: 2, advertisersFound: 1, parentsStaged: 1,
              skippedProgrammeBacked: 0, offersWithoutAdvertiser: 0,
              lastCursor: "e-00201", hasMore: false,
            },
    });

    const res = await h.backfill();
    const runId = res.body.runId;

    const first = await h.worker();
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.status, "unit_completed");

    const afterFirst = h.unitsOf(runId);
    assert.equal(afterFirst.length, 2, "one continuation appended");
    const continuation = afterFirst.find((u) => u.payload.cursorId === "e-00199");
    assert.ok(continuation, "the continuation carries the page's last id");
    assert.equal(continuation.payload.kind, UNIT_KINDS.AWIN_PARENT_MATERIALIZATION);
    assert.equal(continuation.payload.pageSize, AWIN_MATERIALIZATION_PAGE_SIZE);

    const second = await h.worker();
    assert.equal(second.body.status, "unit_completed");
    assert.equal(
      h.unitsOf(runId).filter((u) => u.payload.kind === UNIT_KINDS.AWIN_PARENT_MATERIALIZATION).length,
      2,
      "a short page appended no further continuation",
    );
    assert.deepEqual(h.supplierCalls, [], "no supplier was contacted at any point");
  });

  it("the stored unit outcome is counts only — never the cursor", async () => {
    const h = harness();
    const res = await h.backfill();
    await h.worker();

    const unit = h.unitsOf(res.body.runId)[0];
    // completeUnit nests the summariser's output under result.outcome.
    const outcome = unit.result?.outcome ?? {};
    const serialized = JSON.stringify(unit.result ?? {});
    assert.ok(!serialized.includes("e-00002"), "the cursor reached the stored outcome");
    assert.equal(outcome.kind, "awin-parent-materialization");
    assert.equal(outcome.counts.parentsStaged, 2);
    assert.equal(outcome.counts.offersScanned, 3);
    assert.equal(outcome.pageSize, AWIN_MATERIALIZATION_PAGE_SIZE);
  });
});

describe("Phase 20 — the route is admin-only and correctly ordered", () => {
  it("carries the same auth chain as the other durable-run entrypoints", () => {
    const at = ROUTES_SRC.indexOf('"/sync/awin/backfill-staged-offers"');
    assert.ok(at > 0, "the route is not registered");
    const block = ROUTES_SRC.slice(at, ROUTES_SRC.indexOf(");", at));
    assert.match(block, /authenticate,/);
    assert.match(block, /requireAdminRole,/);
    assert.match(block, /requirePermission\(PERMISSIONS\.SYNC_TRIGGER\),/);
    assert.match(block, /auditAction\(/);
    assert.match(block, /noStoreHeaders,/);
    assert.match(block, /triggerAwinStagedOfferBackfill,/);
  });

  it("is registered BEFORE the dynamic patterns that would capture it", () => {
    const at = ROUTES_SRC.indexOf('"/sync/awin/backfill-staged-offers"');
    const dynamicAccount = ROUTES_SRC.indexOf('"/sync/:platform/:accountLabel"');
    const dynamicPlatform = ROUTES_SRC.indexOf('"/sync/:platform"');
    // Without this it would be matched as platform=awin, accountLabel=backfill-staged-offers.
    assert.ok(at < dynamicAccount, "captured by /sync/:platform/:accountLabel");
    assert.ok(at < dynamicPlatform, "captured by /sync/:platform");
  });

  it("the controller writes no JobRun of its own and reaches no supplier", () => {
    const body = CONTROLLER_SRC.split("export async function triggerAwinStagedOfferBackfill(")[1]
      .split("\nexport async function ")[0];
    for (const forbidden of ["jobRun.", "prisma.", "createMany", "adapter", "fetch(", "axios"]) {
      assert.ok(!body.includes(forbidden), `the controller reaches ${forbidden}`);
    }
    assert.ok(body.includes("getOrCreateRun("), "the run must come from the orchestration service");
    assert.ok(!body.includes("while ("), "the controller loops");
    assert.ok(!body.includes("createRun("), "use getOrCreateRun so a duplicate request reuses");
  });
});

describe("Phase 20 — nothing else moved", () => {
  it("/sync/all still plans the whole estate with network units", async () => {
    const h = harness();
    const res = await h.enqueueAll();
    assert.equal(res.statusCode, 202);
    const units = h.unitsOf(res.body.runId);
    assert.ok(units.length > 0);
    assert.ok(
      units.some((u) => u.payload.kind === UNIT_KINDS.NETWORK),
      "the estate run must still plan network units",
    );
  });

  it("Trackier's route registrations are untouched", () => {
    // The backfill is Awin-only by construction: no other network has a route or a scopeKey here.
    assert.ok(!ROUTES_SRC.includes("/sync/trackier/backfill"));
    assert.equal(AWIN_BACKFILL_SCOPE_KEY, "awin-staged-offers-backfill");
    const at = ROUTES_SRC.indexOf('"/sync/awin/backfill-staged-offers"');
    const block = ROUTES_SRC.slice(at, ROUTES_SRC.indexOf(");", at));
    assert.ok(!block.includes("trackier"));
  });
});
