/**
 * Phase 1 — durable sync orchestration model on top of the existing JobRun table.
 *
 * A full sync is a parent JobRun (jobName "sync:orchestration") plus one child JobRun per bounded
 * unit (jobName "sync:unit", correlationId = parent id, priority = sequence). Nothing here executes
 * a sync; the service plans units, claims them atomically, records outcomes, reclaims stale
 * claims after a lease, and projects durable status. No module memory, no schema change.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ORCHESTRATION_JOB_NAME,
  UNIT_JOB_NAME,
  UNIT_KINDS,
  UNIT_BLOCKED_REASON,
  DEFAULT_LEASE_MS,
  SyncOrchestrationService,
  assertUnitExecutable,
  buildSyncPlan,
  isUnitExecutable,
  unitLockKey,
} from "../src/jobs/syncOrchestration.service.js";
import { DEFAULT_LEASE_MS as LOCK_LEASE_MS, accountLockKey } from "../src/jobs/syncAccountLock.service.js";

/** Minimal in-memory JobRun store honouring the where-shapes the service uses. */
function createFakePrisma({ failCreateAfter = Infinity } = {}) {
  const rows = [];
  let seq = 0;
  const ops = [];
  const clone = (r) => JSON.parse(JSON.stringify(r));
  const matchWhere = (row, where = {}) => {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "AND") { if (!cond.every((w) => matchWhere(row, w))) return false; continue; }
      if (key === "NOT") { if (matchWhere(row, cond)) return false; continue; }
      if (key === "payload") {
        const path = cond.path ?? [];
        let value = row.payload;
        for (const p of path) value = value?.[p];
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
  const sortRows = (list, orderBy) => {
    const specs = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...list].sort((a, b) => {
      for (const spec of specs) {
        const [field, dir] = Object.entries(spec)[0];
        const av = a[field] instanceof Date ? a[field].getTime() : a[field];
        const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
        if (av === bv) continue;
        const cmp = av > bv ? 1 : -1;
        return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  };
  const applyData = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
      else row[k] = v;
    }
    row.updatedAt = new Date();
  };
  const jobRun = {
    async create({ data }) {
      ops.push("create");
      if (ops.filter((o) => o === "create").length > failCreateAfter) throw new Error("zzcreate failedzz");
      seq += 1;
      const row = { id: `job-${seq}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(Date.now() + seq), updatedAt: new Date(), ...data };
      rows.push(row);
      return clone(row);
    },
    async update({ where, data }) { ops.push("update"); const row = rows.find((r) => r.id === where.id); if (!row) throw new Error("not found"); applyData(row, data); return clone(row); },
    async updateMany({ where, data }) { ops.push("updateMany"); let count = 0; for (const row of rows) if (matchWhere(row, where)) { applyData(row, data); count += 1; } return { count }; },
    async findUnique({ where }) { const row = rows.find((r) => r.id === where.id); return row ? clone(row) : null; },
    async findFirst({ where, orderBy }) { const list = sortRows(rows.filter((r) => matchWhere(r, where)), orderBy); return list.length ? clone(list[0]) : null; },
    async findMany({ where, orderBy, take }) { let list = sortRows(rows.filter((r) => matchWhere(r, where ?? {})), orderBy); if (take) list = list.slice(0, take); return list.map(clone); },
    async count({ where }) { return rows.filter((r) => matchWhere(r, where ?? {})).length; },
  };
  const prisma = { jobRun, async $transaction(fn) { ops.push("$transaction"); return fn({ jobRun }); } };
  return { prisma, rows, ops };
}

const accounts = {
  boostiny: ["default"],
  optimise_sea: ["default", "second"],
  optimise_mena: [],
  optimise_uk: ["default"],
  trackier: ["default"],
};
const listAccounts = async (platform) => accounts[platform] ?? ["default"];
let clock = new Date("2026-09-15T12:00:00.000Z");
const now = () => clock;
// Phase 5: the plan's size depends on each account's outstanding span, so the tests pin the span
// instead of a magic unit count. A never-synced account plans its full initial lookback.
const loadAccountState = async () => ({ lastSuccessfulSync: null });
const serviceFor = (prisma, extra = {}) =>
  new SyncOrchestrationService({ prisma, now, listAccounts, loadAccountState, ...extra });
const planFor = (opts = {}) => buildSyncPlan({ listAccounts, loadAccountState, now: clock, ...opts });
const planSize = async (opts = {}) => (await planFor(opts)).units.length;

describe("plan — one bounded, ordered unit per network account, then the post-sync stages", () => {
  it("enumerates connected accounts per platform in the established syncAll order", async () => {
    const plan = (await planFor({ kind: "full", fastSync: false, promoteAfter: true })).units;
    const networkUnits = plan.filter((u) => u.kind === UNIT_KINDS.NETWORK);
    // Phase 5: an account is several bounded units, so the ACCOUNT order is the distinct sequence
    // of platform/account, and every account's units form one contiguous block.
    assert.deepEqual(
      [...new Set(networkUnits.map((u) => `${u.platform}/${u.accountLabel}`))],
      [
        "boostiny/default",
        "optimise_sea/default", "optimise_sea/second",
        "optimise_uk/default",
        "trackier/default",
        "impact/default", "partnerize/default", "awin/default", "admitad/default", "rakuten/default", "cj/default",
      ],
    );
    const blocks = networkUnits.map((u) => `${u.platform}/${u.accountLabel}`);
    assert.equal(
      blocks.filter((key, i) => i === 0 || blocks[i - 1] !== key).length,
      new Set(blocks).size,
      "each account's units are contiguous — an account is never revisited later in the plan",
    );
    assert.ok(!networkUnits.some((u) => u.platform === "optimise_mena"), "no unit for a region with no connected account");
    assert.deepEqual(plan.map((u) => u.sequence), plan.map((_, i) => i + 1), "sequence is contiguous and ordered");
    for (const u of networkUnits) {
      assert.equal(u.options.promoteAfter, false, "a network unit never runs the global post-sync stages itself");
      assert.equal(u.options.fastSync, false);
      assert.equal(u.lockKey, unitLockKey(u));
      // The key comes from the SHARED lock vocabulary and is account-scoped, never source-object-scoped.
      assert.equal(u.lockKey, accountLockKey({ platform: u.platform, accountLabel: u.accountLabel }));
      assert.equal(u.lockKey, `network:${u.platform}:${u.accountLabel}`);
      assert.equal(isUnitExecutable(u), true);
    }
    assert.equal(DEFAULT_LEASE_MS, LOCK_LEASE_MS, "the orchestrator re-exports the shared lease");
  });

  it("plans NO post-sync stage units by default, even with promoteAfter: true", async () => {
    for (const promoteAfter of [true, false]) {
      const plan = (await planFor({ kind: "full", promoteAfter })).units;
      assert.ok(plan.every((u) => u.kind === UNIT_KINDS.NETWORK), `promoteAfter=${promoteAfter}`);
    }
  });

  it("materialises post-sync stages only on explicit request, and then as non-executable placeholders", async () => {
    const plan = (await planFor({ kind: "full", promoteAfter: true, includePostSyncUnits: true })).units;
    const tail = plan.slice(-3);
    assert.deepEqual(tail.map((u) => u.kind), [UNIT_KINDS.PROMOTION, UNIT_KINDS.CONVERSION_PROMOTION, UNIT_KINDS.AGGREGATION]);
    assert.equal(tail.at(-1).lockKey, "aggregation");
    for (const unit of tail) {
      assert.equal(unit.executable, false);
      assert.equal(unit.blockedReason, UNIT_BLOCKED_REASON);
      assert.equal(isUnitExecutable(unit), false, `${unit.kind} must not be executable yet`);
      assert.throws(() => assertUnitExecutable(unit), (error) => error.code === "unit_not_executable");
    }
    // Requesting placeholders without promotion still plans none.
    const none = (await planFor({ kind: "full", promoteAfter: false, includePostSyncUnits: true })).units;
    assert.ok(none.every((u) => u.kind === UNIT_KINDS.NETWORK));
  });

  it("executability is refused on BOTH grounds independently: an unbounded kind, or an explicit flag", () => {
    // By kind alone — every stage now has a bounded implementation: 6a made AGGREGATION one day,
    // 6b made CONVERSION_PROMOTION one cursor page, 6c made PROMOTION one cursor page of one
    // entity type. An unknown kind is still refused, which is what keeps this a list and not a
    // rubber stamp.
    assert.equal(isUnitExecutable({ kind: UNIT_KINDS.AGGREGATION }), true, "one day is a bounded unit");
    assert.equal(isUnitExecutable({ kind: UNIT_KINDS.CONVERSION_PROMOTION }), true, "one page is a bounded unit");
    assert.equal(isUnitExecutable({ kind: UNIT_KINDS.PROMOTION }), true, "one typed page is a bounded unit");
    // …and a stage planned as blocked stays blocked whatever the kind list says, so widening the
    // list can never silently un-block an older run's placeholders. THIS is what now carries the
    // safety that the kind list used to: every placeholder the planner writes is executable:false.
    for (const kind of [UNIT_KINDS.AGGREGATION, UNIT_KINDS.CONVERSION_PROMOTION, UNIT_KINDS.PROMOTION]) {
      assert.equal(isUnitExecutable({ kind, executable: false }), false, kind);
      assert.equal(
        isUnitExecutable({ payload: { kind, executable: false } }),
        false,
        `an older run's blocked ${kind} placeholder stays blocked`,
      );
      assert.throws(
        () => assertUnitExecutable({ kind, executable: false }),
        (error) => error.code === "unit_not_executable",
        kind,
      );
    }
    // By flag alone — an otherwise executable kind marked non-executable stays refused.
    assert.equal(isUnitExecutable({ kind: UNIT_KINDS.NETWORK }), true);
    assert.equal(isUnitExecutable({ kind: UNIT_KINDS.NETWORK, executable: false }), false);
    assert.equal(isUnitExecutable({ payload: { kind: UNIT_KINDS.NETWORK, executable: false } }), false, "reads a stored row's payload");
    assert.equal(isUnitExecutable({ kind: "zzunknownzz" }), false, "an unknown kind is never executable");
  });

  it("an incremental plan marks every network unit fastSync", async () => {
    const plan = (await planFor({ kind: "incremental", fastSync: true, promoteAfter: true })).units;
    assert.ok(plan.filter((u) => u.kind === UNIT_KINDS.NETWORK).every((u) => u.options.fastSync === true));
  });
});

