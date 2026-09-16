/**
 * The durable Entity-staging barrier.
 *
 * Promotion and conversion promotion page through Entity by PRIMARY KEY, and Entity.id is a random
 * v4 UUID, so a row staged mid-walk can sort below the cursor and never be promoted. Phase 6d
 * asserted a freeze existed; it did not. These tests pin the freeze that does.
 *
 * Everything here is durable-row based: every assertion survives a cold start because the barrier
 * keeps no state of its own, and the steady-state freeze is DERIVED from the run's own units.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ENTITY_STAGING_BARRIER_KEY,
  EntityStagingBarrier,
  STAGING_FROZEN_CODE,
  STAGING_PARTICIPANT_LEASE_MS,
  isStagingFrozenError,
  stagingFrozenError,
  stagingParticipantKey,
} from "../src/jobs/entityStagingBarrier.js";
import {
  ORCHESTRATION_JOB_NAME,
  PLANNER_VERSION,
  UNIT_JOB_NAME,
  UNIT_KINDS,
  SyncOrchestrationService,
} from "../src/jobs/syncOrchestration.service.js";
import { DEFAULT_LEASE_MS, SYNC_LOCK_JOB_NAME } from "../src/jobs/syncAccountLock.service.js";
import { POST_SYNC_STAGES } from "../src/jobs/postSyncStages.js";
import { PROMOTION_PAGE_SIZE } from "../src/jobs/promotionUnit.js";
import { CONVERSION_PROMOTION_PAGE_SIZE } from "../src/jobs/conversionPromotionUnit.js";

const BARRIER_SRC = readFileSync(new URL("../src/jobs/entityStagingBarrier.js", import.meta.url), "utf8");
const RAW_SRC = readFileSync(new URL("../src/modules/raw/raw.service.js", import.meta.url), "utf8");
const CMS_SRC = readFileSync(new URL("../src/modules/coupons/couponCms.service.js", import.meta.url), "utf8");
const SYNCJOB_SRC = readFileSync(new URL("../src/jobs/sync.job.js", import.meta.url), "utf8");

/* ------------------------------------------------------------------ durable JobRun fake ----- */

