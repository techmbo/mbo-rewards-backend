/**
 * Phase 2 — POST /sync/all is durable ENQUEUE/RESUME only.
 *
 * The route used to launch syncAll through the fire-and-forget launcher, which does not survive
 * the HTTP response on serverless hosting. It now creates (or resumes) a durable orchestration
 * run and answers 202 with the run id and the DURABLE status projection. It executes no network
 * sync, no promotion, and starts no promise, timer or background task: the units are worked later,
 * one bounded unit per invocation, by the worker (phase 3).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { triggerSyncAll } from "../src/controllers/sync.controller.js";
import {
  buildSyncPlan,
  ORCHESTRATION_JOB_NAME,
  UNIT_JOB_NAME,
  UNIT_KINDS,
  SyncOrchestrationService,
} from "../src/jobs/syncOrchestration.service.js";

const CONTROLLER_SRC = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");
const ROUTES_SRC = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
const handlerOf = (name) => CONTROLLER_SRC.split(`export async function ${name}`)[1].split("\nexport ")[0];

/** Minimal JobRun store honouring the where-shapes the orchestration service uses. */
function createFakePrisma() {
  const rows = [];
  const ops = [];
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
        if ("gte" in cond && !(value != null && new Date(value) >= new Date(cond.gte))) return false;
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
  const jobRun = {
    async create({ data }) {
      ops.push("create");
      seq += 1;
      const row = { id: `job-${String(seq).padStart(3, "0")}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(Date.now() + seq), ...data };
      rows.push(row);
      return clone(row);
    },
    async update({ where, data }) { ops.push("update"); const row = rows.find((r) => r.id === where.id); Object.assign(row, data); return clone(row); },
    async updateMany({ where, data }) { ops.push("updateMany"); let count = 0; for (const row of rows) if (match(row, where)) { Object.assign(row, data); count += 1; } return { count }; },
    async findUnique({ where }) { const row = rows.find((r) => r.id === where.id); return row ? clone(row) : null; },
    async findFirst({ where, orderBy }) { const list = sort(rows.filter((r) => match(r, where)), orderBy); return list.length ? clone(list[0]) : null; },
    async findMany({ where, orderBy }) { return sort(rows.filter((r) => match(r, where ?? {})), orderBy).map(clone); },
  };
  return { rows, ops, prisma: { jobRun, async $transaction(fn) { ops.push("$transaction"); return fn({ jobRun }); } } };
}

const ACCOUNTS = { boostiny: ["default"], optimise_sea: ["default"], optimise_mena: [], optimise_uk: [], trackier: ["default"] };
const listAccounts = async (platform) => ACCOUNTS[platform] ?? ["default"];
// Phase 5 units are platform + account + source object [+ window], so the expected count comes
// from the planner itself rather than from a number that window tuning would invalidate.
const loadAccountState = async () => ({ lastSuccessfulSync: null });
const NOW = new Date("2026-09-15T12:00:00.000Z");
const now = () => NOW;
const plannedUnits = async (options = {}) =>
  (await buildSyncPlan({ kind: "full", promoteAfter: true, listAccounts, loadAccountState, now: NOW, ...options })).units.length;

function harness() {
  const { rows, ops, prisma } = createFakePrisma();
  const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts, loadAccountState });
  const call = async (query = {}) => {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    await triggerSyncAll({ query, app: { locals: { syncOrchestration: orchestration } } }, res, (error) => { throw error; });
    return res;
  };
  const parents = () => rows.filter((r) => r.jobName === ORCHESTRATION_JOB_NAME);
  const unitsOf = (runId) => rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId);
  return { rows, ops, prisma, orchestration, call, parents, unitsOf };
}

describe("POST /sync/all — durable enqueue", () => {
  it("returns 202 with the durable run id and projection, and creates exactly one parent run with its network units", async () => {
    const h = harness();
    const res = await h.call({});

    assert.equal(res.statusCode, 202);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.created, true);
    assert.equal(typeof res.body.runId, "string");
    assert.equal(typeof res.body.message, "string");

    assert.equal(h.parents().length, 1, "exactly one parent run");
    const parent = h.parents()[0];
    assert.equal(parent.id, res.body.runId);
    assert.equal(parent.status, "RUNNING");
    assert.equal(parent.payload.kind, "full");
    assert.equal(parent.payload.trigger, "api");
    // 2 — a full sync still requests post-sync promotion; it is recorded, and deferred until
    // bounded units exist (phase 5), so the run cannot report success prematurely.
    assert.equal(parent.payload.options.promoteAfter, true);
    assert.equal(parent.payload.options.fastSync, false);
    assert.equal(parent.payload.postSyncStages, "deferred");

    const units = h.unitsOf(parent.id);
    const EXPECTED_UNITS = await plannedUnits();
    assert.equal(units.length, EXPECTED_UNITS);
    assert.ok(units.every((u) => u.payload.kind === UNIT_KINDS.NETWORK && u.status === "PENDING"));
    assert.ok(units.every((u) => u.payload.options.promoteAfter === false), "a unit never runs the global stages");

    // 7 — the status is the DURABLE projection, not the in-memory activeSync.
    assert.equal(res.body.syncStatus.runId, parent.id);
    assert.equal(res.body.syncStatus.totalUnits, EXPECTED_UNITS);
    assert.equal(res.body.syncStatus.completedUnits, 0);
    assert.equal(res.body.syncStatus.postSyncPending, true);
    assert.equal(res.body.syncStatus.percentComplete, null, "overall total is not knowable yet");
    assert.equal(res.body.syncStatus.unitsPercentComplete, 0);
    assert.equal(res.body.status, res.body.syncStatus.status);
    assert.equal(res.body.status, "running");
  });

  it("parses ?fast exactly as before and records it on the run", async () => {
    for (const [query, expected] of [[{}, false], [{ fast: "true" }, true], [{ fast: "1" }, true], [{ fast: "yes" }, true], [{ fast: "false" }, false], [{ fast: "zznonsensezz" }, false]]) {
      const h = harness();
      const res = await h.call(query);
      assert.equal(h.parents()[0].payload.options.fastSync, expected, JSON.stringify(query));
      assert.equal(res.body.syncStatus.options.fastSync, expected);
    }
  });

  it("a repeated COMPATIBLE request resumes the same run instead of creating a second one", async () => {
    const h = harness();
    const first = await h.call({});
    const second = await h.call({});
    assert.equal(second.statusCode, 202);
    assert.equal(second.body.runId, first.body.runId);
    assert.equal(second.body.created, false, "reused, not created");
    assert.match(second.body.message, /already/i);
    assert.equal(h.parents().length, 1, "no duplicate parent");
    assert.equal(h.unitsOf(first.body.runId).length, await plannedUnits(), "no duplicate units");
  });

  it("an active FOREIGN-planner run does not block a current run, and is surfaced rather than silent", async () => {
    const h = harness();
    // A legacy parent, mid-flight, from a planner generation this code does not speak.
    h.rows.push({
      id: "legacy-1", jobName: ORCHESTRATION_JOB_NAME, status: "RUNNING", priority: 100, attempt: 0,
      maxAttempts: 1, correlationId: "legacy-1", startedAt: new Date("2026-09-01T00:00:00.000Z"),
      completedAt: null, createdAt: new Date("2026-09-01T00:00:00.000Z"),
      payload: { kind: "full", trigger: "api", plannerVersion: 3, options: { fastSync: false, promoteAfter: true } },
      result: null, lastError: null, progress: 0,
    });
    const before = JSON.stringify(h.rows.find((r) => r.id === "legacy-1"));

    const res = await h.call({});

    // Phase 8C deliberately does NOT block on a foreign run: the planner-version design allows a
    // current run beside a legacy one, and cancelling a foreign run is refused, so blocking would
    // leave the estate unable to sync with no way out.
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.created, true, "the current-planner run was created");
    assert.notEqual(res.body.runId, "legacy-1");
    // …but it is never silent.
    assert.deepEqual(res.body.foreignPlannerRunActive, { runId: "legacy-1", plannerVersion: 3 });
    // …and the foreign run is not touched in any way.
    assert.equal(JSON.stringify(h.rows.find((r) => r.id === "legacy-1")), before, "byte-for-byte unchanged");
  });

  it("with no foreign run active the field is absent, not a null", async () => {
    const h = harness();
    const res = await h.call({});
    assert.equal(res.statusCode, 202);
    assert.ok(!("foreignPlannerRunActive" in res.body), "no noise on the ordinary path");
  });

  it("a fast request folds into an active non-fast run, and says so truthfully", async () => {
    const h = harness();
    const normal = await h.call({});
    const fast = await h.call({ fast: "true" });
    assert.equal(fast.body.created, false, "the broader run already does this work");
    assert.equal(fast.body.runId, normal.body.runId);
    assert.equal(fast.body.reusedBroaderRun, true, "the caller is told it got more than it asked for");
    assert.match(fast.body.message, /broader non-fast run/i);
    assert.equal(h.parents().length, 1, "no second parent");
    // A plain resume of the same breadth is a resume, not a broader-run substitution.
    const again = await h.call({});
    assert.equal(again.body.runId, normal.body.runId);
    assert.equal(again.body.created, false);
    assert.equal(again.body.reusedBroaderRun, false);
  });

  it("the reverse is REFUSED: a non-fast request beside an active fast run gets 409, not a second parent", async () => {
    // Phase 8C closes the gap 8B left open. A fast run cannot satisfy a non-fast request, and
    // creating a second parent duplicates supplier work and makes status ambiguous — so the
    // request is refused and the operator decides: wait, or cancel the active run explicitly.
    const h = harness();
    const fast = await h.call({ fast: "true" });
    const refused = await h.call({});
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.body.ok, false);
    assert.equal(refused.body.code, "active_run_incompatible");
    assert.equal(refused.body.activeRunId, fast.body.runId, "the caller is told WHICH run blocks it");
    assert.equal(h.parents().length, 1, "no second parent was created");
    // Nothing was cancelled or relabelled on the operator's behalf.
    const parent = h.rows.find((r) => r.id === fast.body.runId);
    assert.equal(parent.status, "RUNNING");
    assert.equal(parent.payload.options.fastSync, true, "the active run was not upgraded");
  });

  it("creates the parent and units transactionally, through the phase 1 service", async () => {
    const h = harness();
    await h.call({});
    assert.equal(h.ops[0], "$transaction", "the transaction opens before any row is written");
    assert.equal(h.ops.filter((o) => o === "$transaction").length, 1);
    // A resume writes nothing at all.
    const before = h.ops.length;
    await h.call({});
    assert.deepEqual(h.ops.slice(before).filter((o) => o !== "findFirst"), [], "resume performs no writes");
  });

  it("executes no sync work: every row written is an orchestration row, and no unit is claimed", async () => {
    const h = harness();
    await h.call({});
    assert.ok(h.rows.every((r) => [ORCHESTRATION_JOB_NAME, UNIT_JOB_NAME].includes(r.jobName)));
    assert.equal(h.rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.status !== "PENDING").length, 0, "nothing was executed");
    assert.equal(h.rows.filter((r) => r.startedAt && r.jobName === UNIT_JOB_NAME).length, 0);
  });

  it("surfaces a failure through next() rather than a half-written response", async () => {
    const broken = { getOrCreateRun: async () => { throw new Error("zzdb downzz"); } };
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    let forwarded = null;
    await triggerSyncAll({ query: {}, app: { locals: { syncOrchestration: broken } } }, res, (error) => { forwarded = error; });
    assert.ok(forwarded instanceof Error);
    assert.equal(res.statusCode, null);
  });
});

describe("service — run reuse requires compatible execution options", () => {
  const serviceFor = (prisma) => new SyncOrchestrationService({ prisma, now, listAccounts, loadAccountState });

  it("findActiveRun is breadth-aware on fastSync and exact on everything else", async () => {
    const { prisma } = createFakePrisma();
    const service = serviceFor(prisma);
    const base = await service.createRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: true } });

    assert.equal((await service.findActiveRun({ kind: "full", options: { fastSync: false, promoteAfter: true } }))?.id, base.id);
    // A non-fast run does everything a fast run would and more, so it satisfies a fast request.
    assert.equal(
      (await service.findActiveRun({ kind: "full", options: { fastSync: true, promoteAfter: true } }))?.id,
      base.id,
      "a fast request is satisfied by the broader non-fast run",
    );
    // promoteAfter is never relaxed: it changes what the work IS.
    assert.equal(await service.findActiveRun({ kind: "full", options: { fastSync: false, promoteAfter: false } }), null, "promoteAfter differs");
    // kind no longer changes what a run plans, so it no longer decides reuse.
    assert.equal(
      (await service.findActiveRun({ kind: "incremental", options: { fastSync: false, promoteAfter: true } }))?.id,
      base.id,
      "kind is not a reuse dimension any more",
    );
    assert.equal((await service.findActiveRun({}))?.id, base.id, "no filter still finds the active run");
  });

  it("the parent payload records the same fastSync its own units carry", async () => {
    // buildSyncPlan used to coerce fastSync true when kind was "incremental" while createRun kept
    // recording the caller's raw value, so the run advertised one breadth and executed another.
    // That made the reuse key and /sync/status both lie. Every combination must now agree.
    for (const [kind, options, expected] of [
      ["full", { fastSync: false, promoteAfter: true }, false],
      ["full", { fastSync: true, promoteAfter: true }, true],
      ["incremental", { promoteAfter: true }, false],
      ["incremental", { fastSync: true, promoteAfter: true }, true],
    ]) {
      const { prisma, rows } = createFakePrisma();
      // eslint-disable-next-line no-await-in-loop
      const run = await serviceFor(prisma).createRun({ kind, trigger: "api", options });
      const parent = rows.find((r) => r.id === run.id);
      assert.equal(parent.payload.options.fastSync, expected, `parent payload for ${kind}`);
      const units = rows.filter((r) => r.correlationId === run.id && r.payload?.kind === UNIT_KINDS.NETWORK);
      assert.ok(units.length > 0, "the plan produced network units");
      const carried = [...new Set(units.map((u) => u.payload.options.fastSync))];
      assert.deepEqual(carried, [expected], `every unit for ${kind} carries the payload's breadth`);
    }
  });

  it("the asymmetry holds in reverse: a non-fast request is NOT satisfied by an active fast run", async () => {
    const { prisma } = createFakePrisma();
    const service = serviceFor(prisma);
    const fast = await service.createRun({ kind: "full", trigger: "api", options: { fastSync: true, promoteAfter: true } });

    assert.equal((await service.findActiveRun({ options: { fastSync: true, promoteAfter: true } }))?.id, fast.id);
    assert.equal(
      await service.findActiveRun({ options: { fastSync: false, promoteAfter: true } }),
      null,
      "a fast run may have skipped the catalog refresh a non-fast request asked for",
    );
  });

  it("duplicate collapse stays EXACT, so reusing a broader run can never cancel it", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const broad = await service.getOrCreateRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: true } });
    // A fast request reuses it. The collapse pass that follows must not treat the broader run —
    // or anything else — as this request's duplicate.
    const reuse = await service.getOrCreateRun({ kind: "full", trigger: "api", options: { fastSync: true, promoteAfter: true } });
    assert.equal(reuse.id, broad.id);
    assert.equal(reuse.created, false);
    const parent = rows.find((r) => r.id === broad.id);
    assert.equal(parent.status, "RUNNING", "the reused run was not cancelled as a duplicate");
    assert.notEqual(parent.lastError, "duplicate_active_run");
  });

  it("getOrCreateRun creates a separate run for each incompatible option set and resumes matching ones", async () => {
    const { prisma } = createFakePrisma();
    const service = serviceFor(prisma);
    const a = await service.getOrCreateRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: true } });
    const b = await service.getOrCreateRun({ kind: "full", trigger: "api", options: { fastSync: true, promoteAfter: true } });
    assert.equal(a.created, true);
    // b asks for less than a, and a is active, so b is answered with a rather than duplicating it.
    assert.equal(b.created, false, "a fast request folds into the active non-fast run");
    assert.equal(b.id, a.id);
    // c differs on promoteAfter, which is never relaxed — but Phase 8C allows only ONE active
    // parent, so it is refused rather than created beside a. "Incompatible" and "second parent"
    // are now the same answer whatever the incompatible dimension is.
    await assert.rejects(
      () => service.getOrCreateRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: false } }),
      (error) => error.code === "active_run_incompatible" && error.statusCode === 409 && error.activeRunId === a.id,
    );

    for (const [run, options] of [[a, { fastSync: false, promoteAfter: true }]]) {
      const again = await service.getOrCreateRun({ kind: "full", trigger: "scheduler", options });
      assert.equal(again.id, run.id);
      assert.equal(again.created, false);
      assert.equal(again.options.fastSync, options.fastSync, "the reused run reports its OWN options");
      assert.equal(again.options.promoteAfter, options.promoteAfter);
    }
    // An omitted option set uses the documented defaults (full sync promotes).
    const defaulted = await service.getOrCreateRun({ kind: "full", trigger: "api", options: {} });
    assert.equal(defaulted.id, a.id);
    assert.equal(defaulted.created, false);
  });
});

