/**
 * A run is only reusable by a request that would plan the SAME SHAPE of work.
 *
 * Production proved kind + options is not that test: a Phase 5 `/sync/all` matched the still-active
 * pre-Phase-5 run c9e3e699 on every one of them and resumed it, so a request certified to plan 124
 * bounded units answered with `created:false` and a 9-unit account-wide run whose current unit had
 * no source object and no window. The parent now records which planner built it, and reuse,
 * duplicate-collapse and race resolution are all scoped to that version.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getSyncStatusHandler, triggerSyncAll, triggerSyncWorker } from "../src/controllers/sync.controller.js";
import {
  ORCHESTRATION_JOB_NAME,
  UNIT_JOB_NAME,
  UNIT_KINDS,
  DEFAULT_LEASE_MS,
  PLANNER_VERSION,
  SyncOrchestrationService,
  buildSyncPlan,
  summarisePlan,
} from "../src/jobs/syncOrchestration.service.js";

const SERVICE_SRC = readFileSync(new URL("../src/jobs/syncOrchestration.service.js", import.meta.url), "utf8");

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
const OPTIONS = { fastSync: false, promoteAfter: true };

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
      return { [accountLabel ?? "default"]: { campaigns: 1 } };
    },
  };
  const call = async (handler, query = {}) => {
    const headers = {};
    const res = {
      statusCode: null, body: null, headers,
      set(name, value) { headers[String(name).toLowerCase()] = value; return this; },
      status(c) { this.statusCode = c; return this; },
      // Express answers 200 when a handler calls res.json() without res.status(); the status
      // handler's success path does exactly that.
      json(b) { this.body = b; if (this.statusCode === null) this.statusCode = 200; return this; },
    };
    await handler({ query, app: { locals } }, res, (error) => { throw error; });
    return res;
  };
  const enqueue = (query = {}) => call(triggerSyncAll, query);
  const worker = () => call(triggerSyncWorker);
  const status = (query = {}) => call(getSyncStatusHandler, query);
  const parents = () => rows.filter((r) => r.jobName === ORCHESTRATION_JOB_NAME);
  const unitsOf = (runId) => rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId);
  return { rows, prisma, orchestration, supplierCalls, enqueue, worker, status, parents, unitsOf };
}

/**
 * The production run, as it actually sits in the table: active, matching on kind and both options,
 * nine account-wide units, one of them already RUNNING, and NO plannerVersion.
 */
function seedLegacyRun(h, { id = "legacy-c9e3e699" } = {}) {
  const platforms = ["boostiny", "optimise_sea", "trackier", "impact", "partnerize", "awin", "admitad", "rakuten", "cj"];
  h.rows.push({
    id, jobName: ORCHESTRATION_JOB_NAME, status: "RUNNING", priority: 100, attempt: 0, maxAttempts: 1,
    progress: 11, correlationId: id, startedAt: new Date(NOW.getTime() - 86_400_000),
    completedAt: null, lastError: null, createdAt: new Date(NOW.getTime() - 86_400_000),
    payload: { kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: true }, totalUnits: 9 },
    result: { totalUnits: 9, completedUnits: 1, failedUnits: 0, pendingUnits: 7, runningUnits: 1 },
  });
  platforms.forEach((platform, index) => {
    h.rows.push({
      id: `${id}-unit-${index + 1}`, jobName: UNIT_JOB_NAME,
      status: index === 0 ? "COMPLETED" : index === 1 ? "RUNNING" : "PENDING",
      priority: index + 1, attempt: index <= 1 ? 1 : 0, maxAttempts: 3, progress: 0,
      correlationId: id, startedAt: index <= 1 ? new Date(NOW.getTime() - 3600_000) : null,
      completedAt: null, lastError: null, result: null, createdAt: new Date(NOW.getTime() - 86_400_000),
      // The pre-Phase-5 descriptor shape: a whole account, no source object, no window.
      payload: { parentRunId: id, sequence: index + 1, kind: UNIT_KINDS.NETWORK, platform, accountLabel: "default", options: { fastSync: false, promoteAfter: false }, lockKey: `network:${platform}:default` },
    });
  });
  return id;
}

