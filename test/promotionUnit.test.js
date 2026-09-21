/**
 * Phase 6c — one PAGE of entity promotion is one bounded durable unit.
 *
 * A unit names one networkSource, one entityType and an exclusive id cursor. One worker invocation
 * promotes exactly one page and, if that page was full, appends exactly ONE continuation to the
 * tail of the SAME type's walk. No loop across pages, no recursion, no background promise, no
 * supplier call.
 *
 * The durable walk is keyset by primary key alone. The legacy walk orders by [updatedAt, id] and
 * positions with a Prisma cursor plus skip, which a re-stage between two invocations invalidates.
 *
 * The Rakuten commission work is not a once-per-run hook here: audited, it is per-OFFER promotion,
 * so it is simply a third entityType walked by the same cursor. It therefore runs exactly once per
 * offer and cannot fire from a campaign or coupon page at all.
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
  OFFER_ENTITY_TYPE,
  PROMOTION_ENTITY_TYPES,
  PROMOTION_PAGE_SIZE,
  PROMOTION_REFUSAL_CODE,
  executePromotionUnit,
  nextPromotionUnit,
  promotionPageHasMore,
  resolvePromotionPage,
  summarisePromotionUnitOutcome,
} from "../src/jobs/promotionUnit.js";
import { PromotionJob } from "../src/jobs/promotion.job.js";
import { EntityRepository } from "../src/modules/supplier/repositories/index.js";

const UNIT_SRC = readFileSync(new URL("../src/jobs/promotionUnit.js", import.meta.url), "utf8");
const JOB_SRC = readFileSync(new URL("../src/jobs/promotion.job.js", import.meta.url), "utf8");
const REPO_SRC = readFileSync(new URL("../src/modules/supplier/repositories/entity.repository.js", import.meta.url), "utf8");
const CONTROLLER_SRC = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");

/** Executable code only; the comments quote the legacy shapes this phase replaces. */
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

/* ------------------------------------------------------- a staged promotable Entity fake ---- */

/**
 * A fake `entity` table recording the EXACT query each page issues, so the ordering and cursor
 * assertions below read what the repository really asked for.
 */