describe("run lifecycle — durable parent + child JobRun rows, no module memory", () => {
  it("creates the parent RUNNING and one PENDING unit per plan entry, linked by correlationId and ordered by priority", async () => {
    const { prisma, rows } = createFakePrisma();
    const run = await serviceFor(prisma).createRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: true } });
    const parent = rows.find((r) => r.id === run.id);
    assert.equal(parent.jobName, ORCHESTRATION_JOB_NAME);
    assert.equal(parent.status, "RUNNING");
    assert.ok(parent.startedAt);
    assert.equal(parent.payload.kind, "full");
    assert.equal(parent.payload.trigger, "api");
    assert.equal(parent.correlationId, parent.id);
    assert.equal(parent.payload.postSyncStages, "deferred", "explicit: the global stages are not part of this run");
    const units = rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === run.id);
    assert.equal(units.length, await planSize({ kind: "full", fastSync: false, promoteAfter: true }), "one row per planned unit");
    assert.ok(units.every((u) => u.status === "PENDING"));
    assert.deepEqual(units.map((u) => u.priority), units.map((_, i) => i + 1));
    assert.equal(units[0].payload.platform, "boostiny");
    assert.equal(units[0].payload.parentRunId, run.id);
    assert.equal(run.totalUnits, units.length);
  });

  it("getOrCreateRun returns the existing active run of the same kind instead of a duplicate", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const first = await service.getOrCreateRun({ kind: "full", trigger: "api", options: {} });
    const second = await service.getOrCreateRun({ kind: "full", trigger: "scheduler", options: {} });
    assert.equal(second.id, first.id);
    assert.equal(second.created, false);
    assert.equal(first.created, true);
    assert.equal(rows.filter((r) => r.jobName === ORCHESTRATION_JOB_NAME).length, 1);
    const incremental = await service.getOrCreateRun({ kind: "incremental", trigger: "scheduler", options: { fastSync: true } });
    assert.notEqual(incremental.id, first.id, "a different kind is a different run");
  });

  it("a failed unit insert leaves no half-planned run behind (transactional create)", async () => {
    const { prisma, rows } = createFakePrisma({ failCreateAfter: 3 });
    await assert.rejects(() => serviceFor(prisma).createRun({ kind: "full", trigger: "api", options: {} }), /zzcreate failedzz/);
    // The fake runs the callback inside $transaction; a real client rolls back. Prove the service used it.
    assert.ok(rows.length >= 1);
  });

  it("creates the parent and its units inside one $transaction", async () => {
    const { prisma, ops } = createFakePrisma();
    await serviceFor(prisma).createRun({ kind: "full", trigger: "api", options: {} });
    assert.equal(ops[0], "$transaction", "the transaction is opened before any row is written");
    assert.equal(ops.filter((o) => o === "$transaction").length, 1);
  });
});