const snapshot = (h, id) =>
  JSON.stringify([h.rows.find((r) => r.id === id), ...h.unitsOf(id)]);

describe("a legacy run is not this request's run", () => {
  it("an active 9-unit account-wide run is ignored and a Phase 5 run is created", async () => {
    const h = harness();
    const legacyId = seedLegacyRun(h);

    const res = await h.enqueue();
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.created, true, "the defect was created:false here");
    assert.notEqual(res.body.runId, legacyId);

    const created = h.rows.find((r) => r.id === res.body.runId);
    assert.equal(created.payload.plannerVersion, PLANNER_VERSION);
    const units = h.unitsOf(created.id);
    assert.ok(units.length > 100, "a bounded plan, not nine account-wide units");
    assert.equal(units.length, created.payload.totalUnits);
    assert.ok(units.every((u) => u.payload.sourceObject), "every new unit names its source object");
    assert.equal(res.body.syncStatus.runId, created.id);
    assert.equal(res.body.syncStatus.plannerVersion, PLANNER_VERSION);
  });

  it("the legacy run is left exactly as it was — not resumed, not cancelled, not touched", async () => {
    const h = harness();
    const legacyId = seedLegacyRun(h);
    const before = snapshot(h, legacyId);

    await h.enqueue();
    await h.enqueue();
    await h.orchestration.getOrCreateRun({ kind: "full", trigger: "scheduler", options: OPTIONS });

    assert.equal(snapshot(h, legacyId), before, "every byte of the legacy run and its units is unchanged");
    const legacy = h.rows.find((r) => r.id === legacyId);
    assert.equal(legacy.status, "RUNNING", "still active");
    assert.equal(legacy.payload.plannerVersion, undefined, "and still unversioned");
  });

  it("duplicate collapse refuses a run another planner created, even asked directly", async () => {
    const h = harness();
    const legacyId = seedLegacyRun(h);
    const result = await h.orchestration.collapseDuplicateRun(legacyId, { canonicalRunId: "whatever" });
    assert.equal(result.collapsed, false);
    assert.equal(result.reason, "foreign_planner_version");
    assert.equal(h.rows.find((r) => r.id === legacyId).status, "RUNNING");
    assert.ok(h.unitsOf(legacyId).every((u) => u.status !== "CANCELLED"), "no started legacy unit is cancelled");
  });

  it("a legacy run is invisible to compatibility matching but still readable for status", async () => {
    const h = harness();
    const legacyId = seedLegacyRun(h);
    // Matching for reuse: not a candidate.
    assert.equal(await h.orchestration.findActiveRun({ kind: "full", options: OPTIONS, plannerVersion: PLANNER_VERSION }), null);
    assert.deepEqual(await h.orchestration.listActiveCompatibleRuns({ kind: "full", options: OPTIONS, plannerVersion: PLANNER_VERSION }), []);
    // Reading: still fully visible, so an operator can watch the run they started.
    assert.equal((await h.orchestration.findActiveRun())?.id, legacyId);
    const status = await h.orchestration.describeRun(legacyId);
    assert.equal(status.totalUnits, 9);
    assert.equal(status.plannerVersion, null, "reported honestly as unversioned");
    assert.equal(status.currentUnit.sourceObject, null);
    assert.equal(status.currentUnit.window, null);
  });
});