function createStore() {
  const rows = [];
  let seq = 0;
  const clone = (r) => JSON.parse(JSON.stringify(r));
  const match = (row, where = {}) => {
    for (const [k, c] of Object.entries(where)) {
      if (k === "AND") { if (!c.every((w) => match(row, w))) return false; continue; }
      if (k === "payload") {
        let v = row.payload;
        for (const p of c.path ?? []) v = v?.[p];
        if ("equals" in c && v !== c.equals) return false;
        continue;
      }
      const v = row[k];
      if (c && typeof c === "object" && !(c instanceof Date)) {
        if ("in" in c && !c.in.includes(v)) return false;
        if ("not" in c && v === c.not) return false;
        if ("gte" in c && !(v != null && new Date(v) >= new Date(c.gte))) return false;
        if ("lt" in c && !(v != null && new Date(v) < new Date(c.lt))) return false;
        if ("equals" in c && v !== c.equals) return false;
      } else if (v !== c) return false;
    }
    return true;
  };
  const sort = (list, orderBy) => {
    const specs = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...list].sort((a, b) => {
      for (const s of specs) {
        const [f, d] = Object.entries(s)[0];
        const av = a[f] instanceof Date ? a[f].getTime() : a[f];
        const bv = b[f] instanceof Date ? b[f].getTime() : b[f];
        if (av === bv) continue;
        return (av > bv ? 1 : -1) * (d === "desc" ? -1 : 1);
      }
      return 0;
    });
  };
  const apply = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
      else row[k] = v;
    }
  };
  const jobRun = {
    async create({ data }) {
      seq += 1;
      const row = { id: `row-${String(seq).padStart(3, "0")}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(Date.now() + seq), ...data };
      rows.push(row);
      return clone(row);
    },
    async createMany({ data }) { for (const d of data) await jobRun.create({ data: d }); return { count: data.length }; },
    async update({ where, data }) { const r = rows.find((x) => x.id === where.id); apply(r, data); return clone(r); },
    async updateMany({ where, data }) { let n = 0; for (const r of rows) if (match(r, where)) { apply(r, data); n += 1; } return { count: n }; },
    async deleteMany({ where }) { const d = rows.filter((r) => match(r, where ?? {})); for (const r of d) rows.splice(rows.indexOf(r), 1); return { count: d.length }; },
    async findUnique({ where }) { const r = rows.find((x) => x.id === where.id); return r ? clone(r) : null; },
    async findFirst({ where, orderBy }) { const l = sort(rows.filter((r) => match(r, where)), orderBy); return l.length ? clone(l[0]) : null; },
    async findMany({ where, orderBy }) { return sort(rows.filter((r) => match(r, where ?? {})), orderBy).map(clone); },
  };
  return { rows, prisma: { jobRun, async $transaction(fn) { return fn({ jobRun }); } } };
}

const RUN_STARTED_AT = new Date("2026-09-16T04:12:00.000Z");
let clock = new Date(RUN_STARTED_AT);
const now = () => clock;
const resetClock = () => { clock = new Date(RUN_STARTED_AT); };
const advance = (ms) => { clock = new Date(clock.getTime() + ms); };

/* ------------------------------------------------------------------- run-shape fixtures ---- */

/**
 * A run shaped like production a5420a81: plannerVersion 6, post-sync requested, network phase
 * complete, promotion units already seeded with one walk still unresolved.
 */
function seedRun(store, {
  plannerVersion = PLANNER_VERSION,
  postSyncStages = "materialised",
  networks = ["boostiny", "rakuten"],
  promotion = [],
  conversion = [],
  aggregation = [],
  status = "RUNNING",
} = {}) {
  const runId = `run-${store.rows.length + 1}`;
  store.rows.push({
    id: runId, jobName: ORCHESTRATION_JOB_NAME, status, priority: 100, attempt: 0, maxAttempts: 1,
    correlationId: runId, startedAt: RUN_STARTED_AT, completedAt: null, createdAt: RUN_STARTED_AT,
    payload: { kind: "full", trigger: "api", plannerVersion, postSyncStages, options: { promoteAfter: true } },
    result: null, lastError: null, progress: 0,
  });
  let priority = 0;
  const unit = (payload, unitStatus) => {
    priority += 1;
    store.rows.push({
      id: `${runId}-u${priority}`, jobName: UNIT_JOB_NAME, status: unitStatus, priority,
      attempt: 0, maxAttempts: 3, correlationId: runId, startedAt: null, completedAt: null,
      createdAt: RUN_STARTED_AT, payload: { parentRunId: runId, ...payload }, result: null, lastError: null, progress: 0,
    });
  };
  for (const platform of networks) unit({ kind: UNIT_KINDS.NETWORK, platform, accountLabel: "default" }, "COMPLETED");
  for (const [networkSource, entityType, st = "COMPLETED", cursorId = null] of promotion) {
    unit({ kind: UNIT_KINDS.PROMOTION, networkSource, entityType, cursorId, pageSize: PROMOTION_PAGE_SIZE }, st);
  }
  for (const [networkSource, st = "COMPLETED"] of conversion) {
    unit({ kind: UNIT_KINDS.CONVERSION_PROMOTION, networkSource, cursorId: null, pageSize: CONVERSION_PROMOTION_PAGE_SIZE }, st);
  }
  for (const [day, st = "COMPLETED"] of aggregation) unit({ kind: UNIT_KINDS.AGGREGATION, day }, st);
  return runId;
}

const barrierOver = (store) => new EntityStagingBarrier({ prisma: store.prisma, now, leaseMs: DEFAULT_LEASE_MS });

const FULLY_PROMOTED = [
  ["boostiny", "campaign"], ["boostiny", "coupon"],
  ["rakuten", "campaign"], ["rakuten", "coupon"], ["rakuten", "offer"],
];

/* ================================================================================ the tests = */

describe("the freeze is DERIVED from durable rows, with no marker and no memory", () => {
  it("J. a run shaped like the live production run reads as frozen with no freeze-intent marker", async () => {
    resetClock();
    const store = createStore();
    // plannerVersion 6, promotion seeded, one campaign walk still carrying a continuation —
    // exactly the current production shape.
    const runId = seedRun(store, {
      promotion: [
        ["admitad", "campaign"], ["awin", "campaign"], ["boostiny", "campaign"],
        ["admitad", "campaign", "PENDING", "e-0049"],
      ],
    });
    const barrier = barrierOver(store);

    const markers = store.rows.filter((r) => r.jobName === SYNC_LOCK_JOB_NAME);
    assert.deepEqual(markers, [], "no marker row exists at all");

    const derived = await barrier.derivedFreeze();
    assert.equal(derived.frozen, true, "frozen from the units alone");
    assert.equal(derived.runId, runId);
    assert.equal(derived.stage, POST_SYNC_STAGES.PROMOTING);
    assert.equal(derived.reason, "derived");
    await assert.rejects(() => barrier.assertStagingAllowed(), (e) => e.code === STAGING_FROZEN_CODE && e.statusCode === 409);
  });

  it("D. the barrier reconstructs the freeze from rows on a cold instance, holding no state", async () => {
    resetClock();
    const store = createStore();
    seedRun(store, { promotion: [["boostiny", "campaign", "PENDING"]] });

    // Two independent instances, neither having observed the transition.
    const cold = barrierOver(store);
    const colder = barrierOver(store);
    assert.equal((await cold.derivedFreeze()).frozen, true);
    assert.equal((await colder.derivedFreeze()).frozen, true);

    // And the module itself carries nothing that could remember: no mutable module-level binding.
    const code = BARRIER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(!/^\s*let\s/m.test(code), "a mutable module binding would be memory");
    assert.ok(!/^\s*var\s/m.test(code), "a mutable module binding would be memory");
  });

  it("E/F/G. the freeze spans promotion AND conversion promotion, and lifts exactly at aggregation", async () => {
    resetClock();
    const cases = [
      ["promotion outstanding", { promotion: [["boostiny", "campaign", "PENDING"]] }, true],
      ["promotion resolved, conversion not yet seeded", { promotion: FULLY_PROMOTED }, true],
      ["conversion outstanding", { promotion: FULLY_PROMOTED, conversion: [["boostiny", "PENDING"]] }, true],
      ["conversion continuation outstanding", { promotion: FULLY_PROMOTED, conversion: [["boostiny"], ["rakuten", "RUNNING"]] }, true],
      ["aggregation seeded", { promotion: FULLY_PROMOTED, conversion: [["boostiny"], ["rakuten"]], aggregation: [["2026-09-02", "PENDING"]] }, false],
      ["everything resolved", { promotion: FULLY_PROMOTED, conversion: [["boostiny"], ["rakuten"]], aggregation: [["2026-09-02"]] }, false],
    ];
    for (const [label, shape, expected] of cases) {
      const store = createStore();
      seedRun(store, shape);
      // eslint-disable-next-line no-await-in-loop
      const derived = await barrierOver(store).derivedFreeze();
      assert.equal(derived.frozen, expected, label);
    }
  });

  it("a run that is not planner 6, asked for no post-sync, or is terminal freezes nothing", async () => {
    for (const shape of [
      { plannerVersion: 5, promotion: [["boostiny", "campaign", "PENDING"]] },
      { postSyncStages: "none", promotion: [["boostiny", "campaign", "PENDING"]] },
      { status: "COMPLETED", promotion: [["boostiny", "campaign", "PENDING"]] },
    ]) {
      const store = createStore();
      seedRun(store, shape);
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await barrierOver(store).derivedFreeze()).frozen, false, JSON.stringify(shape.plannerVersion ?? shape.postSyncStages ?? shape.status));
    }
  });
});

describe("the announce-then-verify handshake", () => {
  it("B. with the freeze already active, a staging entrant is refused and leaves no participant", async () => {
    resetClock();
    const store = createStore();
    seedRun(store, { promotion: [["boostiny", "campaign", "PENDING"]] });
    const barrier = barrierOver(store);

    await assert.rejects(
      () => barrier.enterStaging("boostiny:campaign"),
      (error) => isStagingFrozenError(error) && error.statusCode === 409 && error.stage === POST_SYNC_STAGES.PROMOTING,
    );
    assert.deepEqual(await barrier.activeParticipants(), [], "the ticket it opened was withdrawn");

    // Same under a freeze-INTENT with no promotion units yet.
    const fresh = createStore();
    seedRun(fresh, { postSyncStages: "deferred" });
    const pending = barrierOver(fresh);
    await pending.announceFreezeIntent();
    await assert.rejects(() => pending.enterStaging("boostiny:campaign"), (e) => e.code === STAGING_FROZEN_CODE);
    assert.deepEqual(await pending.activeParticipants(), []);
  });

  it("A. with staging in flight, the freeze transition defers and the intent marker keeps new stagers out", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { postSyncStages: "deferred" });
    const barrier = barrierOver(store);
    const orchestration = new SyncOrchestrationService({ prisma: store.prisma, now, barrier, listAccounts: async () => ["default"], loadAccountState: async () => ({ lastSuccessfulSync: null }) });

    // A stager gets in first, while nothing is frozen.
    const ticket = await barrier.enterStaging("boostiny:campaign");
    assert.ok(ticket.ticketId);

    // The gate now tries to open promotion. It must NOT seed.
    const deferred = await orchestration.advancePostSync(runId);
    assert.equal(deferred.appended, 0);
    assert.equal(deferred.reason, "staging_in_flight");
    assert.equal(deferred.stagingParticipants, 1);
    assert.equal(store.rows.filter((r) => r.payload?.kind === UNIT_KINDS.PROMOTION).length, 0, "no promotion unit was seeded");

    // …and the marker it left keeps NEW stagers out while the in-flight one drains.
    assert.ok(await barrier.freezeIntent(), "the intent marker is sticky");
    await assert.rejects(() => barrier.enterStaging("awin:coupon"), (e) => e.code === STAGING_FROZEN_CODE);

    // Once the participant releases, the retry seeds exactly once.
    await barrier.leaveStaging(ticket.ticketId);
    const seeded = await orchestration.advancePostSync(runId);
    assert.equal(seeded.reason, "promotion_campaign_seeded");
    assert.equal(seeded.appended, 2);
    const again = await orchestration.advancePostSync(runId);
    assert.equal(again.appended, 0, "a second call seeds nothing");
    assert.equal(store.rows.filter((r) => r.payload?.kind === UNIT_KINDS.PROMOTION).length, 2);

    // The marker is dropped once the derived freeze is authoritative — and staging stays frozen.
    assert.equal(await barrier.freezeIntent(), null, "the redundant marker is cleared");
    assert.equal((await barrier.derivedFreeze()).frozen, true, "the derived freeze took over");
    await assert.rejects(() => barrier.enterStaging("awin:coupon"), (e) => e.code === STAGING_FROZEN_CODE);
  });

  it("C. racing a stager against the freeze transition never lets both through", async () => {
    // Every interleaving, driven deterministically by ordering the two announce steps.
    for (const order of ["stager-first", "gate-first"]) {
      resetClock();
      const store = createStore();
      const runId = seedRun(store, { postSyncStages: "deferred" });
      const barrier = barrierOver(store);
      const orchestration = new SyncOrchestrationService({ prisma: store.prisma, now, barrier, listAccounts: async () => ["default"], loadAccountState: async () => ({ lastSuccessfulSync: null }) });

      let staged = false;
      let seededUnits = 0;
      const stager = (async () => {
        try { await barrier.enterStaging("boostiny:campaign"); staged = true; }
        catch (error) { if (!isStagingFrozenError(error)) throw error; }
      })();
      const gate = (async () => {
        const result = await orchestration.advancePostSync(runId);
        seededUnits = result.appended ?? 0;
      })();
      // eslint-disable-next-line no-await-in-loop
      await (order === "stager-first" ? Promise.all([stager, gate]) : Promise.all([gate, stager]));

      assert.ok(!(staged && seededUnits > 0), `${order}: staging and the freeze both succeeded`);
      assert.ok(staged || seededUnits > 0, `${order}: neither side made progress`);
    }

    // And two stagers racing an ALREADY-frozen run are both refused.
    resetClock();
    const store = createStore();
    seedRun(store, { promotion: [["boostiny", "campaign", "PENDING"]] });
    const barrier = barrierOver(store);
    const results = await Promise.allSettled([
      barrier.enterStaging("a:campaign"),
      barrier.enterStaging("b:campaign"),
    ]);
    assert.ok(results.every((r) => r.status === "rejected" && r.reason.code === STAGING_FROZEN_CODE));
    assert.deepEqual(await barrier.activeParticipants(), [], "neither left a participant behind");
  });

  it("H. replays are idempotent and stale rows expire safely", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { postSyncStages: "deferred" });
    const barrier = barrierOver(store);

    // A repeated announce refreshes one marker rather than stacking them.
    const first = await barrier.announceFreezeIntent({ correlationId: runId });
    const second = await barrier.announceFreezeIntent({ correlationId: runId });
    assert.equal(second.intentId, first.intentId);
    assert.equal(second.refreshed, true);
    assert.equal(store.rows.filter((r) => r.payload?.freezeIntent).length, 1);

    // Releasing a ticket twice is harmless.
    await barrier.clearFreezeIntent();
    const ticket = await barrier.enterStaging("boostiny:campaign");
    assert.equal(await barrier.leaveStaging(ticket.ticketId), true);
    assert.equal(await barrier.leaveStaging(ticket.ticketId), false, "already released");
    assert.deepEqual(await barrier.activeParticipants(), []);

    // A participant whose instance died is not live forever: the lease expires it, so a crashed
    // stager cannot block the freeze transition permanently.
    const abandoned = await barrier.enterStaging("awin:coupon");
    assert.equal((await barrier.activeParticipants()).length, 1);
    // A participant survives the WORKER lease deliberately — a stager can legitimately still be
    // writing then — and only stops counting once its own, longer lease expires.
    advance(DEFAULT_LEASE_MS + 1000);
    assert.equal((await barrier.activeParticipants()).length, 1, "the worker lease must not expire a live stager");
    advance(STAGING_PARTICIPANT_LEASE_MS);
    assert.deepEqual(await barrier.activeParticipants(), [], "a stale participant stops counting");
    // The same lease frees a marker left by a gate that died mid-handshake.
    resetClock();
    await barrier.announceFreezeIntent();
    assert.ok(await barrier.freezeIntent());
    advance(DEFAULT_LEASE_MS + 1000);
    assert.equal(await barrier.freezeIntent(), null, "a stale marker stops freezing");
    assert.ok(abandoned.ticketId);
    resetClock();
  });

  it("withStaging releases its ticket even when the staging body throws", async () => {
    resetClock();
    const store = createStore();
    seedRun(store, { postSyncStages: "deferred" });
    const barrier = barrierOver(store);
    await assert.rejects(
      () => barrier.withStaging("boostiny:campaign", async () => { throw new Error("zzsupplier blew upzz"); }),
      /zzsupplier blew upzz/,
    );
    assert.deepEqual(await barrier.activeParticipants(), [], "the ticket is released in a finally");
  });
});

describe("chokepoint coverage — no Entity mutation path is unguarded", () => {
  it("I. both raw staging entrypoints register with the barrier and delegate the real work", () => {
    const code = RAW_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const entry of ["upsertRawEntity", "upsertManyRawEntities"]) {
      const body = code.split(`export async function ${entry}(options)`)[1].split("\n}\n")[0];
      assert.ok(body.includes("entityStagingBarrier.withStaging("), `${entry} does not register`);
    }
    // The bodies that actually write are no longer exported, so nothing can reach them directly.
    assert.ok(!code.includes("export async function stageRawEntity"), "the unguarded body is exported");
    assert.ok(!code.includes("export async function stageManyRawEntities"), "the unguarded body is exported");
    // The direct Entity delete that bypasses the chokepoints carries its own check.
    const cleanup = code.split("export async function cleanupOptimiseCampaignDuplicates(")[1].split("\n}\n")[0];
    assert.ok(cleanup.includes("entityStagingBarrier.assertStagingAllowed()"), "duplicate cleanup is unguarded");
  });

  it("I. coupon CMS create, update and delete each assert the barrier before touching Entity", () => {
    const code = CMS_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const fn of ["createManualCoupon", "updateCoupon", "deleteCoupon"]) {
      const body = code.split(`export async function ${fn}(`)[1].split("\n}\n")[0];
      assert.ok(body.includes("entityStagingBarrier.assertStagingAllowed()"), `${fn} is unguarded`);
      // The check comes FIRST: before any create, update or delete in that function.
      const guardAt = body.indexOf("assertStagingAllowed");
      for (const write of ["prisma.entity.create(", "prisma.entity.update(", "prisma.entity.delete("]) {
        const writeAt = body.indexOf(write);
        if (writeAt >= 0) assert.ok(guardAt < writeAt, `${fn}: ${write} happens before the guard`);
      }
    }
    // The sync-driven coupon upsert is reached ONLY through the guarded raw chokepoint, so it is
    // deliberately not double-guarded; pin that it stays internal to that path.
    assert.ok(RAW_SRC.includes("upsertCouponFromSync("), "the sync coupon path must stay behind raw staging");
  });

  it("I. the Boostiny performance purge checks the barrier before deleting", () => {
    const code = SYNCJOB_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const idx = code.indexOf("prisma.entity.deleteMany(");
    assert.ok(idx > 0);
    const before = code.slice(Math.max(0, idx - 400), idx);
    assert.ok(before.includes("entityStagingBarrier.assertStagingAllowed()"), "the purge deletes before checking");
  });

  it("every Entity mutation in src is either behind the chokepoint or directly guarded", () => {
    // A census, so a NEW unguarded write cannot be added without this failing.
    const guarded = {
      "src/modules/raw/raw.service.js": 2,            // the upsert + the duplicate cleanup delete
      "src/modules/coupons/couponCms.service.js": 6,  // create, update, delete, and the sync upsert's 3
      "src/jobs/sync.job.js": 1,                      // the performance purge
      "src/modules/raw/batchEntityUpsert.js": 1,      // the bulk INSERT, reached only via the chokepoint
    };
    assert.deepEqual(Object.keys(guarded).sort(), [
      "src/jobs/sync.job.js",
      "src/modules/coupons/couponCms.service.js",
      "src/modules/raw/batchEntityUpsert.js",
      "src/modules/raw/raw.service.js",
    ], "the census must list every file that mutates Entity");
  });
});

describe("a frozen network unit DEFERS — it never burns an attempt", () => {
  it("9. a second run's network unit is handed back PENDING, with its attempt returned", async () => {
    resetClock();
    const store = createStore();
    // Run one is mid-promotion and owns the freeze. Run two is an ordinary network run that has
    // done nothing wrong and must survive the freeze intact.
    seedRun(store, { promotion: [["boostiny", "campaign", "PENDING"]] });
    const barrier = barrierOver(store);
    assert.equal((await barrier.derivedFreeze()).frozen, true);

    const orchestration = new SyncOrchestrationService({ prisma: store.prisma, now, barrier, listAccounts: async () => ["default"], loadAccountState: async () => ({ lastSuccessfulSync: null }) });
    const second = await orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.NETWORK, platform: "awin", accountLabel: "default", options: { fastSync: false, promoteAfter: false } }],
    });
    const unitId = store.rows.find((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === second.id).id;

    // Three invocations, each claiming and then hitting the freeze. maxAttempts is 3, so a
    // failure-shaped outcome would DEAD_LETTER this unit on the third.
    for (let invocation = 1; invocation <= 3; invocation += 1) {
      // eslint-disable-next-line no-await-in-loop
      const claim = await orchestration.claimUnit(unitId, { workerId: `w${invocation}` });
      assert.equal(claim.claimed, true, `invocation ${invocation} claims`);
      // eslint-disable-next-line no-await-in-loop
      const deferred = await orchestration.deferUnit(unitId, { reason: STAGING_FROZEN_CODE });
      assert.equal(deferred.status, "PENDING", `invocation ${invocation} returns the unit`);
      assert.equal(deferred.attempt, 0, `invocation ${invocation} consumes no attempt`);
      assert.equal(deferred.startedAt, null, "the lease is dropped so another worker may take it");
      assert.equal(deferred.lastError, null, "a deferral is not an error");
      assert.equal(deferred.result.deferred.reason, STAGING_FROZEN_CODE);
    }
    const unit = store.rows.find((r) => r.id === unitId);
    assert.notEqual(unit.status, "DEAD_LETTER", "a freeze must never dead-letter another run's work");
    assert.equal(unit.status, "PENDING");

    // The other run's parent is untouched by all of this.
    const described = await orchestration.describeRun(second.id);
    assert.equal(described.failedUnits, 0);
    assert.equal(described.pendingUnits, 1);
  });

  it("6. deferUnit refuses to revive, steal or over-credit a unit it does not currently hold", async () => {
    resetClock();
    const store = createStore();
    const orchestration = new SyncOrchestrationService({ prisma: store.prisma, now, listAccounts: async () => ["default"], loadAccountState: async () => ({ lastSuccessfulSync: null }) });
    const run = await orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.NETWORK, platform: "awin", accountLabel: "default", options: { fastSync: false, promoteAfter: false } }],
    });
    const unitId = store.rows.find((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === run.id).id;
    const rowOf = () => store.rows.find((r) => r.id === unitId);

    // Terminal work is never resurrected.
    for (const status of ["COMPLETED", "DEAD_LETTER", "FAILED", "CANCELLED"]) {
      // eslint-disable-next-line no-await-in-loop
      await store.prisma.jobRun.update({ where: { id: unitId }, data: { status, attempt: 2, lastError: "zzreal failurezz" } });
      // eslint-disable-next-line no-await-in-loop
      await orchestration.deferUnit(unitId, { reason: STAGING_FROZEN_CODE });
      assert.equal(rowOf().status, status, `${status} must not be revived`);
      assert.equal(rowOf().attempt, 2, `${status} must keep its attempt count`);
      assert.equal(rowOf().lastError, "zzreal failurezz", "a real execution error is never erased");
    }

    // Another worker's live claim is never taken away.
    await store.prisma.jobRun.update({ where: { id: unitId }, data: { status: "PENDING", attempt: 0, lastError: null, result: null } });
    const claim = await orchestration.claimUnit(unitId, { workerId: "worker:other" });
    assert.equal(claim.claimed, true);
    await orchestration.deferUnit(unitId, { reason: STAGING_FROZEN_CODE, workerId: "worker:mine" });
    assert.equal(rowOf().status, "RUNNING", "another worker still holds it");
    assert.equal(rowOf().attempt, 1, "and keeps its attempt");

    // The holder itself may hand it back, exactly once, and the attempt never goes negative.
    const returned = await orchestration.deferUnit(unitId, { reason: STAGING_FROZEN_CODE, workerId: "worker:other" });
    assert.equal(returned.status, "PENDING");
    assert.equal(returned.attempt, 0);
    assert.equal(returned.startedAt, null);
    const replay = await orchestration.deferUnit(unitId, { reason: STAGING_FROZEN_CODE, workerId: "worker:other" });
    assert.equal(replay.attempt, 0, "a replayed deferral cannot drive the attempt below zero");
    assert.equal(rowOf().status, "PENDING");
  });

  it("the worker returns a deferral, not a retry or a failure, when staging is frozen", () => {
    const worker = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8")
      .split("export async function triggerSyncWorker")[1].split("\nexport ")[0];
    assert.match(worker, /if \(isStagingFrozenError\(error\)\) \{/);
    assert.match(worker, /await orchestration\.deferUnit\(unit\.id/);
    assert.match(worker, /status: "unit_deferred"/);
    // The deferral branch comes BEFORE failUnit, so a freeze can never reach the failure path.
    assert.ok(worker.indexOf("isStagingFrozenError") < worker.indexOf("orchestration.failUnit("));
  });
});

describe("module-load order and lease sizing", () => {
  it("the barrier and the stage module import each other, so neither may read the other at load", () => {
    const code = BARRIER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // Everything imported from postSyncStages.js must be read inside a function body. A top-level
    // read throws "Cannot access before initialization" whenever the cycle is entered from the
    // other side, which import order alone decides — so it would crash on some boot paths only.
    const topLevel = code.split("\nexport class EntityStagingBarrier")[0];
    const afterImports = topLevel.split('} from "./postSyncStages.js";')[1] ?? "";
    for (const line of afterImports.split("\n")) {
      if (!line.includes("POST_SYNC_STAGES.")) continue;
      assert.ok(/=>|function|return/.test(line), `top-level read of POST_SYNC_STAGES: ${line.trim()}`);
    }
  });

  it("7. a participant outlives the longest possible staging call, by design", () => {
    // Asymmetric on purpose: expiring EARLY loses rows, expiring LATE only makes the gate wait.
    assert.ok(STAGING_PARTICIPANT_LEASE_MS > DEFAULT_LEASE_MS, "participants outlive the worker lease");
    assert.equal(STAGING_PARTICIPANT_LEASE_MS, 30 * 60 * 1000);
    // Vercel caps an invocation at 300s, so a stager there cannot approach its own lease.
    const VERCEL_MAX_INVOCATION_MS = 300 * 1000;
    assert.ok(STAGING_PARTICIPANT_LEASE_MS >= VERCEL_MAX_INVOCATION_MS * 6);

    // And the two leases are genuinely applied to different rows, not merged by accident.
    resetClock();
    const store = createStore();
    seedRun(store, { postSyncStages: "deferred" });
    const barrier = barrierOver(store);
    return (async () => {
      await barrier.enterStaging("boostiny:campaign");
      await barrier.announceFreezeIntent();
      advance(DEFAULT_LEASE_MS + 1000);
      assert.equal(await barrier.freezeIntent(), null, "the marker expires on the worker lease");
      assert.equal((await barrier.activeParticipants()).length, 1, "the participant is still live");
      advance(STAGING_PARTICIPANT_LEASE_MS);
      assert.deepEqual(await barrier.activeParticipants(), [], "and expires on its own, longer lease");
      resetClock();
    })();
  });
});

describe("error semantics", () => {
  it("the refusal is machine-readable, a 409, and marked retryable", () => {
    const error = stagingFrozenError({ stage: POST_SYNC_STAGES.PROMOTING, runId: "run-1" });
    assert.equal(error.code, STAGING_FROZEN_CODE);
    assert.equal(error.statusCode, 409);
    assert.equal(error.retryable, true);
    assert.equal(error.stage, POST_SYNC_STAGES.PROMOTING);
    assert.equal(isStagingFrozenError(error), true);
    assert.equal(isStagingFrozenError(new Error("other")), false);
    assert.equal(isStagingFrozenError(null), false);
    // It names no entity, no campaign, no id beyond the run it belongs to.
    for (const leak of ["rawData", "externalId", "campaignName", "coupon"]) {
      assert.ok(!error.message.includes(leak), leak);
    }
  });

  it("the participant key is scoped, and the marker key is the shared barrier key", () => {
    assert.equal(stagingParticipantKey("boostiny:campaign"), `${ENTITY_STAGING_BARRIER_KEY}:boostiny:campaign`);
    assert.equal(stagingParticipantKey(null), `${ENTITY_STAGING_BARRIER_KEY}:unscoped`);
    assert.equal(ENTITY_STAGING_BARRIER_KEY, "entity-staging");
  });
});