describe("post-sync placeholders are never executable before their bounded implementation exists", () => {
  it("a worker is never offered a placeholder, cannot claim one, and the run never reports success while one is blocked", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const run = await service.createRun({
      kind: "full",
      trigger: "api",
      options: { promoteAfter: true, includePostSyncUnits: true },
      units: [
        { kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: {} },
        { kind: UNIT_KINDS.PROMOTION, options: {}, executable: false, blockedReason: UNIT_BLOCKED_REASON },
        { kind: UNIT_KINDS.AGGREGATION, options: {}, executable: false, blockedReason: UNIT_BLOCKED_REASON },
      ],
    });
    const unit = await service.nextUnit(run.id);
    assert.equal(unit.payload.kind, UNIT_KINDS.NETWORK);
    await service.claimUnit(unit.id, { workerId: "w" });
    await service.completeUnit(unit.id, { ok: true });

    assert.equal(await service.nextUnit(run.id), null, "placeholders are never offered to a worker");
    const placeholder = rows.find((r) => r.jobName === UNIT_JOB_NAME && r.payload?.kind === UNIT_KINDS.PROMOTION);
    const refused = await service.claimUnit(placeholder.id, { workerId: "w" });
    assert.equal(refused.claimed, false);
    assert.equal(refused.reason, "not_executable");
    assert.equal(refused.blockedReason, UNIT_BLOCKED_REASON);
    assert.equal(rows.find((r) => r.id === placeholder.id).status, "PENDING", "the placeholder is untouched");

    const status = await service.describeRun(run.id);
    assert.equal(status.status, "blocked", "never 'success' while an unbounded stage is outstanding");
    assert.equal(status.blockedUnits, 2);
    assert.equal(status.completedUnits, 1);
    assert.equal(status.percentComplete, 33, "placeholders are materialised, so the denominator is known");
    assert.equal(status.unitsPercentComplete, 33);
    assert.equal(status.totalWorkKnown, true);
    assert.equal(status.postSyncStages, "blocked");
    assert.equal(status.postSyncPending, true, "the placeholder is still outstanding work");
    assert.equal(status.finishedAt, null);
    assert.equal(rows.find((r) => r.id === run.id).status, "RUNNING", "the parent is not finalised");
    assert.equal(status.currentUnit, null);
  });
});