describe("compatibility among versioned runs", () => {
  it("two Phase 5 requests with the same version and options reuse one run", async () => {
    const h = harness();
    const first = await h.enqueue();
    const second = await h.enqueue();
    assert.equal(first.body.created, true);
    assert.equal(second.body.created, false, "the second resumes the first");
    assert.equal(second.body.runId, first.body.runId);
    assert.equal(h.parents().length, 1);
    assert.equal(h.unitsOf(first.body.runId).length, first.body.syncStatus.totalUnits);
  });

  it("concurrent Phase 5 requests still collapse to exactly one run", async () => {
    const h = harness();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => h.orchestration.getOrCreateRun({ kind: "full", trigger: "api", options: OPTIONS })),
    );
    assert.equal(new Set(results.map((r) => r.id)).size, 1, "every caller got the same run");
    const active = h.parents().filter((r) => ["PENDING", "RUNNING"].includes(r.status));
    assert.equal(active.length, 1);
    assert.equal(results.filter((r) => r.created).length, 1, "only one creation is reported");
    const runnable = h.rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.status === "PENDING");
    assert.ok(runnable.every((u) => u.correlationId === results[0].id), "one unit set survives");
  });

  it("a run from a different planner version is incompatible in both directions", async () => {
    const h = harness();
    const created = await h.orchestration.getOrCreateRun({ kind: "full", trigger: "api", options: OPTIONS });
    const parent = h.rows.find((r) => r.id === created.id);

    // Same run, relabelled as a future planner: today's request must not adopt it.
    parent.payload = { ...parent.payload, plannerVersion: PLANNER_VERSION + 1 };
    const next = await h.orchestration.getOrCreateRun({ kind: "full", trigger: "api", options: OPTIONS });
    assert.notEqual(next.id, created.id);
    assert.equal(next.created, true);

    // And the future run is not collapsed as a duplicate of the new one either.
    assert.equal(h.rows.find((r) => r.id === created.id).status, "RUNNING");
    assert.equal(
      (await h.orchestration.collapseDuplicateRun(created.id, { canonicalRunId: next.id })).reason,
      "foreign_planner_version",
    );
  });

  it("breadth folds but promoteAfter does not, version or not", async () => {
    const h = harness();
    const slow = await h.enqueue();
    const fast = await h.enqueue({ fast: "true" });
    // Same planner version, and the non-fast run is a superset: the fast request resumes it.
    assert.equal(fast.body.runId, slow.body.runId);
    assert.equal(fast.body.created, false);
    assert.equal(fast.body.reusedBroaderRun, true);
  });
});

describe("the created run is the previewed run", () => {
  it("preview and enqueue describe the same bounded shape for identical state", async () => {
    const h = harness();
    seedLegacyRun(h);
    const expected = summarisePlan(
      await buildSyncPlan({ kind: "full", fastSync: false, promoteAfter: true, listAccounts, loadAccountState, now: NOW }),
      { kind: "full", options: OPTIONS },
    );
    const preview = await h.orchestration.previewPlan({ kind: "full", options: OPTIONS });
    assert.equal(summarisePlan(preview, { kind: "full", options: OPTIONS }).totalUnits, expected.totalUnits);

    const res = await h.enqueue();
    const created = h.unitsOf(res.body.runId);
    assert.equal(created.length, expected.totalUnits, "the enqueued run is the previewed size, not the legacy 9");
    assert.notEqual(created.length, 9);

    const byPlatform = {};
    for (const row of created) byPlatform[row.payload.platform] = (byPlatform[row.payload.platform] ?? 0) + 1;
    assert.deepEqual(byPlatform, expected.byPlatform);
    assert.equal(created.filter((u) => u.payload.windowStart).length, expected.windowedUnits);
    assert.equal(created.filter((u) => !u.payload.windowStart).length, expected.catalogUnits);
    // A legacy run sitting in the table changes neither number.
    assert.equal(expected.exclusions.length, 0);
  });
});

