/**
 * Phase 6b — one PAGE of conversion promotion is one bounded durable unit.
 *
 * A unit names a networkSource and an exclusive id cursor. One worker invocation promotes exactly
 * one page and, if that page was full, appends exactly ONE continuation unit to the tail. There is
 * no loop over the next page, no recursion, no background promise, and no supplier call anywhere
 * on the path.
 *
 * The cursor is the service's own boundary, not an invented one: ConversionPromotionService walks
 * Entity(entityType:"conversion") by `id: { gt: cursor }` ordered `id asc`, taking `batchSize`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { triggerSyncWorker } from "../src/controllers/sync.controller.js";
import {
  UNIT_JOB_NAME,
  UNIT_KINDS,
  DEFAULT_UNIT_MAX_ATTEMPTS,
  SyncOrchestrationService,
  isUnitExecutable,
  assertUnitExecutable,
  unitLockKey,
} from "../src/jobs/syncOrchestration.service.js";
import { DEFAULT_LEASE_MS, SyncAccountLockService, stageLockKey } from "../src/jobs/syncAccountLock.service.js";
import {
  CONVERSION_PROMOTION_PAGE_SIZE,
  CONVERSION_PROMOTION_REFUSAL_CODE,
  executeConversionPromotionUnit,
  nextConversionPromotionUnit,
  pageHasMore,
  resolveConversionPromotionPage,
  summariseConversionPromotionUnitOutcome,
} from "../src/jobs/conversionPromotionUnit.js";
import { ConversionPromotionService } from "../src/modules/reporting/services/conversionPromotion.service.js";

const UNIT_SRC = readFileSync(new URL("../src/jobs/conversionPromotionUnit.js", import.meta.url), "utf8");
const CONTROLLER_SRC = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");

/**
 * Executable code only. The module comments quote the `for (;;)` drain this phase replaces and
 * name the unbounded entrypoints it must not reach — explaining that is the point, so the loop
 * scan below reads what actually runs.
 */
const codeOnly = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const loadAccountState = async () => ({ lastSuccessfulSync: null });

/* ------------------------------------------------------------------ durable JobRun fake ----- */

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
    async update({ where, data }) { const row = rows.find((r) => r.id === where.id); apply(row, data); return clone(row); },
    async updateMany({ where, data }) { let count = 0; for (const row of rows) if (match(row, where)) { apply(row, data); count += 1; } return { count }; },
    async findUnique({ where }) { const row = rows.find((r) => r.id === where.id); return row ? clone(row) : null; },
    async findFirst({ where, orderBy }) { const list = sort(rows.filter((r) => match(r, where)), orderBy); return list.length ? clone(list[0]) : null; },
    async findMany({ where, orderBy }) { return sort(rows.filter((r) => match(r, where ?? {})), orderBy).map(clone); },
  };
  return { rows, prisma: { jobRun, async $transaction(fn) { return fn({ jobRun }); } } };
}

let clock = new Date("2026-09-15T12:00:00.000Z");
const now = () => clock;
const resetClock = () => { clock = new Date("2026-09-15T12:00:00.000Z"); };
const advance = (ms) => { clock = new Date(clock.getTime() + ms); };

/* --------------------------------------------------- a staged conversion Entity table fake --- */

/**
 * A fake `entity` table with the ONE query shape runPage issues. Ids are lexicographically
 * ordered so `id asc` and `id > cursor` mean what Postgres would mean.
 */
function createEntityStore(rowsById) {
  const all = rowsById.slice().sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
  const queries = [];
  return {
    queries,
    all,
    prisma: {
      entity: {
        async findMany({ where = {}, orderBy, take }) {
          queries.push({ where, orderBy, take });
          const gt = where.id?.gt ?? null;
          const ids = where.id?.in ?? null;
          return all
            .filter((row) => row.entityType === (where.entityType ?? row.entityType))
            .filter((row) => (where.networkSource ? row.networkSource === where.networkSource : true))
            .filter((row) => (gt ? row.id > gt : true))
            .filter((row) => (ids ? ids.includes(row.id) : true))
            .slice(0, take ?? all.length)
            .map((row) => JSON.parse(JSON.stringify(row)));
        },
      },
    },
  };
}