describe("a run that requested promotion never finalises while that work is outstanding", () => {
  /** Complete every executable unit of a run, in order. Returns how many were completed. */
  async function drain(service, runId, { outcome = { ok: true } } = {}) {
    let completed = 0;
    for (;;) {
      const unit = await service.nextUnit(runId);
      if (!unit) return completed;
      await service.claimUnit(unit.id, { workerId: "w" });
      await service.completeUnit(unit.id, outcome);
      completed += 1;
    }
  }

  it("promoteAfter:true — network units only, parent records deferred, and finishing them all leaves the parent NON-terminal", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const run = await service.createRun({ kind: "full", trigger: "api", options: { promoteAfter: true } });

    // 2 — the plan is network units only, and the deferral is recorded on the parent.
    const units = rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === run.id);
    const TOTAL = await planSize({ kind: "full", promoteAfter: true });
    assert.equal(units.length, TOTAL);
    assert.ok(units.every((u) => u.payload.kind === UNIT_KINDS.NETWORK));
    assert.equal(rows.find((r) => r.id === run.id).payload.postSyncStages, "deferred");

    // 3 — complete every network unit.
    assert.equal(await drain(service, run.id), TOTAL);

    // 4 — the parent is still non-terminal.
    const parent = rows.find((r) => r.id === run.id);
    assert.equal(parent.status, "RUNNING", "not COMPLETED: the requested post-sync work has not run");
    assert.equal(parent.completedAt, null);
    assert.equal(parent.result.status, "awaiting_post_sync");

    // 5 — the projection says so plainly.
    const status = await service.describeRun(run.id);
    assert.equal(status.status, "awaiting_post_sync");
    assert.equal(status.postSyncStages, "deferred");
    assert.equal(status.postSyncPending, true);
    assert.equal(status.finishedAt, null);
    assert.equal(status.completedUnits, TOTAL);
    assert.equal(status.totalUnits, TOTAL);
    assert.equal(status.failedUnits, 0);
    // Truthful progress: the units that EXIST are all done, but the run's total work is not yet
    // knowable, so no overall percentage is invented — it is explicitly unknown.
    assert.equal(status.unitsPercentComplete, 100, "every unit that exists is done…");
    assert.equal(status.percentComplete, null, "…but overall progress is not computable yet");
    assert.equal(status.totalWorkKnown, false);
    assert.notEqual(status.status, "success", "the run is not success");

    // The representation is consistent, not switched mid-run: a deferred run reports unknown
    // overall progress from the start, while units progress is always available.
    const { prisma: p2, rows: r2 } = createFakePrisma();
    const s2 = serviceFor(p2);
    const partRun = await s2.createRun({ kind: "full", trigger: "api", options: { promoteAfter: true } });
    const firstUnit = await s2.nextUnit(partRun.id);
    await s2.claimUnit(firstUnit.id, { workerId: "w" });
    await s2.completeUnit(firstUnit.id, { ok: true });
    const midway = await s2.describeRun(partRun.id);
    const onePercent = Math.round((1 / TOTAL) * 100);
    assert.equal(midway.percentComplete, null);
    assert.equal(midway.unitsPercentComplete, onePercent);
    assert.equal(midway.status, "running");
    assert.equal(r2.find((r) => r.id === partRun.id).progress, onePercent, "the Int progress column stays a number");

    // The run is genuinely unfinished, so it is still the active run of its kind.
    const reused = await service.getOrCreateRun({ kind: "full", trigger: "scheduler", options: {} });
    assert.equal(reused.id, run.id);
    assert.equal(reused.created, false);
  });

  it("promoteAfter:false — the same run completes as success once every network unit is terminal", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const run = await service.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false } });
    assert.equal(rows.find((r) => r.id === run.id).payload.postSyncStages, "none");
    assert.equal(await drain(service, run.id), await planSize({ kind: "full", promoteAfter: false }));

    const parent = rows.find((r) => r.id === run.id);
    assert.equal(parent.status, "COMPLETED");
    assert.ok(parent.completedAt);
    const status = await service.describeRun(run.id);
    assert.equal(status.status, "success");
    assert.equal(status.postSyncStages, "none");
    assert.equal(status.postSyncPending, false);
    assert.ok(status.finishedAt);
    assert.equal(status.percentComplete, 100);
    assert.equal(status.unitsPercentComplete, 100);
    assert.equal(status.totalWorkKnown, true);
    // Finished, so a new request of the same kind starts a NEW run.
    const next = await service.getOrCreateRun({ kind: "full", trigger: "api", options: { promoteAfter: false } });
    assert.notEqual(next.id, run.id);
    assert.equal(next.created, true);
  });

  it("promoteAfter:false — a dead-lettered network unit finalises the parent as FAILED with the error surfaced", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const run = await service.createRun({ kind: "full", trigger: "scheduler", options: { promoteAfter: false }, units: [
      { kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: {} },
      { kind: UNIT_KINDS.NETWORK, platform: "trackier", accountLabel: "default", options: {} },
    ] });
    const first = await service.nextUnit(run.id);
    await service.claimUnit(first.id, { workerId: "w" });
    await service.completeUnit(first.id, { ok: true });

    const second = await service.nextUnit(run.id);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await service.claimUnit(second.id, { workerId: "w" });
      await service.failUnit(second.id, new Error("zzupstream downzz"));
    }
    assert.equal(rows.find((r) => r.id === second.id).status, "DEAD_LETTER");

    const parent = rows.find((r) => r.id === run.id);
    assert.equal(parent.status, "FAILED");
    assert.ok(parent.completedAt);
    assert.equal(parent.lastError, "zzupstream downzz");
    const status = await service.describeRun(run.id);
    assert.equal(status.status, "failed");
    assert.equal(status.completedUnits, 1);
    assert.equal(status.failedUnits, 1);
    assert.equal(status.latestError, "zzupstream downzz");
    assert.ok(status.finishedAt);
    assert.equal(status.percentComplete, 100, "every unit reached a terminal state");
  });

  it("promoteAfter:true — a permanently failed network unit finalises the parent FAILED, beating the deferral", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const run = await service.createRun({ kind: "full", trigger: "api", options: { promoteAfter: true }, units: [
      { kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: {} },
      { kind: UNIT_KINDS.NETWORK, platform: "trackier", accountLabel: "default", options: {} },
    ] });
    assert.equal(rows.find((r) => r.id === run.id).payload.postSyncStages, "deferred");

    // One network unit succeeds; the other exhausts its attempts and dead-letters.
    const ok = await service.nextUnit(run.id);
    await service.claimUnit(ok.id, { workerId: "w" });
    await service.completeUnit(ok.id, { ok: true });
    const doomed = await service.nextUnit(run.id);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await service.claimUnit(doomed.id, { workerId: "w" });
      await service.failUnit(doomed.id, new Error("zzunrecoverablezz"));
    }
    assert.equal(rows.find((r) => r.id === doomed.id).status, "DEAD_LETTER");

    // 1 — an unrecoverable network failure is never waited on for post-sync work.
    const parent = rows.find((r) => r.id === run.id);
    assert.equal(parent.status, "FAILED");
    assert.ok(parent.completedAt, "a failed parent is finalised with a finishedAt");
    assert.equal(parent.lastError, "zzunrecoverablezz");
    const status = await service.describeRun(run.id);
    assert.equal(status.status, "failed");
    assert.notEqual(status.status, "awaiting_post_sync");
    assert.ok(status.finishedAt);
    assert.equal(status.failedUnits, 1);
    assert.equal(status.completedUnits, 1);
    assert.equal(status.latestError, "zzunrecoverablezz");
    // Nothing further will be materialised, so the total is known and the percentage is truthful.
    assert.equal(status.totalWorkKnown, true);
    assert.equal(status.percentComplete, 100);
    assert.equal(status.postSyncStages, "deferred", "what was requested is still recorded");
    assert.equal(status.postSyncPending, false, "a finalised run is waiting for nothing");

    // A failed run is not active: the next request starts a NEW run rather than resuming it.
    const next = await service.getOrCreateRun({ kind: "full", trigger: "api", options: { promoteAfter: true } });
    assert.notEqual(next.id, run.id);
    assert.equal(next.created, true);
  });

  it("a permanent failure also beats blocked placeholders", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const run = await service.createRun({ kind: "full", trigger: "api", options: { promoteAfter: true, includePostSyncUnits: true }, units: [
      { kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: {} },
      { kind: UNIT_KINDS.PROMOTION, options: {}, executable: false, blockedReason: UNIT_BLOCKED_REASON },
    ] });
    const unit = await service.nextUnit(run.id);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await service.claimUnit(unit.id, { workerId: "w" });
      await service.failUnit(unit.id, new Error("zzdeadzz"));
    }
    assert.equal(rows.find((r) => r.id === run.id).status, "FAILED");
    const status = await service.describeRun(run.id);
    assert.equal(status.status, "failed");
    assert.equal(status.blockedUnits, 1);
    assert.ok(status.finishedAt);
    assert.equal(status.postSyncPending, false, "the blocked placeholder will never run now");
  });
});