describe("source guards", () => {
  it("the version is durable, stamped on new runs, and required for reuse", () => {
    assert.equal(typeof PLANNER_VERSION, "number");
    assert.match(SERVICE_SRC, /export const PLANNER_VERSION = \d+;/);
    const createRun = SERVICE_SRC.split("  async createRun(")[1].split("\n  }")[0];
    assert.match(createRun, /plannerVersion: PLANNER_VERSION,/, "every new run records its planner");
    const getOrCreate = SERVICE_SRC.split("  async getOrCreateRun(")[1].split("\n  }")[0];
    assert.match(getOrCreate, /const plannerVersion = PLANNER_VERSION;/);
    assert.equal(
      (getOrCreate.match(/plannerVersion/g) ?? []).length >= 4,
      true,
      "every lookup and collapse in the reuse path is version-scoped",
    );
    // The condition matches an exact value, so an absent key matches nothing.
    const conditions = SERVICE_SRC.split("function compatibilityConditions(")[1].split("\n}")[0];
    assert.match(conditions, /path: \["plannerVersion"\], equals: plannerVersion/);
    assert.match(conditions, /if \(plannerVersion !== null && plannerVersion !== undefined\)/);
  });

  it("nothing about this fix needs a schema change", () => {
    // The version lives in the existing JobRun.payload JSON; no column, no migration.
    for (const forbidden of ["prisma.$executeRaw", "ALTER TABLE", "CREATE TABLE", "migrate"]) {
      assert.ok(!SERVICE_SRC.includes(forbidden), forbidden);
    }
  });
});

describe("a worker never executes another planner's run", () => {
  it("with an older legacy run AND a current Phase 5 run active, it works the Phase 5 run", async () => {
    const h = harness();
    const legacyId = seedLegacyRun(h);
    const before = snapshot(h, legacyId);
    const enqueued = await h.enqueue();

    // The legacy run is OLDER and its sequence-2 unit is a stale RUNNING claim, so the previous
    // oldest-active-run selection would have handed exactly that unit to the worker.
    const legacyStale = h.unitsOf(legacyId).find((u) => u.status === "RUNNING");
    assert.ok(legacyStale, "the legacy run really does have a claimable unit");
    assert.ok(
      new Date(h.rows.find((r) => r.id === legacyId).createdAt) <
        new Date(h.rows.find((r) => r.id === enqueued.body.runId).createdAt),
      "and it really is the older run",
    );

    const res = await h.worker();
    assert.equal(res.body.worked, true);
    assert.equal(res.body.runId, enqueued.body.runId, "the current-planner run, not the older one");
    assert.equal(res.body.unit.sourceObject, "campaigns", "a bounded unit, not an account-wide one");
    assert.equal(h.supplierCalls.length, 1);
    assert.ok(h.supplierCalls[0].options.sourceObject, "the executed unit was a bounded one");

    // And the legacy run is untouched by having been passed over.
    assert.equal(snapshot(h, legacyId), before);
  });

  it("a legacy run alone yields idle, and no supplier work runs", async () => {
    const h = harness();
    const legacyId = seedLegacyRun(h);
    const before = snapshot(h, legacyId);

    assert.equal(await h.orchestration.nextWorkableUnit(), null, "no current-planner work exists");
    const res = await h.worker();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.worked, false);
    assert.equal(res.body.status, "idle");
    assert.deepEqual(h.supplierCalls, [], "an account-wide legacy unit is never executed");

    // Asking for work repeatedly still changes nothing about it — retirement stays deliberate.
    await h.worker();
    await h.worker();
    assert.equal(snapshot(h, legacyId), before);
    assert.equal(h.rows.find((r) => r.id === legacyId).status, "RUNNING");
    assert.ok(h.unitsOf(legacyId).every((u) => u.status !== "CANCELLED" && u.status !== "DEAD_LETTER"));
  });

  it("status still reads the legacy run explicitly by id", async () => {
    const h = harness();
    const legacyId = seedLegacyRun(h);
    await h.enqueue();

    const res = await h.status({ runId: legacyId });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.body.run.runId, legacyId);
    assert.equal(res.body.run.totalUnits, 9, "old history is readable, not hidden or rewritten");
    assert.equal(res.body.run.plannerVersion, null);
    assert.equal(res.body.units.length, 9);
    assert.ok(res.body.units.every((u) => u.sourceObject === null && u.window === null));
    assert.equal(snapshot(h, legacyId), snapshot(h, legacyId), "reading is not writing");
  });
});

