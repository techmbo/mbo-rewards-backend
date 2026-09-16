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

  it("an INCOMPATIBLE request is never silently folded into the active run", async () => {
    const h = harness();
    const normal = await h.call({});
    const fast = await h.call({ fast: "true" });
    assert.equal(fast.body.created, true, "a fast run is not the same work as a full run");
    assert.notEqual(fast.body.runId, normal.body.runId);
    assert.equal(h.parents().length, 2);
    // …and each subsequent request resumes its own matching run.
    assert.equal((await h.call({ fast: "true" })).body.runId, fast.body.runId);
    assert.equal((await h.call({})).body.runId, normal.body.runId);
    assert.equal(h.parents().length, 2);
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

  it("findActiveRun matches kind AND the execution options that change the work", async () => {
    const { prisma } = createFakePrisma();
    const service = serviceFor(prisma);
    const base = await service.createRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: true } });

    assert.equal((await service.findActiveRun({ kind: "full", options: { fastSync: false, promoteAfter: true } }))?.id, base.id);
    assert.equal(await service.findActiveRun({ kind: "full", options: { fastSync: true, promoteAfter: true } }), null, "fastSync differs");
    assert.equal(await service.findActiveRun({ kind: "full", options: { fastSync: false, promoteAfter: false } }), null, "promoteAfter differs");
    assert.equal(await service.findActiveRun({ kind: "incremental", options: { fastSync: false, promoteAfter: true } }), null, "kind differs");
    assert.equal((await service.findActiveRun({}))?.id, base.id, "no filter still finds the active run");
  });

  it("getOrCreateRun creates a separate run for each incompatible option set and resumes matching ones", async () => {
    const { prisma } = createFakePrisma();
    const service = serviceFor(prisma);
    const a = await service.getOrCreateRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: true } });
    const b = await service.getOrCreateRun({ kind: "full", trigger: "api", options: { fastSync: true, promoteAfter: true } });
    const c = await service.getOrCreateRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: false } });
    assert.equal(a.created, true);
    assert.equal(b.created, true);
    assert.equal(c.created, true);
    assert.equal(new Set([a.id, b.id, c.id]).size, 3, "three distinct runs");

    for (const [run, options] of [[a, { fastSync: false, promoteAfter: true }], [b, { fastSync: true, promoteAfter: true }], [c, { fastSync: false, promoteAfter: false }]]) {
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

  it("/sync/incremental, the manual per-network route and the canary are unchanged", () => {
    const incremental = handlerOf("triggerIncrementalSync");
    assert.match(incremental, /triggerScheduledSync\(\{ reason: "api" \}\)/);
    assert.match(incremental, /res\.status\(202\)/);
    assert.ok(!incremental.includes("getOrCreateRun"), "incremental is not part of phase 2");
    const platform = handlerOf("triggerSyncPlatform");
    // Phase 3: still awaited, now under the shared durable account lock.
    assert.match(platform, /await locks\.withLock\(/);
    assert.match(platform, /respondWithExclusiveSync\(\{/);
    assert.match(platform, /resolvePlatformSyncOptions\(req\.query\)/);
    assert.ok(!platform.includes("getOrCreateRun"));
    const canary = handlerOf("triggerBoostinyCanarySync");
    assert.match(canary, /const run = await runExclusiveSync\(/);
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