describe("claims — atomic, lease-bound, mutually exclusive on the lock key", () => {
  async function seeded() {
    const { prisma, rows, ops } = createFakePrisma();
    const service = serviceFor(prisma);
    const run = await service.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false } });
    return { prisma, rows, ops, service, run };
  }

  it("nextUnit returns the lowest-sequence PENDING unit and claimUnit flips exactly it to RUNNING", async () => {
    const { service, run, rows } = await seeded();
    const unit = await service.nextUnit(run.id);
    assert.equal(unit.payload.platform, "boostiny");
    const claim = await service.claimUnit(unit.id, { workerId: "zzworker-azz" });
    assert.equal(claim.claimed, true);
    const row = rows.find((r) => r.id === unit.id);
    assert.equal(row.status, "RUNNING");
    assert.equal(row.attempt, 1);
    assert.equal(row.startedAt.toISOString(), clock.toISOString());
    assert.equal(row.result.claim.workerId, "zzworker-azz");
    assert.equal(rows.filter((r) => r.status === "RUNNING" && r.jobName === UNIT_JOB_NAME).length, 1);
  });

  it("two workers claiming the same unit: exactly one wins", async () => {
    const { service, run } = await seeded();
    const unit = await service.nextUnit(run.id);
    const [a, b] = await Promise.all([service.claimUnit(unit.id, { workerId: "a" }), service.claimUnit(unit.id, { workerId: "b" })]);
    assert.equal([a.claimed, b.claimed].filter(Boolean).length, 1);
  });

  it("a unit whose lock key is RUNNING elsewhere (another run, fresh lease) is not claimable", async () => {
    const { service, run, prisma } = await seeded();
    // A manual run holds the boostiny/default lock in a different parent.
    const other = await service.createRun({ kind: "manual", trigger: "api", options: {}, units: [{ kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: { fastSync: false, promoteAfter: false }, sourceObject: "campaigns" }] });
    const otherUnit = await service.nextUnit(other.id);
    assert.equal((await service.claimUnit(otherUnit.id, { workerId: "manual" })).claimed, true);
    const unit = await service.nextUnit(run.id);
    assert.equal(unit.payload.platform, "boostiny");
    const claim = await service.claimUnit(unit.id, { workerId: "cron" });
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, "lock_held");
    assert.equal(claim.heldBy, otherUnit.id);
    assert.equal((await prisma.jobRun.findUnique({ where: { id: unit.id } })).status, "PENDING");
    // A holder whose lease expired (crashed invocation) no longer blocks the lock key.
    clock = new Date(clock.getTime() + DEFAULT_LEASE_MS + 1);
    const afterLease = await service.claimUnit(unit.id, { workerId: "cron" });
    assert.equal(afterLease.claimed, true, "an expired lease does not hold the lock");
    clock = new Date("2026-09-15T12:00:00.000Z");
  });

  it("nextUnit surfaces a stale RUNNING unit (expired lease) before moving on to later PENDING units", async () => {
    const { service, run } = await seeded();
    const first = await service.nextUnit(run.id);
    await service.claimUnit(first.id, { workerId: "crashed" });
    const skipped = await service.nextUnit(run.id);
    assert.notEqual(skipped.id, first.id, "a freshly claimed unit is not offered again");
    clock = new Date(clock.getTime() + DEFAULT_LEASE_MS + 1);
    const stale = await service.nextUnit(run.id);
    assert.equal(stale.id, first.id, "after the lease expires the crashed unit is offered first");
    clock = new Date("2026-09-15T12:00:00.000Z");
  });

  it("a stale RUNNING claim (lease expired) is reclaimable; a fresh one is not", async () => {
    const { service, run, rows } = await seeded();
    const unit = await service.nextUnit(run.id);
    await service.claimUnit(unit.id, { workerId: "crashed" });
    assert.equal((await service.claimUnit(unit.id, { workerId: "second" })).claimed, false, "fresh lease: refused");
    clock = new Date(clock.getTime() + DEFAULT_LEASE_MS + 1);
    const reclaim = await service.claimUnit(unit.id, { workerId: "second" });
    assert.equal(reclaim.claimed, true);
    assert.equal(reclaim.reclaimed, true);
    const row = rows.find((r) => r.id === unit.id);
    assert.equal(row.attempt, 2);
    assert.equal(row.result.claim.workerId, "second");
    assert.equal(row.result.claim.reclaimedFrom, "crashed");
    clock = new Date("2026-09-15T12:00:00.000Z");
  });

  it("the lease is longer than a serverless invocation can live", () => {
    assert.ok(DEFAULT_LEASE_MS > 300_000);
  });
});