function createEntityStore(rowsById) {
  const all = rowsById.slice().sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
  const queries = [];
  return {
    queries,
    all,
    prisma: {
      entity: {
        async findMany(args = {}) {
          queries.push(args);
          const { where = {}, take } = args;
          const gt = where.id?.gt ?? null;
          const ids = where.id?.in ?? null;
          return all
            .filter((row) => (where.entityType ? row.entityType === where.entityType : true))
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

const stagedEntity = (id, entityType = "campaign", networkSource = "boostiny") => ({
  id,
  entityType,
  networkSource,
  externalId: `ext-${id}`,
  // Loud markers: if any of this reaches a response or a durable result row, the leak assertions
  // below fail rather than letting supplier data through quietly.
  rawData: { zzrawpayloadzz: true, campaignName: "zzcampaignnamezz", code: "zzcouponcodezz", payout: "777.77", currency: "AED" },
});

/** A PromotionJob whose per-entity work is observable and whose seeding is stubbed. */
function jobOver(store, { onPromote, onOffer, onSeed } = {}) {
  const promoted = [];
  const offers = [];
  let seeds = 0;
  const job = new PromotionJob({
    promotionService: { ensureSuppliersSeeded: async () => { seeds += 1; if (onSeed) onSeed(); } },
    entityRepo: new EntityRepository(),
    rakutenOfferPromotion: {
      persistOfferEntity: async (entity) => {
        offers.push(entity.id);
        return onOffer ? onOffer(entity) : { persisted: 1, skipped: false };
      },
    },
    // Never reachable from a bounded page; present so an accidental call is loud.
    rakutenCommissionPromotion: async () => { throw new Error("zzwhole-sweep rakuten hook reached from a pagezz"); },
  });
  job.entityRepo.findPageForPromotion = (args) =>
    new EntityRepository().findPageForPromotion(args, store.prisma);
  job.promoteEntity = async (entity) => {
    promoted.push(entity.id);
    return onPromote ? onPromote(entity) : { result: "created" };
  };
  return { job, promoted, offers, seedCount: () => seeds, run: (input) => job.runPage(input) };
}

/* --------------------------------------------------------------------- the worker harness --- */

function app({ pageImpl } = {}) {
  const { rows, prisma } = createStore();
  const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts: async () => ["default"], loadAccountState });
  const locks = new SyncAccountLockService({ prisma, now });
  const calls = [];
  const promotionPage = async (input) => {
    calls.push(input);
    if (pageImpl) return pageImpl(input, calls.length);
    return { processed: 0, promoted: 0, skipped: 0, failed: 0, lastCursor: null, hasMore: false };
  };
  const syncPlatformAccount = async (platform, accountLabel) => ({ [accountLabel ?? "default"]: { campaigns: 1 } });
  const locals = { syncOrchestration: orchestration, syncAccountLocks: locks, syncPlatformAccount, promotionPage };
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

/** A stub that ENDS, so an accidental drain loop trips an assertion instead of hanging. */
const fullThenShort = (_input, call) =>
  call === 1
    ? { processed: PROMOTION_PAGE_SIZE, promoted: PROMOTION_PAGE_SIZE, skipped: 0, failed: 0, lastCursor: "e-0049", hasMore: true }
    : { processed: 4, promoted: 4, skipped: 0, failed: 0, lastCursor: "e-0053", hasMore: false };

const promotionUnit = (extra = {}) => ({
  kind: UNIT_KINDS.PROMOTION,
  networkSource: "boostiny",
  entityType: "campaign",
  cursorId: null,
  pageSize: PROMOTION_PAGE_SIZE,
  options: {},
  ...extra,
});

const manyEntities = (count, entityType = "campaign", networkSource = "boostiny") =>
  Array.from({ length: count }, (_, i) => stagedEntity(`e-${String(i).padStart(4, "0")}`, entityType, networkSource));

/* ================================================================================ the tests = */

describe("Phase 6c — a promotion unit is exactly one typed cursor page", () => {
  it("1/20. one page runs per worker invocation, and no second page runs in the same call", async () => {
    resetClock();
    const h = app({ pageImpl: fullThenShort });
    await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });

    const res = await h.worker();
    assert.equal(res.body.status, "unit_completed");
    assert.equal(h.calls.length, 1, "one page per invocation — a drain loop would make this more");
    assert.deepEqual(h.calls[0], {
      networkSource: "boostiny",
      entityType: "campaign",
      cursorId: undefined,
      batchSize: PROMOTION_PAGE_SIZE,
    });

    await h.worker();
    assert.equal(h.calls.length, 2, "the continuation runs on the NEXT invocation, and only it");
    assert.equal(h.calls[1].cursorId, "e-0049");
    assert.equal(h.calls[1].entityType, "campaign", "a continuation never crosses into another type");
  });

  it("2/3. the durable page is keyset by id alone, ascending, with an EXCLUSIVE cursor", async () => {
    const store = createEntityStore(manyEntities(120));
    const runner = jobOver(store);
    await executePromotionUnit(promotionUnit(), { runPage: runner.run });

    assert.equal(store.queries.length, 1, "one query: a unit does not walk");
    const [query] = store.queries;
    assert.deepEqual(query.orderBy, { id: "asc" }, "ordered by id ascending, and by nothing else");
    assert.equal(query.take, PROMOTION_PAGE_SIZE);
    assert.equal(query.where.entityType, "campaign", "one type, never a list");
    assert.equal(query.where.networkSource, "boostiny");
    // Prisma positioning is NOT used: no cursor object, no skip. A re-staged row cannot move the
    // page boundary, because the boundary is a primary-key comparison.
    assert.equal(query.cursor, undefined, "no Prisma cursor positioning");
    assert.equal(query.skip, undefined, "no skip");

    const second = await executePromotionUnit(promotionUnit({ cursorId: "e-0049" }), { runPage: runner.run });
    assert.deepEqual(store.queries[1].where.id, { gt: "e-0049" }, "strictly greater than, never gte");
    assert.equal(second.cursorId, "e-0049");
  });

  it("4. no updatedAt ordering survives in either promotion query", () => {
    const page = codeOnly(REPO_SRC).split("async findPageForPromotion(")[1].split("\n  }")[0];
    assert.ok(!page.includes("updatedAt"), "updatedAt in the durable page query");
    assert.ok(!page.includes("cursor:"), "Prisma cursor positioning in the durable page query");
    assert.ok(!page.includes("skip"), "skip in the durable page query");
    const runPage = codeOnly(JOB_SRC).split("async runPage(")[1].split("\n  }")[0];
    assert.ok(!runPage.includes("updatedAt"), "updatedAt in runPage");
    assert.ok(!runPage.includes("findManyForPromotion"), "the durable page must not use the legacy walk query");
    // The unbounded walk has since been converted to the same keyset shape, for the same reason:
    // updatedAt is mutated by promotion itself, so it can never be a cursor ordering. The two
    // queries stay separate methods, but neither may sort on a mutable column again.
    const walk = codeOnly(REPO_SRC).split("async findManyForPromotion(")[1].split("\n  }")[0];
    assert.ok(!walk.includes("updatedAt"), "updatedAt in the unbounded walk query");
    assert.ok(!walk.includes("cursor:"), "Prisma cursor positioning in the unbounded walk query");
    assert.ok(!walk.includes("skip"), "skip in the unbounded walk query");
    assert.ok(walk.includes('orderBy: { id: "asc" }'), "the unbounded walk must order by id alone");
  });

  it("5. a full page appends exactly one continuation, carrying its last id and its own type", async () => {
    resetClock();
    const h = app({ pageImpl: fullThenShort });
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });

    const res = await h.worker();
    assert.equal(res.body.unitsMaterialised, 1, "exactly one");
    const units = h.units(run.id);
    assert.equal(units.length, 2);
    const [first, second] = units;
    assert.equal(first.status, "COMPLETED");
    assert.equal(second.status, "PENDING");
    assert.equal(second.payload.kind, UNIT_KINDS.PROMOTION);
    assert.equal(second.payload.networkSource, "boostiny");
    assert.equal(second.payload.entityType, "campaign");
    assert.equal(second.payload.cursorId, "e-0049");
    assert.equal(second.payload.pageSize, PROMOTION_PAGE_SIZE);
    assert.equal(second.priority, 2, "appended to the TAIL");
  });

  it("6/7. a short page and an empty page append nothing", async () => {
    resetClock();
    const short = app({ pageImpl: () => ({ processed: 11, promoted: 11, skipped: 0, failed: 0, lastCursor: "e-0010", hasMore: false }) });
    const shortRun = await short.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });
    await short.worker();
    assert.equal(short.units(shortRun.id).length, 1, "a short page ends the walk");
    assert.equal((await short.worker()).body.worked, false);

    resetClock();
    const empty = app({ pageImpl: () => ({ processed: 0, promoted: 0, skipped: 0, failed: 0, lastCursor: null, hasMore: false }) });
    const emptyRun = await empty.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit({ cursorId: "e-9999" })] });
    await empty.worker();
    assert.equal(empty.units(emptyRun.id).length, 1, "an empty page ends the walk");

    // A full page with no last cursor cannot continue: there is nothing to resume from.
    const stuck = await executePromotionUnit(promotionUnit(), {
      runPage: async () => ({ processed: PROMOTION_PAGE_SIZE, promoted: 1, skipped: 0, failed: 0, lastCursor: null, hasMore: true }),
    });
    assert.equal(stuck.hasMore, false);
    assert.equal(nextPromotionUnit(stuck, { kind: UNIT_KINDS.PROMOTION }), null);
  });

  it("8. re-running the same page repeats exactly the same rows", async () => {
    const store = createEntityStore(manyEntities(120));
    const runner = jobOver(store);
    const descriptor = promotionUnit({ cursorId: "e-0019" });
    const first = await executePromotionUnit(descriptor, { runPage: runner.run });
    const seenFirst = runner.promoted.slice();
    runner.promoted.length = 0;
    const second = await executePromotionUnit(descriptor, { runPage: runner.run });

    assert.deepEqual(second, first, "the same page yields the same result");
    assert.deepEqual(runner.promoted, seenFirst, "over exactly the same rows");
    assert.equal(seenFirst.length, PROMOTION_PAGE_SIZE);
    assert.equal(seenFirst[0], "e-0020", "and starts strictly after the cursor");
  });

  it("9. a page that fails halfway leaves the unit retryable and appends nothing", async () => {
    resetClock();
    let attempts = 0;
    const h = app({ pageImpl: () => { attempts += 1; throw new Error("zzpromotion downzz"); } });
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });

    const res = await h.worker();
    assert.equal(res.body.status, "unit_retry");
    assert.equal(h.unit(run.id).status, "PENDING");
    assert.equal(h.unit(run.id).attempt, 1);
    assert.equal(h.units(run.id).length, 1, "a failed page never appends a continuation");
    assert.equal(attempts, 1, "one execution per invocation — no retry loop inside one request");

    await h.worker();
    assert.equal(attempts, 2);
    assert.deepEqual(
      h.calls.map((call) => call.cursorId),
      [undefined, undefined],
      "the retry re-runs the SAME page — the cursor only advances on a COMPLETED page",
    );
    assert.equal(h.units(run.id).length, 1);
  });

  it("10/11. identity covers kind, network, entityType AND cursor, and dedupes a replay", async () => {
    resetClock();
    const h = app();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });

    const distinct = [
      promotionUnit({ cursorId: "e-0049" }),                                   // a later page
      promotionUnit({ entityType: "coupon" }),                                 // another type, same cursor
      promotionUnit({ networkSource: "awin" }),                                // another network
      promotionUnit({ entityType: OFFER_ENTITY_TYPE, networkSource: "rakuten" }),
    ];
    for (const unit of distinct) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await h.orchestration.appendUnits(run.id, [unit])).appended, 1, JSON.stringify(unit.entityType));
    }
    for (const unit of distinct) {
      // eslint-disable-next-line no-await-in-loop
      const replay = await h.orchestration.appendUnits(run.id, [unit]);
      assert.equal(replay.appended, 0, "a replayed continuation is not a second tail");
      assert.equal(replay.skipped, 1);
    }
    assert.deepEqual(
      h.units(run.id).map((u) => `${u.payload.networkSource}/${u.payload.entityType}@${u.payload.cursorId ?? "first"}`),
      [
        "boostiny/campaign@first",
        "boostiny/campaign@e-0049",
        "boostiny/coupon@first",
        "awin/campaign@first",
        "rakuten/offer@first",
      ],
    );
  });

  it("12. a missing, blank or non-string networkSource is refused before any database work", () => {
    for (const networkSource of [undefined, null, "", "   ", 7, {}, ["boostiny"]]) {
      assert.throws(
        () => resolvePromotionPage({ ...promotionUnit(), networkSource }),
        (error) => error.code === PROMOTION_REFUSAL_CODE && error.statusCode === 422,
        JSON.stringify(networkSource ?? null),
      );
    }
    assert.equal(resolvePromotionPage(promotionUnit({ networkSource: " boostiny " })).networkSource, "boostiny");
  });

  it("13/14. an unknown entityType is refused, and a multi-type unit is refused outright", () => {
    for (const entityType of [undefined, null, "", "conversion", "offers", "CAMPAIGN", 7, {}]) {
      assert.throws(
        () => resolvePromotionPage(promotionUnit({ entityType })),
        (error) => error.code === PROMOTION_REFUSAL_CODE,
        JSON.stringify(entityType ?? null),
      );
    }
    // A list is refused in both spellings: as entityType and as the legacy entityTypes.
    assert.throws(
      () => resolvePromotionPage(promotionUnit({ entityType: ["campaign", "coupon"] })),
      (error) => error.code === PROMOTION_REFUSAL_CODE && error.message.includes("one entityType"),
    );
    assert.throws(
      () => resolvePromotionPage(promotionUnit({ entityTypes: ["campaign", "coupon"] })),
      (error) => error.code === PROMOTION_REFUSAL_CODE && error.message.includes("entityTypes"),
    );
    for (const entityType of PROMOTION_ENTITY_TYPES) {
      const network = entityType === OFFER_ENTITY_TYPE ? "rakuten" : "boostiny";
      assert.equal(resolvePromotionPage(promotionUnit({ entityType, networkSource: network })).entityType, entityType);
    }
    // The durable page query is given a single type, never an array.
    const runPage = codeOnly(JOB_SRC).split("async runPage(")[1].split("\n  }")[0];
    assert.ok(!runPage.includes("entityTypes"), "a plural type reaches the durable query");
  });

  it("15/16/17. entityIds, date windows and a non-fixed page size are all refused", () => {
    assert.throws(
      () => resolvePromotionPage(promotionUnit({ entityIds: ["e-0001"] })),
      (error) => error.code === PROMOTION_REFUSAL_CODE && error.message.includes("entityIds"),
    );
    for (const field of ["from", "to", "windowStart", "windowEnd", "day", "days"]) {
      assert.throws(
        () => resolvePromotionPage(promotionUnit({ [field]: "2026-09-01" })),
        (error) => error.code === PROMOTION_REFUSAL_CODE && error.message.includes(field),
        field,
      );
    }
    for (const pageSize of [1, 49, 51, 100, 1000, "50"]) {
      assert.throws(
        () => resolvePromotionPage(promotionUnit({ pageSize })),
        (error) => error.code === PROMOTION_REFUSAL_CODE,
        String(pageSize),
      );
    }
    assert.equal(resolvePromotionPage(promotionUnit({ pageSize: undefined })).pageSize, PROMOTION_PAGE_SIZE);
    // A blank or non-string cursor is refused; absent means "first page".
    assert.throws(() => resolvePromotionPage(promotionUnit({ cursorId: "  " })), (error) => error.code === PROMOTION_REFUSAL_CODE);
    assert.throws(() => resolvePromotionPage(promotionUnit({ cursorId: 12 })), (error) => error.code === PROMOTION_REFUSAL_CODE);
    assert.equal(resolvePromotionPage(promotionUnit()).cursorId, null);
    // None of them reaches the service either.
    const execute = codeOnly(UNIT_SRC).split("export async function executePromotionUnit(")[1].split("\n}\n")[0];
    // As PROPERTIES, not as words: "to" is a substring of half the identifiers in any function.
    for (const field of ["entityIds", "entityTypes", "from", "to", "windowStart", "windowEnd", "day", "days"]) {
      assert.ok(!new RegExp(`\\b${field}\\s*:`).test(execute), `${field} forwarded to the page runner`);
    }
    // The page runner CALL is handed exactly four things and nothing else.
    const args = execute.split("runPage({")[1].split("});")[0];
    const forwarded = (args.match(/([a-zA-Z]+)\s*:/g) ?? []).map((token) => token.replace(/\s*:/, ""));
    assert.deepEqual(forwarded.sort(), ["batchSize", "cursorId", "entityType", "networkSource"]);
  });

  it("18. the result projection carries counts and position only — never a raw payload", async () => {
    const store = createEntityStore(manyEntities(60));
    const runner = jobOver(store, { onPromote: (entity) => ({ result: entity.id.endsWith("3") ? "skipped" : "created" }) });
    const result = await executePromotionUnit(promotionUnit(), { runPage: runner.run });
    const outcome = summarisePromotionUnitOutcome(result);

    assert.deepEqual(Object.keys(outcome).sort(), ["counts", "entityType", "hasMore", "kind", "networkSource", "pageSize"]);
    assert.deepEqual(Object.keys(outcome.counts).sort(), ["failed", "processed", "promoted", "skipped"]);
    assert.equal(outcome.counts.processed, PROMOTION_PAGE_SIZE);
    assert.equal(outcome.counts.promoted + outcome.counts.skipped + outcome.counts.failed, PROMOTION_PAGE_SIZE);
    const serialised = JSON.stringify(outcome);
    for (const marker of ["zzrawpayloadzz", "zzcampaignnamezz", "zzcouponcodezz", "777.77", "AED", "rawData", "e-0000", "e-0049"]) {
      assert.ok(!serialised.includes(marker), marker);
    }

    resetClock();
    const h = app({ pageImpl: fullThenShort });
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit({ cursorId: "e-0000" })] });
    const res = await h.worker();
    const body = JSON.stringify(res.body);
    for (const marker of ["zzrawpayloadzz", "zzcampaignnamezz", "zzcouponcodezz", "777.77", "e-0000", "e-0049"]) {
      assert.ok(!body.includes(marker), `${marker} in the response`);
    }
    assert.deepEqual(res.body.unit.promotionPage, {
      networkSource: "boostiny",
      entityType: "campaign",
      pageSize: PROMOTION_PAGE_SIZE,
      continued: true,
    });
    const completed = h.units(run.id).find((u) => u.status === "COMPLETED");
    assert.equal(completed.result.outcome.kind, "promotion");
    assert.equal(completed.result.outcome.entityType, "campaign");
    assert.ok(!JSON.stringify(completed.result).includes("zzrawpayloadzz"));
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
    assert.deepEqual(fetches, [], "a promotion unit never reaches the network");
    assert.ok(!/^\s*import\s/m.test(UNIT_SRC), "the unit primitive has no imports");
    for (const forbidden of ["axios", "fetch(", "http", "Client", "apiKey", "token"]) {
      assert.ok(!UNIT_SRC.includes(forbidden), forbidden);
    }
  });

  it("21. the GLOBAL promotion stage lock is enforced, and stale-claim behaviour is unchanged", async () => {
    resetClock();
    const h = app({ pageImpl: () => ({ processed: 2, promoted: 2, skipped: 0, failed: 0, lastCursor: "e-0001", hasMore: false }) });
    await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });

    const key = unitLockKey({ kind: UNIT_KINDS.PROMOTION, networkSource: "boostiny", entityType: "campaign" });
    assert.equal(key, stageLockKey(UNIT_KINDS.PROMOTION, null), "one global key, not per network or per type");
    // A coupon page of another network resolves to the SAME key, so two pages never run at once.
    assert.equal(unitLockKey({ kind: UNIT_KINDS.PROMOTION, networkSource: "awin", entityType: "coupon" }), key);

    const crashed = await h.locks.acquire(key, { holderId: "crashed-instance" });
    assert.equal(crashed.acquired, true);
    assert.equal((await h.worker()).statusCode, 409, "a live lease is never stolen");
    assert.equal(h.calls.length, 0, "and no page runs behind it");
    advance(DEFAULT_LEASE_MS + 1000);
    assert.equal((await h.worker()).body.worked, true, "an expired lease is reclaimable");
    resetClock();
  });

  it("22. executable:false still refuses a promotion unit, and maxAttempts is unchanged", async () => {
    assert.equal(isUnitExecutable({ kind: UNIT_KINDS.PROMOTION }), true);
    assert.equal(isUnitExecutable({ kind: UNIT_KINDS.PROMOTION, executable: false }), false);
    assert.equal(isUnitExecutable({ payload: { kind: UNIT_KINDS.PROMOTION, executable: false } }), false);
    assert.throws(() => assertUnitExecutable({ kind: UNIT_KINDS.PROMOTION, executable: false }), (error) => error.code === "unit_not_executable");

    resetClock();
    const blocked = app();
    await blocked.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit({ executable: false })] });
    assert.equal((await blocked.worker()).body.worked, false, "a blocked placeholder is never worked");
    assert.equal(blocked.calls.length, 0, "and nothing is promoted for it");

    resetClock();
    const failing = app({ pageImpl: () => { throw new Error("zzpromotion downzz"); } });
    const run = await failing.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [promotionUnit()] });
    assert.equal(failing.units(run.id)[0].maxAttempts, DEFAULT_UNIT_MAX_ATTEMPTS);
    assert.equal(DEFAULT_UNIT_MAX_ATTEMPTS, 3);
    assert.equal((await failing.worker()).body.status, "unit_retry");
    assert.equal((await failing.worker()).body.status, "unit_retry");
    assert.equal((await failing.worker()).body.status, "unit_failed");
    assert.equal(failing.units(run.id)[0].status, "DEAD_LETTER");
  });

  it("26/28. Rakuten commission work runs once per OFFER, and never from a campaign or coupon page", async () => {
    // A campaign page and a coupon page touch the offer writer zero times, however many rows they
    // promote. The whole-sweep hook throws if reached, so an accidental call fails loudly.
    for (const entityType of ["campaign", "coupon"]) {
      const store = createEntityStore(manyEntities(60, entityType, "rakuten"));
      const runner = jobOver(store);
      // eslint-disable-next-line no-await-in-loop
      const result = await executePromotionUnit(promotionUnit({ entityType, networkSource: "rakuten" }), { runPage: runner.run });
      assert.equal(result.processed, PROMOTION_PAGE_SIZE);
      assert.deepEqual(runner.offers, [], `${entityType} page reached the Rakuten commission writer`);
    }

    // An offer page promotes each offer EXACTLY once, through the per-offer writer.
    const store = createEntityStore(manyEntities(60, "offer", "rakuten"));
    const runner = jobOver(store);
    const first = await executePromotionUnit(
      promotionUnit({ entityType: OFFER_ENTITY_TYPE, networkSource: "rakuten" }),
      { runPage: runner.run },
    );
    assert.equal(first.processed, PROMOTION_PAGE_SIZE);
    assert.equal(first.promoted, PROMOTION_PAGE_SIZE);
    assert.equal(runner.offers.length, PROMOTION_PAGE_SIZE, "one write per offer");
    assert.equal(new Set(runner.offers).size, PROMOTION_PAGE_SIZE, "and no offer twice");

    // The continuation stays on offers and starts strictly after the last one.
    const next = nextPromotionUnit(first, { kind: UNIT_KINDS.PROMOTION });
    assert.equal(next.entityType, OFFER_ENTITY_TYPE);
    assert.equal(next.cursorId, "e-0049");

    // An offer unit is refused for any other network, so no other network can reach this writer.
    for (const networkSource of ["boostiny", "awin", "admitad", "RAKUTEN-ish"]) {
      assert.throws(
        () => resolvePromotionPage(promotionUnit({ entityType: OFFER_ENTITY_TYPE, networkSource })),
        (error) => error.code === PROMOTION_REFUSAL_CODE,
        networkSource,
      );
    }
    // And the bounded job path never calls the whole-sweep hook at all.
    const runPage = codeOnly(JOB_SRC).split("async runPage(")[1].split("\n  }")[0];
    assert.ok(!runPage.includes("rakutenCommissionPromotion"), "the whole-sweep hook is reachable from a page");
    assert.ok(!runPage.includes("persistStagedOffers"), "the capped whole sweep is reachable from a page");
  });

  it("27. re-running an offer page re-promotes exactly the same offers", async () => {
    const store = createEntityStore(manyEntities(60, "offer", "rakuten"));
    const runner = jobOver(store);
    const descriptor = promotionUnit({ entityType: OFFER_ENTITY_TYPE, networkSource: "rakuten", cursorId: "e-0004" });

    const first = await executePromotionUnit(descriptor, { runPage: runner.run });
    const seenFirst = runner.offers.slice();
    runner.offers.length = 0;
    const second = await executePromotionUnit(descriptor, { runPage: runner.run });

    assert.deepEqual(second, first, "the same page yields the same result");
    assert.deepEqual(runner.offers, seenFirst, "over exactly the same offers");
    assert.equal(seenFirst[0], "e-0005", "starting strictly after the cursor");
    // A skipped offer (its advertiser campaign is not promoted yet) is counted, never failed: the
    // page must not dead-letter because Phase 6d has not run campaigns first.
    const skipping = jobOver(store, { onOffer: () => ({ persisted: 0, skipped: true, reason: "supplier_campaign_not_promoted" }) });
    const skipped = await executePromotionUnit(descriptor, { runPage: skipping.run });
    assert.equal(skipped.skipped, PROMOTION_PAGE_SIZE);
    assert.equal(skipped.failed, 0);
    assert.equal(skipped.promoted, 0);
  });

  it("nothing on the path loops across pages, recurses or detaches a promise", () => {
    const helper = CONTROLLER_SRC.split("async function appendPromotionContinuation(")[1].split("\n}\n")[0];
    const seam = CONTROLLER_SRC.split("function promotionPageFor(")[1].split("\n}\n")[0];
    for (const source of [UNIT_SRC, helper, seam].map(codeOnly)) {
      for (const forbidden of ["for (", "for(", "while (", "while(", "setTimeout", "setInterval", "setImmediate", ".then(", ".catch(", "void ", "Promise.all", "Promise.race"]) {
        assert.ok(!source.includes(forbidden), forbidden);
      }
    }
    // runPage iterates the rows OF ITS PAGE, which is not a page loop. What it must never do is
    // fetch another page, so the query may appear exactly once.
    const runPage = codeOnly(JOB_SRC).split("async runPage(")[1].split("\n  }")[0];
    assert.equal((runPage.match(/findPageForPromotion\(/g) ?? []).length, 1, "runPage fetches more than one page");
    assert.ok(!runPage.includes("while ("), "runPage drains");
    assert.ok(!runPage.includes("runPage("), "runPage recurses");
    assert.equal((codeOnly(UNIT_SRC).match(/executePromotionUnit\(/g) ?? []).length, 1, "the unit entrypoint calls itself");
    for (const source of [helper, seam].map(codeOnly)) {
      assert.ok(!source.includes("executePromotionUnit("), "re-entered from the controller");
    }
    assert.match(seam, /new PromotionJob\(\)\.runPage\(input\)/);
    assert.ok(!/PromotionJob\(\)\s*\.\s*run\(/.test(CONTROLLER_SRC), "the unbounded drain is reachable");
  });

  it("promotionPageHasMore is the page's own stop condition, not a guess", () => {
    assert.equal(promotionPageHasMore({ processed: PROMOTION_PAGE_SIZE }), true);
    assert.equal(promotionPageHasMore({ processed: PROMOTION_PAGE_SIZE - 1 }), false);
    assert.equal(promotionPageHasMore({ processed: 0 }), false);
    assert.equal(promotionPageHasMore({ processed: PROMOTION_PAGE_SIZE + 1 }), true, "never under-reports");
    assert.equal(promotionPageHasMore({ processed: undefined }), false);
    assert.equal(promotionPageHasMore({ processed: Number.NaN }), false);
    assert.equal(promotionPageHasMore({}), false);
  });

  it("supplier seeds are ensured on every page, before any row is promoted", async () => {
    const store = createEntityStore(manyEntities(10));
    const order = [];
    const runner = jobOver(store, { onSeed: () => order.push("seed"), onPromote: () => { order.push("promote"); return { result: "created" }; } });
    await executePromotionUnit(promotionUnit(), { runPage: runner.run });
    assert.equal(runner.seedCount(), 1, "once per page");
    assert.equal(order[0], "seed", "before the first row is promoted");
    assert.equal(order.filter((step) => step === "seed").length, 1);

    await executePromotionUnit(promotionUnit({ cursorId: "e-0004" }), { runPage: runner.run });
    assert.equal(runner.seedCount(), 2, "and again on the next page — five idempotent upserts");
  });
});