const conversionEntity = (id, networkSource = "admitad") => ({
  id,
  entityType: "conversion",
  networkSource,
  externalId: `ext-${id}`,
  // Deliberately loud markers: if any of this reaches a response or a durable result row, the
  // leak assertions below fail loudly rather than subtly.
  rawData: { zzsecretpayloadzz: true, amount: "999.99", currency: "SAR", subId: "zzsubidzz" },
});

/** The paging logic under test is runPage's; the per-entity ingest is not this unit's subject. */
class PagingOnlyPromotionService extends ConversionPromotionService {
  constructor({ prisma, onPromote } = {}) {
    super({ prisma, attribution: {}, orders: {}, exceptions: {} });
    this.seen = [];
    this.onPromote = onPromote ?? null;
  }
  async promoteEntity(entity) {
    this.seen.push(entity.id);
    if (this.onPromote) return this.onPromote(entity);
    return { result: "promoted" };
  }
}

/* --------------------------------------------------------------------- the worker harness --- */

/** One app: one durable store, one orchestration service, one injected page runner. */
function app({ pageImpl } = {}) {
  const { rows, prisma } = createStore();
  const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts: async () => ["default"], loadAccountState });
  const locks = new SyncAccountLockService({ prisma, now });
  const calls = [];
  const conversionPromotionPage = async (input) => {
    calls.push(input);
    if (pageImpl) return pageImpl(input, calls.length);
    return { processed: 0, promoted: 0, skipped: 0, failed: 0, lastCursor: null, hasMore: false };
  };
  const syncPlatformAccount = async (platform, accountLabel) => ({ [accountLabel ?? "default"]: { campaigns: 1 } });
  const locals = { syncOrchestration: orchestration, syncAccountLocks: locks, syncPlatformAccount, conversionPromotionPage };
  const makeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  };
  return {
    rows, prisma, orchestration, locks, calls,
    async worker() {
      const res = makeRes();
      await triggerSyncWorker({ app: { locals } }, res, (error) => { throw error; });
      return res;
    },
    units(runId) { return rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId); },
    unit(runId) { return this.units(runId).find((r) => r.status === "PENDING" || r.status === "RUNNING") ?? this.units(runId)[0]; },
  };
}

/**
 * A page runner that ends. The first call returns a FULL page (so the continuation contract is
 * exercised) and every later call a short one, so a drain loop accidentally reintroduced into the
 * unit terminates and trips the one-page assertions rather than hanging the suite.
 */
const fullThenShort = (_input, call) =>
  call === 1
    ? { processed: 100, promoted: 100, skipped: 0, failed: 0, lastCursor: "e-0099", hasMore: true }
    : { processed: 7, promoted: 7, skipped: 0, failed: 0, lastCursor: "e-0106", hasMore: false };

const promotionUnit = (extra = {}) => ({
  kind: UNIT_KINDS.CONVERSION_PROMOTION,
  networkSource: "admitad",
  cursorId: null,
  pageSize: CONVERSION_PROMOTION_PAGE_SIZE,
  options: {},
  ...extra,
});

/** A page runner backed by a real entity store, so cursor semantics are the service's own. */
function pageRunnerOver(store, { onPromote } = {}) {
  const service = new PagingOnlyPromotionService({ prisma: store.prisma, onPromote });
  return { service, run: (input) => service.runPage(input) };
}

/* ================================================================================ the tests = */