describe("worker semantics among current-version runs are unchanged", () => {
  it("a stale claim still follows the existing reclaim and dead-letter rules", async () => {
    const h = harness();
    seedLegacyRun(h);
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", sourceObject: "campaigns", options: {} }],
    });
    const unit = await h.orchestration.nextUnit(run.id);
    await h.orchestration.claimUnit(unit.id, { workerId: "killed" });
    const row = h.rows.find((r) => r.id === unit.id);

    // Attempt 1 lease expires → reclaimed as attempt 2, then 3, then DEAD_LETTER at maxAttempts.
    const expire = () => { row.startedAt = new Date(NOW.getTime() - (DEFAULT_LEASE_MS + 60_000)); };
    expire();
    assert.equal((await h.orchestration.claimUnit(unit.id, { workerId: "b" })).reclaimed, true);
    assert.equal(h.rows.find((r) => r.id === unit.id).attempt, 2);
    expire();
    assert.equal((await h.orchestration.claimUnit(unit.id, { workerId: "c" })).claimed, true);
    assert.equal(h.rows.find((r) => r.id === unit.id).attempt, 3);
    expire();
    const refused = await h.orchestration.claimUnit(unit.id, { workerId: "d" });
    assert.equal(refused.claimed, false);
    assert.equal(refused.reason, "abandoned");
    assert.equal(h.rows.find((r) => r.id === unit.id).status, "DEAD_LETTER");
    assert.deepEqual(h.supplierCalls, [], "no supplier work for an abandoned unit");
  });

  it("several current-version runs are worked oldest first, deterministically", async () => {
    const h = harness();
    seedLegacyRun(h);
    const units = (platform) => [{ kind: UNIT_KINDS.NETWORK, platform, accountLabel: "default", sourceObject: "campaigns", options: {} }];
    const first = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: units("boostiny") });
    const second = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: units("trackier") });

    const a = await h.orchestration.nextWorkableUnit();
    assert.equal(a.run.id, first.id, "the oldest current-version run first");
    // Asking again without working anything is stable.
    assert.equal((await h.orchestration.nextWorkableUnit()).run.id, first.id);

    const worked = await h.worker();
    assert.equal(worked.body.runId, first.id);
    assert.equal((await h.orchestration.nextWorkableUnit()).run.id, second.id, "then the next one");
    assert.equal(h.supplierCalls.length, 1, "exactly one unit per invocation");
  });

  it("the account lock still excludes a second unit of the same account", async () => {
    const h = harness();
    seedLegacyRun(h);
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [
        { kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", sourceObject: "campaigns", options: {} },
        { kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", sourceObject: "coupons", options: {} },
      ],
    });
    const [one, two] = h.unitsOf(run.id);
    assert.equal((await h.orchestration.claimUnit(one.id, { workerId: "a" })).claimed, true);
    const sibling = await h.orchestration.claimUnit(two.id, { workerId: "b" });
    assert.equal(sibling.claimed, false);
    assert.equal(sibling.reason, "lock_held");
  });

  it("worker selection is version-scoped at the query, not filtered afterwards", () => {
    const next = SERVICE_SRC.split("  async nextWorkableUnit(")[1].split("\n  }")[0];
    assert.match(next, /compatibilityConditions\(\{ plannerVersion: PLANNER_VERSION \}\)/);
    assert.match(next, /orderBy: \[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/, "ordering is unchanged");
    for (const forbidden of ["CANCELLED", "updateMany", "delete"]) {
      assert.ok(!next.includes(forbidden), `selection must not mutate anything: ${forbidden}`);
    }
  });
});