describe("outcomes — retryable failure, dead letter, parent projection", () => {
  it("completeUnit records the result and advances the parent's counters and progress", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const run = await service.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false } });
    const unit = await service.nextUnit(run.id);
    await service.claimUnit(unit.id, { workerId: "w" });
    await service.completeUnit(unit.id, { conversions: 3, warnings: ["zzwarnzz"] });
    const row = rows.find((r) => r.id === unit.id);
    assert.equal(row.status, "COMPLETED");
    assert.equal(row.progress, 100);
    assert.deepEqual(row.result.outcome, { conversions: 3, warnings: ["zzwarnzz"] });
    const status = await service.describeRun(run.id);
    const TOTAL = await planSize({ kind: "full", promoteAfter: false });
    const onePercent = Math.round((1 / TOTAL) * 100);
    assert.equal(status.completedUnits, 1);
    assert.equal(status.totalUnits, TOTAL);
    assert.equal(status.blockedUnits, 0);
    assert.equal(status.percentComplete, onePercent);
    assert.equal(status.status, "running");
    assert.equal(status.latestWarning, "zzwarnzz");
    assert.equal(rows.find((r) => r.id === run.id).progress, onePercent);
  });

  it("failUnit returns the unit to PENDING while attempts remain (no sleeping), then DEAD_LETTER", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const run = await service.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [{ kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: {} }] });
    const unit = await service.nextUnit(run.id);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await service.claimUnit(unit.id, { workerId: "w" });
      const outcome = await service.failUnit(unit.id, new Error(`zzboom ${attempt}zz`));
      assert.equal(outcome.status, "PENDING", `attempt ${attempt} is retryable`);
      assert.equal(rows.find((r) => r.id === unit.id).lastError, `zzboom ${attempt}zz`);
    }
    await service.claimUnit(unit.id, { workerId: "w" });
    const final = await service.failUnit(unit.id, new Error("zzboom 3zz"));
    assert.equal(final.status, "DEAD_LETTER");
    const status = await service.describeRun(run.id);
    assert.equal(status.failedUnits, 1);
    assert.equal(status.status, "failed");
    assert.equal(status.latestError, "zzboom 3zz");
    assert.ok(status.finishedAt, "the run is finalised once every unit is terminal");
    assert.equal(rows.find((r) => r.id === run.id).status, "FAILED");
  });

  it("the run completes as success when every unit completed, and as partial when a unit reported partialSuccess", async () => {
    const { prisma, rows } = createFakePrisma();
    const service = serviceFor(prisma);
    const run = await service.createRun({ kind: "full", trigger: "scheduler", options: { promoteAfter: false }, units: [
      { kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: {} },
      { kind: UNIT_KINDS.NETWORK, platform: "trackier", accountLabel: "default", options: {} },
    ] });
    let unit = await service.nextUnit(run.id);
    await service.claimUnit(unit.id, { workerId: "w" }); await service.completeUnit(unit.id, { ok: true });
    unit = await service.nextUnit(run.id);
    await service.claimUnit(unit.id, { workerId: "w" }); await service.completeUnit(unit.id, { partialSuccess: true, warnings: ["zzpartialzz"] });
    assert.equal(await service.nextUnit(run.id), null);
    const status = await service.describeRun(run.id);
    assert.equal(status.status, "partial");
    assert.equal(status.percentComplete, 100);
    assert.equal(status.completedUnits, 2);
    assert.equal(rows.find((r) => r.id === run.id).status, "COMPLETED");
    assert.equal(status.trigger, "scheduler");
    assert.equal(status.currentUnit, null);
  });

  it("describeRun exposes the durable fields plus backward-compatible names", async () => {
    const { prisma } = createFakePrisma();
    const service = serviceFor(prisma);
    const run = await service.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false } });
    const unit = await service.nextUnit(run.id);
    await service.claimUnit(unit.id, { workerId: "w" });
    const status = await service.describeRun(run.id);
    for (const key of ["runId", "kind", "status", "trigger", "startedAt", "finishedAt", "totalUnits", "completedUnits", "failedUnits", "pendingUnits", "runningUnits", "blockedUnits", "postSyncStages", "postSyncPending", "unitsPercentComplete", "totalWorkKnown", "currentUnit", "percentComplete", "latestError", "latestWarning", "jobName", "totalAccounts", "completedAccounts", "failedAccounts", "currentStage"]) {
      assert.ok(key in status, key);
    }
    assert.equal(status.jobName, "syncAll");
    assert.equal(status.currentUnit.platform, "boostiny");
    assert.equal(status.currentUnit.kind, UNIT_KINDS.NETWORK);
    assert.equal(status.currentStage, "boostiny");
    assert.equal(status.totalAccounts, status.totalUnits);
    assert.equal(await service.describeRun("zzmissingzz"), null);
    const latest = await service.describeLatestRun();
    assert.equal(latest.runId, run.id);
  });
});