describe("concurrent enqueue — exactly one active run survives", () => {
  const serviceFor = (prisma) => new SyncOrchestrationService({ prisma, now, listAccounts, loadAccountState });
  const activeParents = (rows) => rows.filter((r) => r.jobName === ORCHESTRATION_JOB_NAME && ["PENDING", "RUNNING"].includes(r.status));
  const unitsOf = (rows, runId) => rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId);

  it("two instances enqueueing the same work at the same moment produce ONE active parent, and the loser's units do not survive", async () => {
    const { prisma, rows } = createFakePrisma();
    // Two service instances over one store: the shape of two Vercel instances on one database.
    const a = serviceFor(prisma);
    const b = serviceFor(prisma);
    const options = { fastSync: false, promoteAfter: true };
    const [ra, rb] = await Promise.all([
      a.getOrCreateRun({ kind: "full", trigger: "api", options }),
      b.getOrCreateRun({ kind: "full", trigger: "scheduler", options }),
    ]);

    assert.equal(ra.id, rb.id, "both callers are handed the SAME run id");
    assert.equal(activeParents(rows).length, 1, "exactly one active parent run");
    assert.equal(activeParents(rows)[0].id, ra.id);
    // The winner is the EARLIEST created run, the tie-break every racer computes identically.
    const parentsByAge = rows
      .filter((r) => r.jobName === ORCHESTRATION_JOB_NAME)
      .sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt) || (x.id < y.id ? -1 : 1));
    assert.equal(parentsByAge[0].id, ra.id, "the earliest run is the survivor");
    assert.equal([ra.created, rb.created].filter(Boolean).length, 1, "exactly one caller created it");

    // The losing attempt leaves nothing runnable behind.
    const loser = rows.find((r) => r.jobName === ORCHESTRATION_JOB_NAME && r.id !== ra.id);
    if (loser) {
      assert.equal(loser.status, "CANCELLED");
      assert.ok(loser.completedAt);
      const orphans = unitsOf(rows, loser.id);
      assert.ok(orphans.length > 0, "the loser really had created units");
      assert.ok(orphans.every((u) => u.status === "CANCELLED"), "no PENDING unit survives for the loser");
    }
    // Exactly one runnable unit set exists.
    const runnable = rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.status === "PENDING");
    assert.equal(runnable.length, await plannedUnits({ fastSync: true }));
    assert.ok(runnable.every((u) => u.correlationId === ra.id));
  });

  it("a wider race (five simultaneous callers) still collapses to one active run and one unit set", async () => {
    const { prisma, rows } = createFakePrisma();
    const options = { fastSync: true, promoteAfter: true };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => serviceFor(prisma).getOrCreateRun({ kind: "full", trigger: "api", options })),
    );
    assert.equal(new Set(results.map((r) => r.id)).size, 1, "every caller got the same run");
    assert.equal(activeParents(rows).length, 1);
    assert.equal(results.filter((r) => r.created).length, 1, "only one creation is reported");
    const runnable = rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.status === "PENDING");
    assert.equal(runnable.length, await plannedUnits({ fastSync: true }));
    assert.ok(runnable.every((u) => u.correlationId === results[0].id));
  });

  it("racing INCOMPATIBLE requests each keep their own run — collapsing never merges different work", async () => {
    const { prisma, rows } = createFakePrisma();
    const [full, fast, noPromote] = await Promise.all([
      serviceFor(prisma).getOrCreateRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: true } }),
      serviceFor(prisma).getOrCreateRun({ kind: "full", trigger: "api", options: { fastSync: true, promoteAfter: true } }),
      serviceFor(prisma).getOrCreateRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: false } }),
    ]);
    assert.equal(new Set([full.id, fast.id, noPromote.id]).size, 3);
    assert.equal(activeParents(rows).length, 3, "three distinct kinds of work stay separate");
    assert.ok([full, fast, noPromote].every((r) => r.created));
  });

  it("self-heals a pre-existing duplicate whose units are untouched, and returns the earliest run", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const options = { fastSync: false, promoteAfter: true };
    const first = await service.createRun({ kind: "full", trigger: "api", options });
    const duplicate = await service.createRun({ kind: "full", trigger: "api", options });
    assert.equal(activeParents(rows).length, 2, "two active duplicates exist before the call");

    const resumed = await service.getOrCreateRun({ kind: "full", trigger: "api", options });
    assert.equal(resumed.id, first.id, "the earliest run wins");
    assert.equal(resumed.created, false);
    assert.equal(activeParents(rows).length, 1, "the duplicate was collapsed");
    assert.equal(rows.find((r) => r.id === duplicate.id).status, "CANCELLED");
    assert.ok(unitsOf(rows, duplicate.id).every((u) => u.status === "CANCELLED"));
    assert.ok(unitsOf(rows, first.id).every((u) => u.status === "PENDING"), "the survivor is untouched");
  });

  it("collapsing is transactional and refuses a run that is already terminal", async () => {
    const { prisma, rows, ops } = createFakePrisma();
    const service = serviceFor(prisma);
    const options = { fastSync: false, promoteAfter: true };
    const run = await service.createRun({ kind: "full", trigger: "api", options });

    const before = ops.length;
    const collapse = await service.collapseDuplicateRun(run.id, { canonicalRunId: "zzotherzz" });
    assert.equal(collapse.collapsed, true);
    assert.ok(ops.slice(before).includes("$transaction"), "parent and units are cancelled atomically");
    assert.equal(rows.find((r) => r.id === run.id).status, "CANCELLED");

    // Re-collapsing is a no-op, and a run that reached a terminal state is never overwritten.
    const again = await service.collapseDuplicateRun(run.id);
    assert.equal(again.collapsed, false);
    assert.equal(again.reason, "already_terminal");

    const finished = await service.createRun({ kind: "full", trigger: "api", options: { fastSync: true, promoteAfter: false } });
    await prisma.jobRun.update({ where: { id: finished.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    const refused = await service.collapseDuplicateRun(finished.id);
    assert.equal(refused.collapsed, false);
    assert.equal(refused.reason, "already_terminal");
    assert.equal(rows.find((r) => r.id === finished.id).status, "COMPLETED", "a completed run is never rewritten to CANCELLED");
  });

  it("a run that becomes terminal BETWEEN the check and the write is not resurrected", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const run = await service.createRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: true } });

    // Another instance finishes the run after our snapshot is read but before our write lands.
    const realFindUnique = prisma.jobRun.findUnique;
    prisma.jobRun.findUnique = async (args) => {
      const snapshot = await realFindUnique.call(prisma.jobRun, args);
      const row = rows.find((r) => r.id === args.where.id);
      if (row && row.jobName === ORCHESTRATION_JOB_NAME) { row.status = "COMPLETED"; row.completedAt = new Date(); }
      return snapshot;
    };
    const outcome = await service.collapseDuplicateRun(run.id);
    prisma.jobRun.findUnique = realFindUnique;

    assert.equal(outcome.collapsed, false);
    assert.equal(outcome.reason, "already_terminal");
    assert.equal(rows.find((r) => r.id === run.id).status, "COMPLETED", "the finished run keeps its outcome");
    assert.ok(unitsOf(rows, run.id).every((u) => u.status === "PENDING"), "its units are not cancelled either");
  });

  it("never collapses a duplicate whose work has already started", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const options = { fastSync: false, promoteAfter: true };
    const first = await service.createRun({ kind: "full", trigger: "api", options });
    const started = await service.createRun({ kind: "full", trigger: "api", options });
    const unit = await service.nextUnit(started.id);
    await service.claimUnit(unit.id, { workerId: "zzworkerzz" });

    const resumed = await service.getOrCreateRun({ kind: "full", trigger: "api", options });
    assert.equal(resumed.id, first.id, "callers are still steered to the earliest run");
    assert.equal(rows.find((r) => r.id === started.id).status, "RUNNING", "in-flight work is never cancelled underneath a worker");
    assert.equal(rows.find((r) => r.id === unit.id).status, "RUNNING");
  });
});

