/**
 * Optimise commission groups as bounded campaign chunks.
 *
 * GET /campaigns/{campaignId}/commission-groups is one supplier request per campaign at the
 * 12.5 s Optimise limiter, so an account-wide commission-group unit cannot finish inside an
 * invocation. It is NOT dropped for that reason: these rules feed SupplierCommissionRule and are
 * financially load-bearing. Instead a unit names a fixed-size slice of the account's campaigns.
 *
 * The campaign list is only knowable once the account's campaigns unit has staged it, so the
 * chunks are materialised at that unit's completion — from a single read of the rows it just
 * wrote, never a supplier fan-out.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { triggerSyncWorker } from "../src/controllers/sync.controller.js";
import {
  UNIT_JOB_NAME,
  UNIT_KINDS,
  OPTIMISE_COMMISSION_GROUP_CHUNK_SIZE,
  SyncOrchestrationService,
} from "../src/jobs/syncOrchestration.service.js";
import { accountLockKey } from "../src/jobs/syncAccountLock.service.js";
import {
  chunkCommissionGroupCampaignIds,
  filterCampaignRowsToChunk,
  orderedCommissionGroupCampaignIds,
} from "../src/jobs/optimiseCommissionGroupSync.js";
import { sourcesMaterialisedAfter } from "../src/jobs/syncSourcePlan.js";

const SERVICE_SRC = readFileSync(new URL("../src/jobs/syncOrchestration.service.js", import.meta.url), "utf8");
const OPTIMISE_SRC = readFileSync(new URL("../src/jobs/optimiseCommissionGroupSync.js", import.meta.url), "utf8");
const SYNC_JOB_SRC = readFileSync(new URL("../src/jobs/sync.job.js", import.meta.url), "utf8");

const NOW = new Date("2026-09-15T00:00:00.000Z");
const now = () => NOW;
const SIZE = OPTIMISE_COMMISSION_GROUP_CHUNK_SIZE;

/** Campaign ids as the supplier would report them, zero-padded so the order is unambiguous. */
const campaignId = (n) => `c${String(n).padStart(3, "0")}`;
/** `status: "live"` is what the Optimise mapper reads as a JOINED publisher relationship. */
const joinedRow = (n) => ({ campaignId: campaignId(n), status: "live", currencyCode: "USD" });

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
  const apply = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
      else row[k] = v;
    }
  };
  const jobRun = {
    async create({ data }) {
      seq += 1;
      const row = { id: `row-${String(seq).padStart(4, "0")}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(NOW.getTime() + seq), ...data };
      rows.push(row); return clone(row);
    },
    async update({ where, data }) { const row = rows.find((r) => r.id === where.id); apply(row, data); return clone(row); },
    async updateMany({ where, data }) { let count = 0; for (const row of rows) if (match(row, where)) { apply(row, data); count += 1; } return { count }; },
    async findUnique({ where }) { const row = rows.find((r) => r.id === where.id); return row ? clone(row) : null; },
    async findFirst({ where, orderBy }) { const list = sort(rows.filter((r) => match(r, where)), orderBy); return list.length ? clone(list[0]) : null; },
    async findMany({ where, orderBy }) { return sort(rows.filter((r) => match(r, where ?? {})), orderBy).map(clone); },
    async deleteMany({ where }) {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (match(rows[i], where)) { rows.splice(i, 1); count += 1; }
      }
      return { count };
    },
  };
  return { rows, prisma: { jobRun, async $transaction(fn) { return fn({ jobRun }); } } };
}

/**
 * A run with just the two Optimise units that matter here: the campaigns unit whose completion
 * materialises the chunks, and one unrelated unit after it.
 */
function harness({ campaigns = 0, chunkPlan = null } = {}) {
  const { rows, prisma } = createStore();
  const planCalls = [];
  const planCommissionGroupChunks = async (args) => {
    planCalls.push(args);
    if (chunkPlan) return chunkPlan(args);
    const ids = Array.from({ length: campaigns }, (_, i) => campaignId(i + 1));
    return {
      chunks: chunkCommissionGroupCampaignIds(ids, SIZE).map((campaignIds, index) => ({ index, campaignIds })),
      campaignIds: ids,
      chunkSize: SIZE,
    };
  };
  const orchestration = new SyncOrchestrationService({
    prisma,
    now,
    listAccounts: async () => ["default"],
    loadAccountState: async () => ({ lastSuccessfulSync: null }),
    planCommissionGroupChunks,
  });
  const calls = [];
  const locals = {
    syncOrchestration: orchestration,
    syncPlatformAccount: async (platform, accountLabel, options) => {
      calls.push({ platform, accountLabel, options });
      return { [accountLabel ?? "default"]: { campaigns: 1 } };
    },
  };
  const worker = async () => {
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await triggerSyncWorker({ app: { locals } }, res, (error) => { throw error; });
    return res;
  };
  const unitsOf = (runId) => rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId);
  return { rows, prisma, orchestration, calls, planCalls, worker, unitsOf };
}

async function runWithCampaignsUnit(h) {
  const run = await h.orchestration.createRun({
    kind: "full",
    trigger: "api",
    options: { promoteAfter: false },
    units: [
      { kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "campaigns", options: { fastSync: false } },
      { kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "voucher_codes", options: { fastSync: false } },
    ],
  });
  return run;
}

const chunksOf = (h, runId) =>
  h.unitsOf(runId).filter((u) => u.payload.sourceObject === "commission_groups");

describe("campaign chunking", () => {
  it("one campaign is one chunk", () => {
    const chunks = chunkCommissionGroupCampaignIds([campaignId(1)], SIZE);
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0], [campaignId(1)]);
  });

  it("exactly chunkSize campaigns is one chunk; one more is two", () => {
    const exact = Array.from({ length: SIZE }, (_, i) => campaignId(i + 1));
    assert.equal(chunkCommissionGroupCampaignIds(exact, SIZE).length, 1);
    const overflow = [...exact, campaignId(SIZE + 1)];
    const chunks = chunkCommissionGroupCampaignIds(overflow, SIZE);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, SIZE);
    assert.deepEqual(chunks[1], [campaignId(SIZE + 1)]);
  });

  it("the chunk size is a named constant, pinned", () => {
    assert.equal(OPTIMISE_COMMISSION_GROUP_CHUNK_SIZE, 8);
    assert.match(OPTIMISE_SRC, /export const OPTIMISE_COMMISSION_GROUP_CHUNK_SIZE = 8;/);
    // 8 campaigns × the 12.5s Optimise limiter ≈ 100s of supplier time per unit.
    assert.ok(OPTIMISE_COMMISSION_GROUP_CHUNK_SIZE * 12.5 < 200, "comfortably inside one invocation");
  });

  it("no campaign is duplicated or lost, at any size", () => {
    for (const total of [0, 1, SIZE - 1, SIZE, SIZE + 1, SIZE * 3, SIZE * 3 + 5]) {
      const ids = Array.from({ length: total }, (_, i) => campaignId(i + 1));
      const chunks = chunkCommissionGroupCampaignIds(ids, SIZE);
      const flat = chunks.flat();
      assert.deepEqual(flat, ids, `total=${total}: every id exactly once, in order`);
      assert.equal(new Set(flat).size, total, `total=${total}: no duplicate`);
      assert.equal(chunks.length, Math.ceil(total / SIZE));
      assert.ok(chunks.every((chunk) => chunk.length <= SIZE), "no chunk exceeds the constant");
      assert.ok(chunks.slice(0, -1).every((chunk) => chunk.length === SIZE), "only the last chunk is short");
    }
  });

  it("ordering is stable whatever order the staging table returns", () => {
    const rows = [5, 2, 9, 1, 7].map(joinedRow);
    const forward = orderedCommissionGroupCampaignIds(rows).campaignIds;
    assert.deepEqual(forward, [1, 2, 5, 7, 9].map(campaignId), "ordered by campaign id, not by row order");
    const shuffled = orderedCommissionGroupCampaignIds([...rows].reverse()).campaignIds;
    assert.deepEqual(forward, shuffled, "the same set plans the same order");
    // The existing selection rules are untouched: a row with no usable id is still skipped, and
    // a campaign this publisher has not joined is still out of scope.
    const withJunk = orderedCommissionGroupCampaignIds([...rows, { name: "no id" }, { campaignId: "c404", status: "notapplied" }]);
    assert.deepEqual(withJunk.campaignIds, forward);
    // The chunk boundaries therefore fall in the same places however the rows arrive.
    assert.deepEqual(
      chunkCommissionGroupCampaignIds(forward, 2),
      chunkCommissionGroupCampaignIds(shuffled, 2),
    );
  });
});

describe("materialisation after the campaigns unit", () => {
  it("the campaigns unit's completion appends one unit per chunk, in order", async () => {
    const h = harness({ campaigns: SIZE * 2 + 1 });
    const run = await runWithCampaignsUnit(h);
    assert.equal(chunksOf(h, run.id).length, 0, "nothing is planned before the campaigns unit runs");

    const res = await h.worker();
    assert.equal(res.body.worked, true);
    assert.equal(res.body.unit.sourceObject, "campaigns");
    assert.equal(res.body.unitsMaterialised, 3);

    const chunks = chunksOf(h, run.id);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks.map((u) => u.payload.campaignChunkIndex), [0, 1, 2]);
    assert.deepEqual(chunks.map((u) => u.payload.campaignIds.length), [SIZE, SIZE, 1]);
    assert.ok(chunks.every((u) => u.payload.campaignChunkCount === 3));
    assert.ok(chunks.every((u) => u.status === "PENDING"));
    // Appended after the units that already existed, with contiguous sequences.
    const sequences = h.unitsOf(run.id).map((u) => u.priority).sort((a, b) => a - b);
    assert.deepEqual(sequences, [1, 2, 3, 4, 5]);
    assert.ok(chunks.every((u) => u.payload.parentRunId === run.id));
    // Discovery asked for exactly this account, and no supplier call was made for it.
    assert.deepEqual(h.planCalls, [{ platform: "optimise_sea", accountLabel: "default" }]);
    assert.equal(h.calls.length, 1, "only the campaigns unit ran supplier work");
  });

  it("every campaign appears in exactly one chunk unit", async () => {
    const h = harness({ campaigns: SIZE * 4 + 3 });
    const run = await runWithCampaignsUnit(h);
    await h.worker();
    const ids = chunksOf(h, run.id).flatMap((u) => u.payload.campaignIds);
    assert.equal(ids.length, SIZE * 4 + 3);
    assert.equal(new Set(ids).size, ids.length, "no campaign is requested twice");
    assert.deepEqual(ids, [...ids].sort(), "and the union is the whole ordered list");
  });

  it("an account with no campaigns materialises nothing and reports nothing", async () => {
    const h = harness({ campaigns: 0 });
    const run = await runWithCampaignsUnit(h);
    const res = await h.worker();
    assert.equal(res.body.worked, true);
    assert.equal(res.body.unitsMaterialised, undefined);
    assert.equal(chunksOf(h, run.id).length, 0);
  });

  it("replaying the same completion does not double-plan a chunk", async () => {
    const h = harness({ campaigns: SIZE + 2 });
    const run = await runWithCampaignsUnit(h);
    const campaignsUnit = h.unitsOf(run.id)[0];
    const descriptor = campaignsUnit.payload;
    // The worker passes the unit it is completing; the deferral waits on every OTHER slice.
    const opts = { completingUnitId: campaignsUnit.id };
    await h.orchestration.materialiseFollowOnUnits(run.id, descriptor, null, opts);
    const first = chunksOf(h, run.id).length;
    assert.equal(first, 2);
    const again = await h.orchestration.materialiseFollowOnUnits(run.id, descriptor, null, opts);
    assert.equal(again.appended, 0);
    assert.equal(again.skipped, 2);
    assert.equal(chunksOf(h, run.id).length, first, "the run still has exactly one unit per chunk");
  });

  it("only the campaigns source object materialises chunks, and only for Optimise", async () => {
    assert.deepEqual(sourcesMaterialisedAfter("optimise_sea", "campaigns"), ["commission_groups"]);
    assert.deepEqual(sourcesMaterialisedAfter("optimise_sea", "conversions"), []);
    assert.deepEqual(sourcesMaterialisedAfter("boostiny", "campaigns"), []);
    assert.deepEqual(sourcesMaterialisedAfter("trackier", "campaigns"), []);

    const h = harness({ campaigns: SIZE });
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", sourceObject: "campaigns", options: {} }],
    });
    await h.worker();
    assert.equal(chunksOf(h, run.id).length, 0);
    assert.equal(h.planCalls.length, 0, "no discovery for a network that has no deferred source");
  });

  it("a finished run is never resurrected by a late materialisation", async () => {
    const h = harness({ campaigns: SIZE });
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "campaigns", options: {} }],
    });
    const unit = await h.orchestration.nextUnit(run.id);
    await h.orchestration.claimUnit(unit.id, { workerId: "w" });
    await h.orchestration.completeUnit(unit.id, { ok: true });
    // The run has already finalised on its only unit; appending now would contradict that.
    assert.equal(h.rows.find((r) => r.id === run.id).status, "COMPLETED");
    const result = await h.orchestration.materialiseFollowOnUnits(run.id, unit.payload);
    assert.equal(result.appended, 0);
    assert.equal(result.reason, "run_terminal");
  });
});

describe("a chunk unit executes only its own campaigns", () => {
  it("the worker forwards that chunk's campaign ids and nothing else", async () => {
    const h = harness({ campaigns: SIZE + 1 });
    const run = await runWithCampaignsUnit(h);
    await h.worker(); // campaigns unit → materialises 2 chunks
    await h.worker(); // voucher_codes
    const first = await h.worker();
    const second = await h.worker();

    assert.equal(first.body.unit.sourceObject, "commission_groups");
    assert.deepEqual(first.body.unit.campaignChunk, { index: 0, of: 2, campaignCount: SIZE });
    assert.deepEqual(second.body.unit.campaignChunk, { index: 1, of: 2, campaignCount: 1 });

    const chunkCalls = h.calls.filter((c) => c.options.sourceObject === "commission_groups");
    assert.equal(chunkCalls.length, 2, "one chunk per invocation");
    assert.equal(chunkCalls[0].options.campaignIds.length, SIZE);
    assert.deepEqual(chunkCalls[1].options.campaignIds, [campaignId(SIZE + 1)]);
    assert.equal(chunkCalls[0].options.promoteAfter, false);
    assert.equal(chunkCalls[0].options.windowStart, undefined, "a campaign chunk carries no date window");
    // The two invocations never overlap on a campaign.
    const all = chunkCalls.flatMap((c) => c.options.campaignIds);
    assert.equal(new Set(all).size, all.length);
  });

  it("every chunk of an account takes the same account lock, and holds it against its siblings", async () => {
    const h = harness({ campaigns: SIZE * 2 });
    const run = await runWithCampaignsUnit(h);
    await h.worker();
    const chunks = chunksOf(h, run.id);
    const expected = accountLockKey({ platform: "optimise_sea", accountLabel: "default" });
    assert.deepEqual([...new Set(chunks.map((u) => u.payload.lockKey))], [expected]);
    assert.equal(expected, "network:optimise_sea:default");
    assert.ok(chunks.every((u) => !u.payload.lockKey.includes("commission")), "never chunk-scoped");

    assert.equal((await h.orchestration.claimUnit(chunks[0].id, { workerId: "a" })).claimed, true);
    const sibling = await h.orchestration.claimUnit(chunks[1].id, { workerId: "b" });
    assert.equal(sibling.claimed, false, "two chunks of one account never run at once");
    assert.equal(sibling.reason, "lock_held");
  });

  it("retrying a chunk re-requests exactly the same campaigns", async () => {
    const h = harness({ campaigns: SIZE });
    const run = await runWithCampaignsUnit(h);
    await h.worker();
    const chunk = chunksOf(h, run.id)[0];
    const ids = [...chunk.payload.campaignIds];

    await h.orchestration.claimUnit(chunk.id, { workerId: "first" });
    await h.orchestration.failUnit(chunk.id, new Error("zzsupplierzz"));
    assert.equal(h.rows.find((r) => r.id === chunk.id).status, "PENDING", "retryable");
    const retried = h.rows.find((r) => r.id === chunk.id);
    assert.deepEqual(retried.payload.campaignIds, ids, "the slice is stored on the unit, so a retry cannot drift");
    assert.equal(retried.payload.campaignChunkIndex, chunk.payload.campaignChunkIndex);

    await h.orchestration.claimUnit(chunk.id, { workerId: "second" });
    assert.equal(h.rows.find((r) => r.id === chunk.id).attempt, 2);
  });

  it("the chunk filter keeps exactly the named campaigns and drops every other row", () => {
    const rows = [1, 2, 3, 4, 5].map(joinedRow);
    const slice = [campaignId(2), campaignId(4)];
    const filtered = filterCampaignRowsToChunk(rows, slice);
    assert.deepEqual(filtered.map((r) => r.campaignId), slice, "only this chunk's campaigns survive");
    assert.equal(filterCampaignRowsToChunk(rows, [campaignId(99)]).length, 0, "an id this account does not have selects nothing");
    // Two chunks of one account never overlap, and together they cover the account exactly once.
    const a = filterCampaignRowsToChunk(rows, [campaignId(1), campaignId(2)]).map((r) => r.campaignId);
    const b = filterCampaignRowsToChunk(rows, [campaignId(3), campaignId(4), campaignId(5)]).map((r) => r.campaignId);
    assert.equal(new Set([...a, ...b]).size, 5);
    assert.deepEqual([...a, ...b].sort(), rows.map((r) => r.campaignId));
    // No slice means no narrowing: an account-wide unit still sees every row, as it always did.
    assert.equal(filterCampaignRowsToChunk(rows, null).length, 5);
    assert.equal(filterCampaignRowsToChunk(rows, []).length, 5);
    // A row whose id is absent is never matched by accident.
    assert.equal(filterCampaignRowsToChunk([{ name: "no id" }], slice).length, 0);
  });

  it("the sync layer requests only the named campaigns, through the existing selection", () => {
    // The filter is applied to the campaign ROWS, so scope, currency and id extraction stay the
    // existing ones; a chunk narrows which campaigns are considered, nothing else.
    assert.match(SYNC_JOB_SRC, /const chunkCampaignIds = boundedCampaignIds\(\);/);
    assert.match(SYNC_JOB_SRC, /campaignRowsForGroups = filterCampaignRowsToChunk\(campaignRowsForGroups, chunkCampaignIds\);/);
    // A chunk unit filters the campaigns source object out, so the staged rows are the only
    // campaign list it can have: the fallback must fire on a SKIPPED fetch too, not only on a
    // warm cache, or a chunk would find no campaigns and quietly fetch nothing.
    assert.match(
      SYNC_JOB_SRC,
      /if \(!campaignRowsForGroups\.length && \(campaignsResult\.skipped \|\| !refreshCampaigns\)\)/,
    );
    // Persistence is per campaign, so a chunk cannot close another chunk's open rules.
    assert.ok(!/deleteMany[\s\S]{0,200}commission_groups/.test(SYNC_JOB_SRC));
  });

  it("status shows chunk position and size, never a campaign identifier", async () => {
    const h = harness({ campaigns: SIZE + 1 });
    const run = await runWithCampaignsUnit(h);
    await h.worker();
    const summaries = (await h.orchestration.inspectRun(run.id)).units.filter((u) => u.sourceObject === "commission_groups");
    assert.deepEqual(summaries.map((u) => u.campaignChunk), [
      { index: 0, of: 2, campaignCount: SIZE },
      { index: 1, of: 2, campaignCount: 1 },
    ]);
    const serialised = JSON.stringify(summaries);
    assert.ok(!serialised.includes(campaignId(1)), "no campaign id reaches the projection");
    assert.ok(!/campaignIds/.test(serialised));
    // A unit that is not a chunk says so plainly rather than inventing a position.
    const other = (await h.orchestration.inspectRun(run.id)).units.find((u) => u.sourceObject === "voucher_codes");
    assert.equal(other.campaignChunk, null);
  });
});

describe("source guards", () => {
  it("appending is idempotent, bounded to an active run, and keeps the account lock key", () => {
    const append = SERVICE_SRC.split("  async appendUnits(")[1].split("\n  }")[0];
    assert.match(append, /if \(TERMINAL_STATUSES\.includes\(parent\.status\)\)/, "never resurrects a finished run");
    assert.match(append, /identities\.has\(unitIdentity\(unit\)\)/, "a known unit is skipped, not duplicated");
    assert.match(append, /lockKey: unitLockKey\(unit\)/, "the shared account lock, same as any other unit");
    assert.ok(!append.includes("$transaction"), "appending is additive; it never rewrites the plan");
  });

  it("materialisation performs no supplier work and no promotion", () => {
    const materialise = SERVICE_SRC.split("  async materialiseFollowOnUnits(")[1].split("\n  }")[0];
    assert.match(materialise, /promoteAfter: false/);
    for (const forbidden of ["adapter", "fetchOptimise", "httpClient", "createSupplierAdapter", "axios"]) {
      assert.ok(!materialise.includes(forbidden), `${forbidden} has no place in materialisation`);
    }
    // Its only outward calls are the staged-row plan and the durable append.
    assert.match(materialise, /await this\.planCommissionGroupChunks\(/);
    assert.match(materialise, /await this\.appendUnits\(/);
  });
});

describe("orchestration hardening around deferred materialisation", () => {
  it("the last pending unit materialises its chunks BEFORE the parent can finalise", async () => {
    const h = harness({ campaigns: SIZE + 1 });
    // The campaigns unit is the ONLY unit: completing it would finalise the run.
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "campaigns", options: {} }],
    });
    const res = await h.worker();
    assert.equal(res.body.worked, true);
    assert.equal(res.body.unitsMaterialised, 2);

    const parent = h.rows.find((r) => r.id === run.id);
    assert.equal(parent.status, "RUNNING", "the run cannot be terminal while its new chunks are pending");
    assert.equal(parent.completedAt, null);
    const status = await h.orchestration.describeRun(run.id);
    assert.equal(status.status, "running");
    assert.equal(status.totalUnits, 3, "totalUnits legitimately grew");
    assert.equal(status.pendingUnits, 2);
    assert.equal(status.finishedAt, null);

    // The run settles only once the chunks themselves are done.
    await h.worker();
    await h.worker();
    assert.equal(h.rows.find((r) => r.id === run.id).status, "COMPLETED");
    assert.equal((await h.orchestration.describeRun(run.id)).status, "success");
  });

  it("zero eligible campaigns resolves the deferral and lets the parent settle", async () => {
    const h = harness({ campaigns: 0 });
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "campaigns", options: {} }],
    });
    // Give the run a deferral to resolve, exactly as the planner records one.
    const parentRow = h.rows.find((r) => r.id === run.id);
    parentRow.payload = {
      ...parentRow.payload,
      deferredSources: [{ platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", after: "campaigns" }],
    };

    const res = await h.worker();
    assert.equal(res.body.worked, true);
    assert.equal(res.body.unitsMaterialised, undefined, "no chunk units are invented for an empty account");
    assert.equal(chunksOf(h, run.id).length, 0);

    const status = await h.orchestration.describeRun(run.id);
    assert.deepEqual(status.deferredSources.map((d) => ({ status: d.status, units: d.units })), [
      { status: "materialised", units: 0 },
    ]);
    assert.equal(status.deferredPending, false, "no phantom deferral remains");
    assert.equal(status.totalUnitsMayIncrease, false);
    assert.equal(status.status, "success", "the run settles normally");
    assert.equal(h.rows.find((r) => r.id === run.id).status, "COMPLETED");
    assert.ok(status.finishedAt);
  });

  it("concurrent completions of the same campaigns unit create ONE set of chunks", async () => {
    const h = harness({ campaigns: SIZE * 2 + 1 });
    const run = await runWithCampaignsUnit(h);
    const campaignsUnit = h.unitsOf(run.id)[0];
    const descriptor = campaignsUnit.payload;
    const opts = { completingUnitId: campaignsUnit.id };

    // Two workers materialising at the same moment: both read an empty run and both create.
    const [a, b] = await Promise.all([
      h.orchestration.materialiseFollowOnUnits(run.id, descriptor, null, opts),
      h.orchestration.materialiseFollowOnUnits(run.id, descriptor, null, opts),
    ]);

    const chunks = chunksOf(h, run.id);
    assert.equal(chunks.length, 3, "one unit per chunk, not two sets");
    assert.deepEqual(chunks.map((u) => u.payload.campaignChunkIndex).sort(), [0, 1, 2]);
    assert.equal(a.appended + b.appended, 3, "the winners' counts add up to the real work");
    // No duplicate survived, and no unit was left CANCELLED to poison the parent's counters.
    const identities = chunks.map((u) => `${u.payload.sourceObject}:${u.payload.campaignChunkIndex}`);
    assert.equal(new Set(identities).size, identities.length);
    assert.ok(h.unitsOf(run.id).every((u) => u.status === "PENDING"));
    const status = await h.orchestration.describeRun(run.id);
    assert.equal(status.failedUnits, 0, "collapsing a duplicate is not a run failure");
    assert.equal(status.totalUnits, h.unitsOf(run.id).length, "the parent's count matches reality");

    // And the sequences stay usable: one unit per priority.
    const priorities = h.unitsOf(run.id).map((u) => u.priority);
    assert.equal(new Set(priorities).size, priorities.length);
  });

  it("a failed chunk write leaves the deferral pending and the run unfinished", async () => {
    const h = harness({ campaigns: SIZE });
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "campaigns", options: {} }],
    });
    const parentRow = h.rows.find((r) => r.id === run.id);
    parentRow.payload = {
      ...parentRow.payload,
      deferredSources: [{ platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", after: "campaigns" }],
    };

    const create = h.prisma.jobRun.create;
    let created = 0;
    h.prisma.jobRun.create = async (args) => {
      if (args.data.jobName === UNIT_JOB_NAME && created >= 0) {
        created += 1;
        throw new Error("zzrowwritefailedzz");
      }
      return create(args);
    };
    await assert.rejects(h.worker(), /zzrowwritefailedzz/);
    h.prisma.jobRun.create = create;

    // The campaigns unit was never completed, so the run cannot claim to be finished…
    const unit = h.unitsOf(run.id)[0];
    assert.equal(unit.status, "RUNNING");
    assert.equal(h.rows.find((r) => r.id === run.id).status, "RUNNING");
    const status = await h.orchestration.describeRun(run.id);
    assert.notEqual(status.status, "success");
    assert.equal(status.finishedAt, null);
    // …and the deferral is still pending, so the work stays visible.
    assert.equal(status.deferredSources[0].status, "pending");
    assert.equal(status.deferredPending, true);

    // Recoverable: once the dead attempt's lease expires the unit is offered again, and the
    // retry materialises and completes normally.
    unit.startedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    const retry = await h.worker();
    assert.equal(retry.body.worked, true);
    assert.equal(chunksOf(h, run.id).length, 1);
    assert.equal((await h.orchestration.describeRun(run.id)).deferredSources[0].status, "materialised");
  });

  it("a refused append leaves the deferral pending rather than marking work done", async () => {
    const h = harness({ campaigns: SIZE });
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "campaigns", options: {} }],
    });
    const parentRow = h.rows.find((r) => r.id === run.id);
    parentRow.payload = {
      ...parentRow.payload,
      deferredSources: [{ platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", after: "campaigns" }],
    };
    // Drive the run terminal first, so the append is refused even though chunks DO exist.
    const unit = await h.orchestration.nextUnit(run.id);
    await h.orchestration.claimUnit(unit.id, { workerId: "w" });
    await h.orchestration.completeUnit(unit.id, { ok: true });
    assert.equal(h.rows.find((r) => r.id === run.id).status, "COMPLETED");

    const result = await h.orchestration.materialiseFollowOnUnits(run.id, unit.payload);
    assert.equal(result.appended, 0);
    assert.equal(result.reason, "run_terminal");
    assert.equal(result.units, 1, "the chunks were real; they simply could not be added");
    assert.equal(result.resolved, false, "a refusal is never a resolution");
    const status = await h.orchestration.describeRun(run.id);
    assert.equal(status.deferredSources[0].status, "pending", "the outstanding work stays visible");
    assert.equal(status.deferredPending, true);
  });

  it("collapsing duplicates never removes a unit another worker has claimed", async () => {
    const h = harness({ campaigns: SIZE });
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [
        { kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", campaignChunkIndex: 0, campaignIds: [campaignId(1)], options: {} },
        { kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", campaignChunkIndex: 0, campaignIds: [campaignId(1)], options: {} },
      ],
    });
    const [first, duplicate] = h.unitsOf(run.id);
    // The LATER row — the one collapsing would drop — is already being worked.
    duplicate.status = "RUNNING";
    duplicate.startedAt = new Date(NOW.getTime());

    // Appending anything triggers the collapse pass.
    await h.orchestration.appendUnits(run.id, [
      { kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", campaignChunkIndex: 1, campaignIds: [campaignId(2)], options: {} },
    ]);

    const survivors = h.unitsOf(run.id);
    assert.ok(survivors.some((u) => u.id === duplicate.id), "a claimed unit is never deleted under its worker");
    assert.equal(h.rows.find((r) => r.id === duplicate.id).status, "RUNNING");
    assert.ok(survivors.some((u) => u.id === first.id));
    assert.equal(survivors.length, 3);
  });

  it("status distinguishes pending, materialised-with-units and materialised-with-none", async () => {
    const h = harness({ campaigns: SIZE + 1 });
    const run = await runWithCampaignsUnit(h);
    const parentRow = h.rows.find((r) => r.id === run.id);
    parentRow.payload = {
      ...parentRow.payload,
      deferredSources: [
        { platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", after: "campaigns" },
        { platform: "optimise_uk", accountLabel: "default", sourceObject: "commission_groups", after: "campaigns" },
      ],
    };

    // 1 — deferred, not yet materialised.
    let status = await h.orchestration.describeRun(run.id);
    assert.ok(status.deferredSources.every((d) => d.status === "pending" && d.units === null));
    assert.equal(status.deferredPending, true);
    const unitsBefore = status.totalUnits;

    // 2 — materialised with units pending.
    await h.worker();
    status = await h.orchestration.describeRun(run.id);
    const sea = status.deferredSources.find((d) => d.platform === "optimise_sea");
    assert.equal(sea.status, "materialised");
    assert.equal(sea.units, 2);
    assert.ok(sea.resolvedAt);
    assert.equal(status.totalUnits, unitsBefore + 2, "totalUnits increases after campaigns complete");
    assert.equal(status.pendingUnits >= 2, true);
    // The other account has not run its campaigns unit yet, so it stays pending.
    assert.equal(status.deferredSources.find((d) => d.platform === "optimise_uk").status, "pending");
    assert.equal(status.deferredPending, true);

    // 3 — materialised with zero units.
    await h.orchestration.materialiseFollowOnUnits(run.id, {
      platform: "optimise_uk", accountLabel: "default", sourceObject: "campaigns", options: {},
    });
    status = await h.orchestration.describeRun(run.id);
    const uk = status.deferredSources.find((d) => d.platform === "optimise_uk");
    assert.equal(uk.status, "materialised");
    assert.equal(uk.units, 2, "this harness plans the same chunks for either account");
    assert.equal(status.deferredPending, false);
    assert.equal(status.totalUnitsMayIncrease, false, "the total is a total again");
  });

  it("materialisation touches no supplier: staged rows in, JobRun rows out", async () => {
    const seen = [];
    const h = harness({
      chunkPlan: async (args) => {
        seen.push(args);
        return { chunks: [{ index: 0, campaignIds: [campaignId(1)] }], chunkSize: SIZE };
      },
    });
    const run = await runWithCampaignsUnit(h);
    const before = h.calls.length;
    const campaignsUnit = h.unitsOf(run.id)[0];
    await h.orchestration.materialiseFollowOnUnits(run.id, campaignsUnit.payload, null, {
      completingUnitId: campaignsUnit.id,
    });
    assert.equal(h.calls.length, before, "no account sync, and therefore no Optimise request");
    assert.deepEqual(seen, [{ platform: "optimise_sea", accountLabel: "default" }]);
    assert.equal(chunksOf(h, run.id).length, 1, "the only writes are JobRun rows");
    // The discovery helper itself reads staged rows and nothing else.
    const planner = OPTIMISE_SRC.split("export async function planOptimiseCommissionGroupChunks(")[1].split("\n}\n")[0];
    assert.match(planner, /await loadStagedOptimiseCampaignRows\(/);
    for (const forbidden of ["adapter", "fetchOptimiseCommissionGroups", "httpClient"]) {
      assert.ok(!planner.includes(forbidden), forbidden);
    }
  });
});