describe("Phase 6b — a conversion-promotion unit is exactly one cursor page", () => {
  it("1. a first page processes at most pageSize rows, however many are staged", async () => {
    const store = createEntityStore(Array.from({ length: 250 }, (_, i) => conversionEntity(`e-${String(i).padStart(4, "0")}`)));
    const runner = pageRunnerOver(store);
    const result = await executeConversionPromotionUnit(promotionUnit(), { runPage: runner.run });

    assert.equal(result.processed, CONVERSION_PROMOTION_PAGE_SIZE, "one page, not the whole walk");
    assert.equal(runner.service.seen.length, CONVERSION_PROMOTION_PAGE_SIZE);
    assert.equal(store.queries.length, 1, "one query: a unit does not walk");
    assert.equal(store.queries[0].take, CONVERSION_PROMOTION_PAGE_SIZE);
    assert.deepEqual(store.queries[0].orderBy, { id: "asc" }, "ordered by id ascending");
    assert.equal(result.hasMore, true);
    assert.equal(result.lastCursor, "e-0099");
  });

  it("2. exactly one page runs per worker invocation", async () => {
    resetClock();
    const h = app({ pageImpl: fullThenShort });
    await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });

    const res = await h.worker();
    assert.equal(res.body.status, "unit_completed");
    assert.equal(h.calls.length, 1, "one page per invocation — a drain loop would make this more");
    assert.deepEqual(h.calls[0], { networkSource: "admitad", cursorId: undefined, batchSize: CONVERSION_PROMOTION_PAGE_SIZE });

    // The continuation exists but is NOT run by this invocation.
    await h.worker();
    assert.equal(h.calls.length, 2, "the next invocation runs the next page, and only it");
    assert.equal(h.calls[1].cursorId, "e-0099");
  });

  it("3. nothing on the path loops, recurses or detaches a promise", () => {
    const helper = CONTROLLER_SRC.split("async function appendConversionPromotionContinuation(")[1].split("\n}\n")[0];
    const seam = CONTROLLER_SRC.split("function conversionPromotionPageFor(")[1].split("\n}\n")[0];
    for (const source of [UNIT_SRC, helper, seam].map(codeOnly)) {
      for (const forbidden of ["for (", "for(", "while (", "while(", "setTimeout", "setInterval", "setImmediate", ".then(", ".catch(", "void ", "Promise.all", "Promise.race"]) {
        assert.ok(!source.includes(forbidden), forbidden);
      }
    }
    // No recursion: the unit entrypoint appears exactly once in its own module — its definition —
    // and the controller's continuation helper never re-enters it.
    assert.equal((codeOnly(UNIT_SRC).match(/executeConversionPromotionUnit\(/g) ?? []).length, 1, "the unit entrypoint calls itself");
    for (const source of [helper, seam].map(codeOnly)) {
      assert.ok(!source.includes("executeConversionPromotionUnit("), "re-entered from the controller");
    }
    // The unbounded drain is not reachable: only the single-page entrypoint is.
    assert.ok(!/ConversionPromotionService\(\)\s*\.\s*run\(/.test(CONTROLLER_SRC), "run() drain reachable");
    assert.match(seam, /new ConversionPromotionService\(\)\.runPage\(input\)/);
    // executeConversionPromotionUnit awaits ONE runPage call and returns.
    const execute = codeOnly(UNIT_SRC).split("export async function executeConversionPromotionUnit(")[1].split("\n}\n")[0];
    assert.equal((execute.match(/runPage\(/g) ?? []).length, 1, "exactly one page call");
  });

  it("4. the cursor is exclusive: consecutive pages repeat no entity and skip none", async () => {
    const staged = Array.from({ length: 250 }, (_, i) => conversionEntity(`e-${String(i).padStart(4, "0")}`));
    const store = createEntityStore(staged);
    const runner = pageRunnerOver(store);

    const seenPerPage = [];
    let descriptor = promotionUnit();
    for (let page = 0; page < 3; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await executeConversionPromotionUnit(descriptor, { runPage: runner.run });
      seenPerPage.push(runner.service.seen.slice(seenPerPage.flat().length));
      const next = nextConversionPromotionUnit(result, { kind: UNIT_KINDS.CONVERSION_PROMOTION });
      if (!next) { descriptor = null; break; }
      assert.notEqual(next.cursorId, descriptor.cursorId, "a continuation never repeats its own cursor");
      descriptor = next;
    }

    const all = seenPerPage.flat();
    assert.equal(all.length, 250, "the walk covers every staged row");
    assert.equal(new Set(all).size, 250, "no entity is promoted twice");
    assert.deepEqual(all, staged.map((e) => e.id), "and in id order, with nothing skipped");
    assert.equal(descriptor, null, "the short final page ends the walk");
    // Every continued query filtered EXCLUSIVELY on the previous page's last id.
    assert.equal(store.queries[1].where.id.gt, "e-0099");
    assert.equal(store.queries[2].where.id.gt, "e-0199");
  });

  it("5. a full page appends exactly one continuation, carrying its last id", async () => {
    resetClock();
    const h = app({ pageImpl: (input, call) => (call === 1 ? { processed: 100, promoted: 90, skipped: 10, failed: 0, lastCursor: "e-0099", hasMore: true } : { processed: 3, promoted: 3, skipped: 0, failed: 0, lastCursor: "e-0102", hasMore: false }) });
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });

    const res = await h.worker();
    assert.equal(res.body.unitsMaterialised, 1, "exactly one");
    const units = h.units(run.id);
    assert.equal(units.length, 2);
    const [first, second] = units;
    assert.equal(first.status, "COMPLETED");
    assert.equal(second.status, "PENDING");
    assert.equal(second.payload.kind, UNIT_KINDS.CONVERSION_PROMOTION);
    assert.equal(second.payload.networkSource, "admitad");
    assert.equal(second.payload.cursorId, "e-0099");
    assert.equal(second.payload.pageSize, CONVERSION_PROMOTION_PAGE_SIZE);
    assert.equal(second.priority, 2, "appended to the TAIL, not spliced in front");
  });

  it("6. a partial final page appends no continuation", async () => {
    resetClock();
    const h = app({ pageImpl: () => ({ processed: 42, promoted: 42, skipped: 0, failed: 0, lastCursor: "e-0041", hasMore: false }) });
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });

    const res = await h.worker();
    assert.equal(res.body.status, "unit_completed");
    assert.equal(res.body.unitsMaterialised, undefined);
    assert.equal(h.units(run.id).length, 1, "the walk is finished");
    assert.equal((await h.worker()).body.worked, false, "and nothing is left workable");
  });

  it("7. an empty page appends no continuation", async () => {
    resetClock();
    const h = app({ pageImpl: () => ({ processed: 0, promoted: 0, skipped: 0, failed: 0, lastCursor: null, hasMore: false }) });
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit({ cursorId: "e-0999" })] });

    await h.worker();
    assert.equal(h.units(run.id).length, 1);
    // …and a full page with NO last cursor is still not continuable: there is nothing to resume from.
    const stuck = await executeConversionPromotionUnit(promotionUnit(), {
      runPage: async () => ({ processed: 100, promoted: 100, skipped: 0, failed: 0, lastCursor: null, hasMore: true }),
    });
    assert.equal(stuck.hasMore, false, "a page with no cursor cannot continue");
    assert.equal(nextConversionPromotionUnit(stuck, { kind: UNIT_KINDS.CONVERSION_PROMOTION }), null);
  });

  it("8. re-running the same page is idempotent, and a replayed continuation is deduped", async () => {
    // The page itself: the same descriptor asks the service for exactly the same rows.
    const store = createEntityStore(Array.from({ length: 150 }, (_, i) => conversionEntity(`e-${String(i).padStart(4, "0")}`)));
    const runner = pageRunnerOver(store);
    const descriptor = promotionUnit({ cursorId: "e-0049" });
    const first = await executeConversionPromotionUnit(descriptor, { runPage: runner.run });
    const seenFirst = runner.service.seen.slice();
    runner.service.seen.length = 0;
    const second = await executeConversionPromotionUnit(descriptor, { runPage: runner.run });
    assert.deepEqual(second, first, "the same page yields the same result");
    assert.deepEqual(runner.service.seen, seenFirst, "over exactly the same rows");

    // The append: a replayed completion computes the same identity and adds nothing.
    resetClock();
    const h = app();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });
    const next = nextConversionPromotionUnit(first, { kind: UNIT_KINDS.CONVERSION_PROMOTION });
    const once = await h.orchestration.appendUnits(run.id, [next]);
    const twice = await h.orchestration.appendUnits(run.id, [next]);
    assert.equal(once.appended, 1);
    assert.equal(twice.appended, 0, "a replayed continuation is not a second tail");
    assert.equal(twice.skipped, 1);
    assert.equal(h.units(run.id).filter((u) => u.payload.cursorId === next.cursorId).length, 1);
  });

  it("9. a page that fails halfway leaves the unit retryable, and appends nothing", async () => {
    resetClock();
    let attempts = 0;
    const h = app({ pageImpl: () => { attempts += 1; throw new Error("zzpromotion downzz"); } });
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });

    const res = await h.worker();
    assert.equal(res.body.status, "unit_retry");
    assert.equal(h.unit(run.id).status, "PENDING", "still workable");
    assert.equal(h.unit(run.id).attempt, 1);
    assert.equal(h.units(run.id).length, 1, "a failed page never appends a continuation");
    assert.equal(attempts, 1, "one execution per invocation — no retry loop inside one request");
    // The retry re-runs the SAME page: the cursor is unchanged, so partially-promoted rows are
    // simply re-promoted, which the Conversion/Order unique keys make a no-op.
    await h.worker();
    assert.equal(attempts, 2, "the retry is a second invocation, not a second try inside one");
    assert.equal(h.calls.length, 2, "two invocations, two page calls");
    assert.deepEqual(
      h.calls.map((call) => call.cursorId),
      [undefined, undefined],
      "the retry re-runs the SAME page — the cursor only advances on a COMPLETED page",
    );
    assert.equal(h.unit(run.id).payload.cursorId, null, "the retry's cursor is the failed page's own");
    assert.equal(h.units(run.id).length, 1, "and still nothing appended");
  });

  it("10. maxAttempts is unchanged: three attempts, then DEAD_LETTER", async () => {
    resetClock();
    const h = app({ pageImpl: () => { throw new Error("zzpromotion downzz"); } });
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });
    assert.equal(h.units(run.id)[0].maxAttempts, DEFAULT_UNIT_MAX_ATTEMPTS);
    assert.equal(DEFAULT_UNIT_MAX_ATTEMPTS, 3);

    assert.equal((await h.worker()).body.status, "unit_retry");
    assert.equal((await h.worker()).body.status, "unit_retry");
    assert.equal((await h.worker()).body.status, "unit_failed");
    assert.equal(h.units(run.id)[0].status, "DEAD_LETTER");
  });

  it("11. stale-claim behaviour is unchanged: a live stage lease blocks, an expired one is reclaimed", async () => {
    resetClock();
    const h = app({ pageImpl: () => ({ processed: 5, promoted: 5, skipped: 0, failed: 0, lastCursor: "e-0004", hasMore: false }) });
    await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });

    const key = unitLockKey({ kind: UNIT_KINDS.CONVERSION_PROMOTION, networkSource: "admitad" });
    assert.equal(key, stageLockKey(UNIT_KINDS.CONVERSION_PROMOTION, null), "a GLOBAL stage lock, not a per-network one");
    const crashed = await h.locks.acquire(key, { holderId: "crashed-instance" });
    assert.equal(crashed.acquired, true);

    assert.equal((await h.worker()).statusCode, 409, "a live lease is never stolen");
    assert.equal(h.calls.length, 0, "and no page runs behind it");
    advance(DEFAULT_LEASE_MS + 1000);
    assert.equal((await h.worker()).body.worked, true, "an expired lease is reclaimable");
    resetClock();
  });

  it("12/13/14. identity covers kind, networkSource AND cursor — pages and networks never collapse", async () => {
    resetClock();
    const h = app();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });

    // Distinct cursors are distinct units.
    const pageTwo = promotionUnit({ cursorId: "e-0099" });
    const pageThree = promotionUnit({ cursorId: "e-0199" });
    assert.equal((await h.orchestration.appendUnits(run.id, [pageTwo])).appended, 1);
    assert.equal((await h.orchestration.appendUnits(run.id, [pageThree])).appended, 1);
    // Distinct networks are distinct units, even at the SAME cursor.
    const otherNetwork = promotionUnit({ networkSource: "boostiny", cursorId: "e-0099" });
    assert.equal((await h.orchestration.appendUnits(run.id, [otherNetwork])).appended, 1);
    // …and each of them is still itself, so none can be appended twice.
    for (const unit of [pageTwo, pageThree, otherNetwork]) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await h.orchestration.appendUnits(run.id, [unit])).appended, 0, JSON.stringify(unit.cursorId));
    }
    const cursors = h.units(run.id).map((u) => `${u.payload.networkSource}@${u.payload.cursorId ?? "first"}`);
    assert.deepEqual(cursors, ["admitad@first", "admitad@e-0099", "admitad@e-0199", "boostiny@e-0099"]);
  });

  it("15. a missing, blank or non-string networkSource is refused", () => {
    for (const networkSource of [undefined, null, "", "   ", 7, {}, ["admitad"]]) {
      assert.throws(
        () => resolveConversionPromotionPage({ ...promotionUnit(), networkSource }),
        (error) => error.code === CONVERSION_PROMOTION_REFUSAL_CODE && error.statusCode === 422,
        JSON.stringify(networkSource ?? null),
      );
    }
    assert.equal(resolveConversionPromotionPage(promotionUnit({ networkSource: " admitad " })).networkSource, "admitad");
  });

  it("16. a date-window field is refused — the service filters on no date at all", () => {
    for (const field of ["from", "to", "windowStart", "windowEnd", "day", "days"]) {
      assert.throws(
        () => resolveConversionPromotionPage(promotionUnit({ [field]: "2026-09-01" })),
        (error) => error.code === CONVERSION_PROMOTION_REFUSAL_CODE && error.message.includes(field),
        field,
      );
    }
    // The service is not given one either: the only filters are type, network and cursor.
    const execute = codeOnly(UNIT_SRC).split("export async function executeConversionPromotionUnit(")[1].split("\n}\n")[0];
    for (const field of ["from", "to", "windowStart", "windowEnd", "day"]) {
      assert.ok(!new RegExp(`${field}\\s*:`).test(execute), `${field} passed to the service`);
    }
  });

  it("17. an entityIds list is refused: it would bypass the cursor the continuation depends on", () => {
    assert.throws(
      () => resolveConversionPromotionPage(promotionUnit({ entityIds: ["e-0001"] })),
      (error) => error.code === CONVERSION_PROMOTION_REFUSAL_CODE && error.message.includes("entityIds"),
    );
    const execute = codeOnly(UNIT_SRC).split("export async function executeConversionPromotionUnit(")[1].split("\n}\n")[0];
    assert.ok(!execute.includes("entityIds"), "entityIds is never forwarded to the service");
    // A stored pageSize other than the fixed one is refused too: two units for the same cursor
    // must never mean different rows.
    for (const pageSize of [1, 50, 101, 1000, "100"]) {
      assert.throws(() => resolveConversionPromotionPage(promotionUnit({ pageSize })), (error) => error.code === CONVERSION_PROMOTION_REFUSAL_CODE, String(pageSize));
    }
    assert.equal(resolveConversionPromotionPage(promotionUnit({ pageSize: undefined })).pageSize, CONVERSION_PROMOTION_PAGE_SIZE);
    // A blank cursor is refused; absent means "first page".
    assert.throws(() => resolveConversionPromotionPage(promotionUnit({ cursorId: "  " })), (error) => error.code === CONVERSION_PROMOTION_REFUSAL_CODE);
    assert.throws(() => resolveConversionPromotionPage(promotionUnit({ cursorId: 12 })), (error) => error.code === CONVERSION_PROMOTION_REFUSAL_CODE);
    assert.equal(resolveConversionPromotionPage(promotionUnit()).cursorId, null);
  });

  it("18. executable:false still wins over the widened kind list", async () => {
    assert.equal(isUnitExecutable({ kind: UNIT_KINDS.CONVERSION_PROMOTION }), true);
    assert.equal(isUnitExecutable({ kind: UNIT_KINDS.CONVERSION_PROMOTION, executable: false }), false);
    assert.equal(isUnitExecutable({ payload: { kind: UNIT_KINDS.CONVERSION_PROMOTION, executable: false } }), false);
    assert.throws(() => assertUnitExecutable({ kind: UNIT_KINDS.CONVERSION_PROMOTION, executable: false }), (error) => error.code === "unit_not_executable");

    // An older run's blocked placeholder is not offered to a worker and no page runs for it.
    resetClock();
    const h = app();
    await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit({ executable: false })] });
    const res = await h.worker();
    assert.equal(res.body.worked, false, "a blocked placeholder is never worked");
    assert.equal(h.calls.length, 0, "and nothing is promoted for it");
  });

  it("19. no supplier or API call happens anywhere on the path", async () => {
    resetClock();
    const fetches = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { fetches.push(args[0]); throw new Error("zzno network from a promotion unitzz"); };
    try {
      const h = app({ pageImpl: fullThenShort });
      await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });
      assert.equal((await h.worker()).body.status, "unit_completed");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(fetches, [], "a conversion-promotion unit never reaches the network");
    // …and the module cannot: it imports nothing at all, let alone a supplier client.
    assert.ok(!/^\s*import\s/m.test(UNIT_SRC), "the unit primitive has no imports");
    for (const forbidden of ["axios", "fetch(", "http", "Client", "apiKey", "token"]) {
      assert.ok(!UNIT_SRC.includes(forbidden), forbidden);
    }
  });

  it("20. the result projection carries counts and position only — never a conversion, order or payload", async () => {
    const store = createEntityStore(Array.from({ length: 120 }, (_, i) => conversionEntity(`e-${String(i).padStart(4, "0")}`)));
    const runner = pageRunnerOver(store, { onPromote: (entity) => ({ result: entity.id.endsWith("7") ? "skipped" : "promoted" }) });
    const result = await executeConversionPromotionUnit(promotionUnit(), { runPage: runner.run });
    const outcome = summariseConversionPromotionUnitOutcome(result);

    assert.deepEqual(Object.keys(outcome).sort(), ["counts", "hasMore", "kind", "networkSource", "pageSize"]);
    assert.deepEqual(Object.keys(outcome.counts).sort(), ["failed", "processed", "promoted", "skipped"]);
    assert.equal(outcome.counts.processed, 100);
    assert.equal(outcome.counts.promoted + outcome.counts.skipped + outcome.counts.failed, 100);
    // Not one marker from a staged row survives into the durable outcome.
    const serialised = JSON.stringify(outcome);
    for (const marker of ["zzsecretpayloadzz", "999.99", "SAR", "zzsubidzz", "ext-e-0000", "e-0000", "e-0099", "rawData"]) {
      assert.ok(!serialised.includes(marker), marker);
    }

    // The same holds for the worker's HTTP response and for the row it writes.
    resetClock();
    const h = app({ pageImpl: fullThenShort });
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit({ cursorId: "e-0000" })] });
    const res = await h.worker();
    const body = JSON.stringify(res.body);
    for (const marker of ["zzsecretpayloadzz", "999.99", "zzsubidzz", "e-0000", "e-0099"]) {
      assert.ok(!body.includes(marker), `${marker} in the response`);
    }
    assert.deepEqual(res.body.unit.conversionPage, { networkSource: "admitad", pageSize: 100, continued: true });
    const completed = h.units(run.id).find((u) => u.status === "COMPLETED");
    assert.equal(completed.result.outcome.kind, "conversion-promotion");
    assert.ok(!JSON.stringify(completed.result).includes("zzsecretpayloadzz"));
  });

  it("21. the worker still advances exactly one durable unit, of whatever kind, per invocation", async () => {
    resetClock();
    const h = app({ pageImpl: fullThenShort });
    const run = await h.orchestration.createRun({
      kind: "full",
      trigger: "api",
      options: { promoteAfter: false },
      units: [
        { kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: { fastSync: false, promoteAfter: false } },
        promotionUnit(),
      ],
    });

    const first = await h.worker();
    assert.equal(first.body.unit.kind, UNIT_KINDS.NETWORK);
    assert.equal(h.calls.length, 0, "a network unit promotes nothing");
    const second = await h.worker();
    assert.equal(second.body.unit.kind, UNIT_KINDS.CONVERSION_PROMOTION);
    assert.equal(h.calls.length, 1, "and the promotion unit runs exactly one page");
    assert.equal(h.units(run.id).filter((u) => u.status === "COMPLETED").length, 2);
    assert.equal(h.units(run.id).filter((u) => u.status === "PENDING").length, 1, "the continuation, left for the next invocation");
  });

  it("24. entity promotion is still NOT executable, and the order it must follow is unchanged", async () => {
    assert.equal(isUnitExecutable({ kind: UNIT_KINDS.PROMOTION }), false);
    assert.throws(() => assertUnitExecutable({ kind: UNIT_KINDS.PROMOTION }), (error) => error.code === "unit_not_executable");

    resetClock();
    const h = app();
    await h.orchestration.createRun({
      kind: "full",
      trigger: "api",
      options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.PROMOTION, options: {} }, promotionUnit()],
    });
    // The promotion placeholder is skipped, not executed — and skipping it is exactly why this
    // phase must not be materialised into a production run before Phase 6c.
    const res = await h.worker();
    assert.equal(res.body.unit.kind, UNIT_KINDS.CONVERSION_PROMOTION);
    assert.equal(h.calls.length, 1);
  });

  it("pageHasMore is the service's own stop condition, not a guess", () => {
    assert.equal(pageHasMore({ processed: 100 }), true, "a full page may have more");
    assert.equal(pageHasMore({ processed: 99 }), false, "a short page is the end");
    assert.equal(pageHasMore({ processed: 0 }), false);
    assert.equal(pageHasMore({ processed: 101 }), true, "never under-reports");
    assert.equal(pageHasMore({ processed: undefined }), false);
    assert.equal(pageHasMore({ processed: Number.NaN }), false);
    assert.equal(pageHasMore({}), false);
  });
});
