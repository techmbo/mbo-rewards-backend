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
import { triggerSyncAll } from "../src/controllers/sync.controller.js";
import {
  ORCHESTRATION_JOB_NAME,
  UNIT_JOB_NAME,
  UNIT_KINDS,
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
  const jobRun = {
    async create({ data }) {
      seq += 1;
      const row = { id: `row-${String(seq).padStart(4, "0")}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(NOW.getTime() + seq), ...data };
      rows.push(row); return clone(row);
    },
    async createMany({ data }) { for (const row of data) await jobRun.create({ data: row }); return { count: data.length }; },
    async update({ where, data }) { const row = rows.find((r) => r.id === where.id); Object.assign(row, data); return clone(row); },
    async updateMany({ where, data }) { let count = 0; for (const row of rows) if (match(row, where)) { Object.assign(row, data); count += 1; } return { count }; },
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
  const enqueue = async (query = {}) => {
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await triggerSyncAll({ query, app: { locals: { syncOrchestration: orchestration } } }, res, (error) => { throw error; });
    return res;
  };
  const parents = () => rows.filter((r) => r.jobName === ORCHESTRATION_JOB_NAME);
  const unitsOf = (runId) => rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId);
  return { rows, prisma, orchestration, enqueue, parents, unitsOf };
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

  it("incompatible OPTIONS are still incompatible, version or not", async () => {
    const h = harness();
    const slow = await h.enqueue();
    const fast = await h.enqueue({ fast: "true" });
    assert.notEqual(fast.body.runId, slow.body.runId);
    assert.equal(fast.body.created, true);
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