describe("source guards — enqueue only, and the other routes untouched", () => {
  const handler = handlerOf("triggerSyncAll");

  it("the handler awaits the durable service and starts nothing in the background", () => {
    assert.match(handler, /await [\w.]*\.getOrCreateRun\(\{/);
    assert.match(handler, /kind: "full"/);
    assert.match(handler, /promoteAfter: true/);
    assert.match(handler, /res\.status\(202\)/);
    assert.match(handler, /runId: run\.id/);
    assert.match(handler, /created: run\.created/);
    for (const forbidden of ["startBackgroundSync", "runSyncInBackground", "syncAll(", "setTimeout", "setInterval", "setImmediate", ".catch(", "void "]) {
      assert.ok(!handler.includes(forbidden), forbidden);
    }
  });

  it("the whole controller no longer reaches the unsafe launcher or the monolithic job", () => {
    for (const forbidden of ["startBackgroundSync", "runSyncInBackground", "syncAll"]) {
      assert.ok(!CONTROLLER_SRC.includes(forbidden), `${forbidden} must be gone from the controller`);
    }
    assert.match(CONTROLLER_SRC, /import \{ syncPlatformAccount \} from "\.\.\/jobs\/sync\.job\.js";/, "only the per-account entrypoint remains");
    assert.match(CONTROLLER_SRC, /SyncOrchestrationService/);
  });

  it("/sync/incremental is retired at 410, and the manual per-network route and the canary are unchanged", () => {
    const incremental = handlerOf("triggerIncrementalSync");
    assert.match(incremental, /res\.status\(410\)/);
    assert.match(incremental, /code: LEGACY_INCREMENTAL_RETIRED_CODE/);
    assert.ok(!incremental.includes("triggerScheduledSync"), "the legacy launcher is gone");
    // Retirement is not a redirect: Phase 8A refuses, it does not plan a durable incremental run.
    assert.ok(!incremental.includes("getOrCreateRun"), "retirement does not enqueue a durable run");
    const platform = handlerOf("triggerSyncPlatform");
    // Phase 3: still awaited, now under the shared durable account lock.
    assert.match(platform, /await locks\.withLock\(/);
    assert.match(platform, /respondWithExclusiveSync\(\{/);
    assert.match(platform, /resolvePlatformSyncOptions\(req\.query\)/);
    assert.ok(!platform.includes("getOrCreateRun"));
    const canary = handlerOf("triggerBoostinyCanarySync");
    // The canary now takes the shared durable account lock, so the await sits on withLock,
    // which awaits the function that calls runExclusiveSync. Still fully awaited, never detached.
    assert.match(canary, /const outcome = await locks\.withLock\(/);
    assert.match(canary, /runExclusiveSync\(/);
    assert.match(canary, /const run = outcome\.result;/);
    assert.match(canary, /promoteAfter: false,/);
    assert.ok(!canary.includes("getOrCreateRun"));
    // Unit execution belongs to the worker alone: no other handler claims or completes units,
    // and nothing in the controller wires a cron.
    const worker = handlerOf("triggerSyncWorker");
    const others = CONTROLLER_SRC.replace(worker, "");
    for (const verb of ["claimUnit", "completeUnit", "failUnit", "nextWorkableUnit"]) {
      assert.ok(worker.includes(verb), `the worker uses ${verb}`);
      assert.ok(!others.includes(verb), `${verb} is confined to the worker`);
    }
    for (const forbidden of ["cron", "CRON", "collapseDuplicateRun"]) {
      assert.ok(!CONTROLLER_SRC.includes(forbidden), forbidden);
    }
  });
});

describe("the enqueue response is never shared-cacheable", () => {
  /** Serves the route on an ephemeral port so the wire headers can be read. */
  async function serve(build) {
    const express = (await import("express")).default;
    const app = express();
    app.use(express.json());
    build(app);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      request: (path) => fetch(`${base}${path}`, { method: "POST" }),
      stop: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it("POST /sync/all answers with Cache-Control: no-store", async () => {
    const { noStoreHeaders } = await import("../src/platform/security/index.js");
    const h = harness();
    const app = await serve((a) =>
      a.post("/sync/all", noStoreHeaders, (req, res, next) => {
        req.app.locals.syncOrchestration = h.orchestration;
        return triggerSyncAll(req, res, next);
      }),
    );
    try {
      const res = await app.request("/sync/all");
      assert.equal(res.status, 202);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("pragma"), "no-cache");
      assert.ok(!/public/i.test(res.headers.get("cache-control") ?? ""));
      // The 202 really does carry durable run state, which is why it must not be cached.
      assert.ok((await res.json()).syncStatus.runId);
    } finally {
      await app.stop();
    }
  });

  it("the route carries the shared middleware, ahead of the auth guards", () => {
    const route = ROUTES_SRC.split('"/sync/all",')[1].split(");")[0];
    assert.match(route, /noStoreHeaders/, "the existing internal-API cache-control mechanism");
    assert.ok(route.indexOf("noStoreHeaders") < route.indexOf("authenticate"), "covers a 401/403 too");
    assert.ok(!route.includes("Cache-Control"), "not a hand-written header");
  });
});
