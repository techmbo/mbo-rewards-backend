/**
 * MapperError retry recovery: conditional claim, conditional finish, stale-lease reclaim.
 * Fixtures are synthetic; no live values, no database.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { MAPPER_ERROR_RETRY_LEASE_MS, PromotionJob } = await import("../src/jobs/promotion.job.js");
const { MapperErrorRepository } = await import(
  "../src/modules/supplier/repositories/mapperError.repository.js"
);
const { DEFAULT_LEASE_MS } = await import("../src/jobs/syncAccountLock.service.js");
const { PROMOTION_RETRY_BATCH_SIZE } = await import("../src/modules/supplier/constants.js");

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-25T12:00:00.000Z");
const LEASE = MAPPER_ERROR_RETRY_LEASE_MS;
const minutesAgo = (minutes) => new Date(NOW.getTime() - minutes * 60_000);
const THROWN_MESSAGE = "SECRET_THROWN_MESSAGE_SENTINEL";

const ROW_DEFAULTS = Object.freeze({
  supplier: null,
  entityType: "campaign",
  errorCode: "MAPPER_FAILED",
  message: "original message",
  stackTrace: null,
  mapperVersion: null,
  status: "OPEN",
  attempts: 0,
  resolvedAt: null,
  retryStartedAt: null,
});

function row(id, overrides = {}) {
  return {
    id,
    entityId: `entity-${id}`,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    ...ROW_DEFAULTS,
    ...overrides,
  };
}

function entityFor(mapperError, overrides = {}) {
  return {
    id: mapperError.entityId,
    entityType: "campaign",
    networkSource: "boostiny",
    externalId: `boostiny-campaign-${mapperError.id}`,
    rawData: {},
    normalizedData: {},
    ...overrides,
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * An in-memory MapperError store that implements the REAL conditional semantics of
 * claimForRetry / finishRetry / findRetryTargets, so every test below exercises the same
 * compare-and-set contract the Prisma repository issues.
 */
class FakeMapperErrorRepo {
  constructor(rows = []) {
    this.rows = new Map(rows.map((r) => [r.id, { ...r }]));
    this.calls = [];
    this.throwOn = {};
    this.selectGate = null;
  }

  row(id) {
    return this.rows.get(id);
  }

  snapshot(ids) {
    return clone(ids.map((id) => this.rows.get(id) ?? null));
  }

  #maybeThrow(method, ...args) {
    const rule = this.throwOn[method];
    if (!rule) return;
    if (rule === true || (typeof rule === "function" && rule(...args))) {
      throw new Error(`${THROWN_MESSAGE}: ${method} unavailable`);
    }
  }

  async findByIds(ids = []) {
    this.calls.push(["findByIds", ids]);
    return ids
      .map((id) => this.rows.get(id))
      .filter(Boolean)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ ...r }));
  }

  async findMany() {
    throw new Error("findMany must not be used by retryFailed");
  }

  async findRetryTargets({ staleBefore, take = 20 } = {}) {
    this.calls.push(["findRetryTargets", { staleBefore, take }]);
    if (this.selectGate) await this.selectGate;
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.status === "OPEN" ||
          (r.status === "RETRYING" && (r.retryStartedAt === null || r.retryStartedAt < staleBefore)),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, take)
      .map((r) => ({ ...r }));
  }

  async claimForRetry(id, { from = "OPEN", now = new Date(), staleBefore = null } = {}) {
    this.calls.push(["claim", id, from, staleBefore ? "stale" : "any"]);
    this.#maybeThrow("claimForRetry", id);
    const r = this.rows.get(id);
    if (!r || r.status !== from) return false;
    if (from === "RETRYING" && staleBefore && !(r.retryStartedAt === null || r.retryStartedAt < staleBefore)) {
      return false;
    }
    if (from === "OPEN") {
      r.status = "RETRYING";
      r.retryStartedAt = now;
      r.resolvedAt = null;
    } else {
      r.retryStartedAt = now;
    }
    return true;
  }

  async finishRetry(id, status, extra = {}) {
    this.calls.push(["finish", id, status]);
    this.#maybeThrow("finishRetry", id, status);
    const r = this.rows.get(id);
    if (!r || r.status !== "RETRYING") return false;
    Object.assign(r, extra, { status, retryStartedAt: null });
    if (status === "RESOLVED") r.resolvedAt = NOW;
    if (status === "OPEN") r.resolvedAt = null;
    return true;
  }

  /** The unconditional write the promotion service and recordMapperFailure still use. */
  async updateStatus(id, status, extra = {}) {
    this.calls.push(["updateStatus", id, status]);
    const r = this.rows.get(id);
    if (!r) throw new Error("P2025 record not found");
    const { attempts, ...rest } = extra;
    Object.assign(r, rest, { status });
    if (attempts?.increment) r.attempts += attempts.increment;
    if (status === "RESOLVED") r.resolvedAt = NOW;
    return { ...r };
  }
}

function buildJob({
  repo,
  entities = {},
  campaign = async () => ({ result: "updated", record: { id: "sc-1" } }),
  coupon = async () => ({ result: "updated", record: { id: "cp-1" } }),
  normalization = async () => ({ matchOutcome: "matched", catalogLinked: true }),
  findById = null,
  now = () => NOW,
} = {}) {
  return new PromotionJob({
    mapperErrorRepo: repo,
    entityRepo: {
      findById: findById ?? (async (id) => entities[id] ?? null),
    },
    campaignPromotion: { promoteEntity: campaign },
    couponPromotion: { promoteEntity: coupon },
    normalization: { normalizeSupplierCampaign: normalization },
    trackierPayouts: { persistPromotedCampaign: async () => ({ rules: 0 }) },
    promotionService: { ensureSuppliersSeeded: async () => {} },
    now,
  });
}

function claims(repo) {
  return repo.calls.filter((c) => c[0] === "claim");
}
function finishes(repo) {
  return repo.calls.filter((c) => c[0] === "finish");
}

// ─── lease ───────────────────────────────────────────────────────────────────────────────────

describe("retry lease", () => {
  it("reuses the 10-minute serverless recovery lease", () => {
    assert.equal(MAPPER_ERROR_RETRY_LEASE_MS, DEFAULT_LEASE_MS);
    assert.equal(MAPPER_ERROR_RETRY_LEASE_MS, 10 * 60 * 1000);
  });
});

// ─── happy paths ─────────────────────────────────────────────────────────────────────────────

describe("retryFailed final states", () => {
  it("1. OPEN success: claim RETRYING -> RESOLVED, lease cleared, resolvedAt set", async () => {
    const repo = new FakeMapperErrorRepo([row("a")]);
    const job = buildJob({ repo, entities: { "entity-a": entityFor(row("a")) } });

    const summary = await job.retryFailed({ mapperErrorIds: ["a"] });

    const r = repo.row("a");
    assert.equal(r.status, "RESOLVED");
    assert.equal(r.retryStartedAt, null);
    assert.equal(r.resolvedAt, NOW);
    assert.deepEqual(claims(repo), [["claim", "a", "OPEN", "any"]]);
    assert.deepEqual(finishes(repo), [["finish", "a", "RESOLVED"]]);
    assert.equal(summary.processed, 1);
    assert.equal(summary.updated, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.recovered, 0);
    assert.equal(summary.reclaimedStale, 0);
  });

  it("2. OPEN failed result: final OPEN, lease cleared, resolvedAt null", async () => {
    const repo = new FakeMapperErrorRepo([row("a", { resolvedAt: new Date("2026-08-01T00:00:00Z") })]);
    const job = buildJob({
      repo,
      entities: { "entity-a": entityFor(row("a")) },
      campaign: async () => ({ result: "failed", error: { code: "X" } }),
    });

    const summary = await job.retryFailed({ mapperErrorIds: ["a"] });

    const r = repo.row("a");
    assert.equal(r.status, "OPEN");
    assert.equal(r.retryStartedAt, null);
    assert.equal(r.resolvedAt, null, "a stale resolvedAt is cleared when the row reopens");
    assert.deepEqual(finishes(repo), [["finish", "a", "OPEN"]]);
    assert.equal(summary.failed, 1);
    assert.equal(summary.processed, 1);
    assert.equal(summary.recovered, 0, "a returned failure is not an exception recovery");
  });

  it("3. missing entity: DISCARDED, lease cleared, existing message text preserved", async () => {
    const repo = new FakeMapperErrorRepo([row("a")]);
    const job = buildJob({ repo, entities: {} });

    const summary = await job.retryFailed({ mapperErrorIds: ["a"] });

    const r = repo.row("a");
    assert.equal(r.status, "DISCARDED");
    assert.equal(r.retryStartedAt, null);
    assert.equal(r.message, "Source Entity no longer exists");
    assert.equal(summary.failed, 1);
    assert.equal(summary.processed, 1);
    assert.deepEqual(finishes(repo), [["finish", "a", "DISCARDED"]]);
  });
});

// ─── exception recovery ──────────────────────────────────────────────────────────────────────

describe("retryFailed exception recovery", () => {
  it("4. findById throws after the claim: reopened, recovered=1, next target still processes", async () => {
    const repo = new FakeMapperErrorRepo([
      row("a", { createdAt: new Date("2026-09-01T00:00:00Z") }),
      row("b", { createdAt: new Date("2026-09-02T00:00:00Z") }),
    ]);
    const job = buildJob({
      repo,
      findById: async (id) => {
        if (id === "entity-a") throw new Error(THROWN_MESSAGE);
        return entityFor(row("b"));
      },
    });

    const summary = await job.retryFailed({ mapperErrorIds: ["a", "b"] });

    assert.equal(repo.row("a").status, "OPEN");
    assert.equal(repo.row("a").retryStartedAt, null);
    assert.equal(repo.row("b").status, "RESOLVED");
    assert.equal(summary.recovered, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.updated, 1);
    assert.equal(summary.processed, 2, "the thrown target is counted exactly once");
  });

  it("5. promoteEntity throws: reopened and the batch continues", async () => {
    const repo = new FakeMapperErrorRepo([
      row("a", { createdAt: new Date("2026-09-01T00:00:00Z") }),
      row("b", { createdAt: new Date("2026-09-02T00:00:00Z") }),
      row("c", { createdAt: new Date("2026-09-03T00:00:00Z") }),
    ]);
    const job = buildJob({
      repo,
      entities: {
        "entity-a": entityFor(row("a")),
        "entity-b": entityFor(row("b")),
        "entity-c": entityFor(row("c")),
      },
      campaign: async (entity) => {
        if (entity.id === "entity-b") throw new Error(THROWN_MESSAGE);
        return { result: "created", record: { id: `sc-${entity.id}` } };
      },
    });

    const summary = await job.retryFailed({ mapperErrorIds: ["a", "b", "c"] });

    assert.equal(repo.row("a").status, "RESOLVED");
    assert.equal(repo.row("b").status, "OPEN");
    assert.equal(repo.row("c").status, "RESOLVED");
    assert.equal(summary.processed, 3);
    assert.equal(summary.created, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.recovered, 1);
  });

  it("6. normalization throws after the service already RESOLVED the row: stays RESOLVED, recovery count 0", async () => {
    const repo = new FakeMapperErrorRepo([row("a")]);
    const job = buildJob({
      repo,
      entities: { "entity-a": entityFor(row("a")) },
      // The real SupplierCampaignPromotionService resolves the active mapper error with an
      // UNCONDITIONAL updateStatus after its transaction commits, before normalization runs.
      campaign: async () => {
        await repo.updateStatus("a", "RESOLVED", { message: "original message" });
        return { result: "created", record: { id: "sc-a" } };
      },
      normalization: async () => {
        throw new Error(THROWN_MESSAGE);
      },
    });

    const summary = await job.retryFailed({ mapperErrorIds: ["a"] });

    const r = repo.row("a");
    assert.equal(r.status, "RESOLVED", "recovery must not corrupt RESOLVED back to OPEN");
    assert.equal(r.resolvedAt, NOW);
    assert.equal(summary.recovered, 0, "the conditional RETRYING -> OPEN write matched nothing");
    assert.equal(summary.failed, 1, "the operational failure is still reported");
    assert.equal(summary.processed, 1);
    assert.deepEqual(finishes(repo), [["finish", "a", "OPEN"]]);
  });

  it("7. final RESOLVED write throws (database outage): stays RETRYING with its lease, reclaimable after the lease", async () => {
    // An entity type promoteEntity skips, so no service-side status write happens and the job's
    // own final write is the only path to RESOLVED.
    const repo = new FakeMapperErrorRepo([row("a", { entityType: "offer" })]);
    const outage = buildJob({
      repo,
      entities: { "entity-a": entityFor(row("a"), { entityType: "offer" }) },
    });
    repo.throwOn.finishRetry = true;

    const first = await outage.retryFailed({ mapperErrorIds: ["a"] });

    const r = repo.row("a");
    assert.equal(r.status, "RETRYING", "the catch could not reopen it either");
    assert.equal(r.retryStartedAt, NOW, "the lease survives the outage");
    assert.equal(first.recovered, 0, "no recovery is claimed that did not happen");
    assert.equal(first.processed, 1);
    assert.equal(first.skipped, 1, "accumulate had already counted the skipped promotion");
    assert.equal(first.failed, 0, "the same target is not counted a second time by the catch");
    assert.deepEqual(finishes(repo), [
      ["finish", "a", "RESOLVED"],
      ["finish", "a", "OPEN"],
    ]);

    // Inside the lease the automatic path leaves it alone.
    repo.throwOn = {};
    repo.calls = [];
    const inLease = buildJob({ repo, entities: {}, now: () => new Date(NOW.getTime() + LEASE - 1) });
    const second = await inLease.retryFailed();
    assert.equal(second.processed, 0);
    assert.equal(second.reclaimedStale, 0);
    assert.equal(repo.row("a").status, "RETRYING");

    // Past the lease it is selected, reclaimed and finished.
    const later = buildJob({
      repo,
      entities: { "entity-a": entityFor(row("a"), { entityType: "offer" }) },
      now: () => new Date(NOW.getTime() + LEASE + 1000),
    });
    const third = await later.retryFailed();
    assert.equal(third.reclaimedStale, 1);
    assert.equal(third.processed, 1);
    assert.equal(repo.row("a").status, "RESOLVED");
    assert.equal(repo.row("a").retryStartedAt, null);
  });

  it("17. summary counters never expose the thrown message or stack", async () => {
    const repo = new FakeMapperErrorRepo([row("a")]);
    const job = buildJob({
      repo,
      findById: async () => {
        const error = new Error(THROWN_MESSAGE);
        error.stack = `${THROWN_MESSAGE}-STACK`;
        throw error;
      },
    });

    const summary = await job.retryFailed({ mapperErrorIds: ["a"] });

    const text = JSON.stringify(summary);
    assert.ok(!text.includes(THROWN_MESSAGE), text);
    assert.ok(!text.includes("STACK"), text);
    assert.equal(summary.recovered, 1);
  });
});

// ─── automatic (no-id) selection ─────────────────────────────────────────────────────────────

describe("retryFailed automatic stale reclaim", () => {
  it("8. legacy RETRYING with a null lease is selected and reclaimed", async () => {
    const repo = new FakeMapperErrorRepo([row("legacy", { status: "RETRYING", retryStartedAt: null })]);
    const job = buildJob({ repo, entities: { "entity-legacy": entityFor(row("legacy")) } });

    const summary = await job.retryFailed();

    assert.deepEqual(claims(repo), [["claim", "legacy", "RETRYING", "stale"]]);
    assert.equal(summary.reclaimedStale, 1);
    assert.equal(summary.processed, 1);
    assert.equal(repo.row("legacy").status, "RESOLVED");
  });

  it("9. stale RETRYING older than the lease is reclaimed and counted", async () => {
    const repo = new FakeMapperErrorRepo([row("stale", { status: "RETRYING", retryStartedAt: minutesAgo(11) })]);
    const job = buildJob({ repo, entities: { "entity-stale": entityFor(row("stale")) } });

    const summary = await job.retryFailed();

    assert.equal(summary.reclaimedStale, 1);
    assert.equal(summary.recovered, 0);
    assert.equal(repo.row("stale").status, "RESOLVED");
    assert.equal(repo.row("stale").retryStartedAt, null);
  });

  it("10. fresh RETRYING is neither selected nor claimed by the automatic path", async () => {
    const fresh = row("fresh", { status: "RETRYING", retryStartedAt: minutesAgo(2) });
    const repo = new FakeMapperErrorRepo([fresh, row("open")]);
    const job = buildJob({
      repo,
      entities: { "entity-open": entityFor(row("open")), "entity-fresh": entityFor(fresh) },
    });

    const summary = await job.retryFailed();

    assert.equal(summary.processed, 1);
    assert.equal(summary.reclaimedStale, 0);
    assert.deepEqual(claims(repo), [["claim", "open", "OPEN", "any"]]);
    assert.deepEqual(repo.row("fresh"), fresh, "untouched");
  });

  it("the stale cutoff is exactly now minus the lease", async () => {
    const repo = new FakeMapperErrorRepo([]);
    const job = buildJob({ repo });
    await job.retryFailed({ limit: 7 });
    const [, args] = repo.calls.find((c) => c[0] === "findRetryTargets");
    assert.equal(args.staleBefore.getTime(), NOW.getTime() - LEASE);
    assert.equal(args.take, 7);
  });

  it("15. limit is preserved, and the default is the retry batch size", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row(`r${i}`, { createdAt: new Date(2026, 8, i + 1) }),
    );
    const repo = new FakeMapperErrorRepo(rows);
    const entities = Object.fromEntries(rows.map((r) => [r.entityId, entityFor(r)]));

    const limited = await buildJob({ repo, entities }).retryFailed({ limit: 2 });
    assert.equal(limited.processed, 2);
    assert.equal(claims(repo).length, 2);
    assert.equal([...repo.rows.values()].filter((r) => r.status === "RESOLVED").length, 2);

    repo.calls = [];
    await buildJob({ repo, entities }).retryFailed();
    const [, args] = repo.calls.find((c) => c[0] === "findRetryTargets");
    assert.equal(args.take, PROMOTION_RETRY_BATCH_SIZE);
  });

  it("an OPEN row claimed by someone else between select and claim is skipped, not promoted", async () => {
    const repo = new FakeMapperErrorRepo([row("a")]);
    let promotions = 0;
    const job = buildJob({
      repo,
      entities: { "entity-a": entityFor(row("a")) },
      campaign: async () => {
        promotions += 1;
        return { result: "updated" };
      },
    });
    // Simulate a concurrent claimer winning right after our select.
    const originalSelect = repo.findRetryTargets.bind(repo);
    repo.findRetryTargets = async (args) => {
      const rows = await originalSelect(args);
      repo.row("a").status = "RETRYING";
      repo.row("a").retryStartedAt = NOW;
      return rows;
    };

    const summary = await job.retryFailed();

    assert.equal(summary.skipped, 1);
    assert.equal(summary.processed, 0);
    assert.equal(promotions, 0);
    assert.deepEqual(finishes(repo), []);
  });
});

// ─── explicit ids ────────────────────────────────────────────────────────────────────────────

describe("retryFailed explicit-id status contract", () => {
  it("11. explicit fresh RETRYING is an operator override: claimed with a refreshed lease", async () => {
    const repo = new FakeMapperErrorRepo([row("a", { status: "RETRYING", retryStartedAt: minutesAgo(1) })]);
    let seenLeaseAtPromotion = null;
    const job = buildJob({
      repo,
      entities: { "entity-a": entityFor(row("a")) },
      campaign: async () => {
        seenLeaseAtPromotion = repo.row("a").retryStartedAt;
        return { result: "updated" };
      },
    });

    const summary = await job.retryFailed({ mapperErrorIds: ["a"] });

    assert.deepEqual(claims(repo), [["claim", "a", "RETRYING", "any"]]);
    assert.equal(seenLeaseAtPromotion, NOW, "lease refreshed to now while still RETRYING");
    assert.equal(summary.reclaimedStale, 0, "an explicit override is not a stale reclaim");
    assert.equal(summary.processed, 1);
    assert.equal(repo.row("a").status, "RESOLVED");
  });

  it("12. explicit RESOLVED is skipped and unchanged", async () => {
    const resolved = row("a", { status: "RESOLVED", resolvedAt: new Date("2026-08-01T00:00:00Z") });
    const repo = new FakeMapperErrorRepo([resolved]);
    let promotions = 0;
    const job = buildJob({
      repo,
      entities: { "entity-a": entityFor(resolved) },
      campaign: async () => {
        promotions += 1;
        return { result: "updated" };
      },
    });

    const summary = await job.retryFailed({ mapperErrorIds: ["a"] });

    assert.equal(summary.skipped, 1);
    assert.equal(summary.processed, 0);
    assert.equal(promotions, 0);
    assert.deepEqual(claims(repo), []);
    assert.deepEqual(repo.row("a"), resolved);
  });

  it("13. explicit DISCARDED is skipped and unchanged", async () => {
    const discarded = row("a", { status: "DISCARDED", message: "Source Entity no longer exists" });
    const repo = new FakeMapperErrorRepo([discarded]);
    const job = buildJob({ repo, entities: { "entity-a": entityFor(discarded) } });

    const summary = await job.retryFailed({ mapperErrorIds: ["a"] });

    assert.equal(summary.skipped, 1);
    assert.equal(summary.processed, 0);
    assert.deepEqual(claims(repo), []);
    assert.deepEqual(repo.row("a"), discarded);
  });

  it("explicit ids: unknown ids are ignored, OPEN ids are retried, the loader is findByIds only", async () => {
    const repo = new FakeMapperErrorRepo([row("a")]);
    const job = buildJob({ repo, entities: { "entity-a": entityFor(row("a")) } });

    const summary = await job.retryFailed({ mapperErrorIds: ["missing", "a"] });

    assert.equal(summary.processed, 1);
    assert.equal(summary.skipped, 0);
    assert.ok(!repo.calls.some((c) => c[0] === "findRetryTargets"));
    assert.equal(repo.row("a").status, "RESOLVED");
  });
});

// ─── interaction with service-side status writes ─────────────────────────────────────────────

describe("retryFailed and the promotion service's own status writes", () => {
  it("18. recordMapperFailure already reopened the row: finish OPEN count 0 is accepted", async () => {
    const repo = new FakeMapperErrorRepo([row("a")]);
    const job = buildJob({
      repo,
      entities: { "entity-a": entityFor(row("a")) },
      // recordMapperFailure: findOpenByEntityId (OPEN or RETRYING) -> updateStatus OPEN, attempts +1
      campaign: async () => {
        await repo.updateStatus("a", "OPEN", { message: "still failing", attempts: { increment: 1 } });
        return { result: "failed", error: { code: "PROMOTION_FAILED" } };
      },
    });

    const summary = await job.retryFailed({ mapperErrorIds: ["a"] });

    const r = repo.row("a");
    assert.equal(r.status, "OPEN");
    assert.equal(r.attempts, 1, "attempts are owned by recordMapperFailure, the job adds none");
    assert.equal(r.message, "still failing");
    assert.equal(summary.failed, 1);
    assert.equal(summary.processed, 1);
    assert.equal(summary.recovered, 0, "a count-0 final write is not a recovery and not an error");
    assert.deepEqual(finishes(repo), [["finish", "a", "OPEN"]]);
  });

  it("19. the service already RESOLVED the row: finish RESOLVED count 0 is accepted", async () => {
    const repo = new FakeMapperErrorRepo([row("a")]);
    const job = buildJob({
      repo,
      entities: { "entity-a": entityFor(row("a")) },
      campaign: async () => {
        await repo.updateStatus("a", "RESOLVED", { message: "original message" });
        return { result: "updated", record: { id: "sc-a" } };
      },
    });

    const summary = await job.retryFailed({ mapperErrorIds: ["a"] });

    assert.equal(repo.row("a").status, "RESOLVED");
    assert.equal(summary.updated, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.processed, 1);
    assert.deepEqual(finishes(repo), [["finish", "a", "RESOLVED"]]);
  });
});

// ─── concurrency ─────────────────────────────────────────────────────────────────────────────

describe("retryFailed concurrency", () => {
  it("14. two callers select the same OPEN row: one claim wins, one promotion, one final transition", async () => {
    const repo = new FakeMapperErrorRepo([row("a")]);
    let release;
    repo.selectGate = new Promise((resolve) => {
      release = resolve;
    });
    let promotions = 0;
    const make = () =>
      buildJob({
        repo,
        entities: { "entity-a": entityFor(row("a")) },
        campaign: async () => {
          promotions += 1;
          return { result: "updated" };
        },
      });

    const first = make().retryFailed();
    const second = make().retryFailed();
    // Both selects are now parked on the gate having seen the row OPEN. Release them together.
    release();
    const [s1, s2] = await Promise.all([first, second]);

    const summaries = [s1, s2];
    assert.equal(summaries.filter((s) => s.processed === 1).length, 1);
    assert.equal(summaries.filter((s) => s.skipped === 1 && s.processed === 0).length, 1);
    assert.equal(promotions, 1);
    assert.equal(claims(repo).length, 2);
    assert.equal(finishes(repo).length, 1);
    assert.equal(repo.row("a").status, "RESOLVED");
  });
});

// ─── isolation ───────────────────────────────────────────────────────────────────────────────

describe("retryFailed isolation", () => {
  it("16. unrelated rows are byte-identical before and after every path", async () => {
    const bystanders = [
      row("open-old", { createdAt: new Date("2020-01-01T00:00:00Z") }),
      row("resolved", { status: "RESOLVED", resolvedAt: minutesAgo(30) }),
      row("discarded", { status: "DISCARDED" }),
      row("fresh", { status: "RETRYING", retryStartedAt: minutesAgo(1) }),
      row("other-entity", { entityId: "entity-elsewhere" }),
    ];
    const repo = new FakeMapperErrorRepo([
      ...bystanders,
      row("target", { createdAt: new Date("2026-09-20T00:00:00Z") }),
      row("thrower", { createdAt: new Date("2026-09-21T00:00:00Z") }),
    ]);
    const ids = bystanders.map((b) => b.id);
    const before = repo.snapshot(ids);

    const job = buildJob({
      repo,
      entities: { "entity-target": entityFor(row("target")), "entity-thrower": entityFor(row("thrower")) },
      campaign: async (entity) => {
        if (entity.id === "entity-thrower") throw new Error(THROWN_MESSAGE);
        return { result: "updated" };
      },
    });

    await job.retryFailed({ mapperErrorIds: ["target", "thrower", "resolved", "discarded"] });
    assert.deepEqual(repo.snapshot(ids), before);
    assert.equal(repo.row("target").status, "RESOLVED");
    assert.equal(repo.row("thrower").status, "OPEN");

    // The automatic path with a limit that only reaches the newest OPEN row.
    repo.row("target").status = "OPEN";
    const again = repo.snapshot(ids);
    await job.retryFailed({ limit: 1 });
    assert.deepEqual(repo.snapshot(ids), again);
  });
});

// ─── the real repository issues the intended conditional statements ──────────────────────────

describe("MapperErrorRepository conditional writes", () => {
  function stubClient(count = 1) {
    const calls = [];
    const client = {
      mapperError: {
        updateMany: async (args) => {
          calls.push(["updateMany", args]);
          return { count };
        },
        findMany: async (args) => {
          calls.push(["findMany", args]);
          return [];
        },
      },
    };
    return { client, calls };
  }

  it("claimForRetry from OPEN is a compare-and-set that sets the lease and clears resolvedAt", async () => {
    const { client, calls } = stubClient(1);
    const ok = await new MapperErrorRepository().claimForRetry("m1", { from: "OPEN", now: NOW }, client);
    assert.equal(ok, true);
    assert.deepEqual(calls[0][1], {
      where: { id: "m1", status: "OPEN" },
      data: { status: "RETRYING", retryStartedAt: NOW, resolvedAt: null },
    });
  });

  it("claimForRetry from stale RETRYING keeps the status and requires an expired or null lease", async () => {
    const { client, calls } = stubClient(1);
    const staleBefore = minutesAgo(10);
    await new MapperErrorRepository().claimForRetry("m1", { from: "RETRYING", now: NOW, staleBefore }, client);
    assert.deepEqual(calls[0][1], {
      where: {
        id: "m1",
        status: "RETRYING",
        OR: [{ retryStartedAt: { lt: staleBefore } }, { retryStartedAt: null }],
      },
      data: { retryStartedAt: NOW },
    });
  });

  it("claimForRetry from RETRYING without a cutoff (explicit override) has no lease predicate", async () => {
    const { client, calls } = stubClient(1);
    await new MapperErrorRepository().claimForRetry("m1", { from: "RETRYING", now: NOW }, client);
    assert.deepEqual(calls[0][1], {
      where: { id: "m1", status: "RETRYING" },
      data: { retryStartedAt: NOW },
    });
  });

  it("claimForRetry returns false on count 0 and refuses statuses outside OPEN / RETRYING without a write", async () => {
    const lost = stubClient(0);
    assert.equal(await new MapperErrorRepository().claimForRetry("m1", { from: "OPEN" }, lost.client), false);
    const refused = stubClient(1);
    assert.equal(await new MapperErrorRepository().claimForRetry("m1", { from: "RESOLVED" }, refused.client), false);
    assert.equal(await new MapperErrorRepository().claimForRetry("m1", { from: "DISCARDED" }, refused.client), false);
    assert.deepEqual(refused.calls, []);
  });

  it("finishRetry only writes a row that is still RETRYING and clears the lease for every status", async () => {
    const repo = new MapperErrorRepository();
    const resolved = stubClient(1);
    assert.equal(await repo.finishRetry("m1", "RESOLVED", {}, resolved.client), true);
    const [, args] = resolved.calls[0];
    assert.deepEqual(args.where, { id: "m1", status: "RETRYING" });
    assert.equal(args.data.status, "RESOLVED");
    assert.equal(args.data.retryStartedAt, null);
    assert.ok(args.data.resolvedAt instanceof Date);

    const open = stubClient(0);
    assert.equal(await repo.finishRetry("m1", "OPEN", {}, open.client), false);
    assert.deepEqual(open.calls[0][1], {
      where: { id: "m1", status: "RETRYING" },
      data: { status: "OPEN", retryStartedAt: null, resolvedAt: null },
    });

    const discarded = stubClient(1);
    await repo.finishRetry("m1", "DISCARDED", { message: "Source Entity no longer exists" }, discarded.client);
    assert.deepEqual(discarded.calls[0][1], {
      where: { id: "m1", status: "RETRYING" },
      data: { message: "Source Entity no longer exists", status: "DISCARDED", retryStartedAt: null },
    });
  });

  it("finishRetry refuses RETRYING as a target status and extra cannot override the guarded fields", async () => {
    const repo = new MapperErrorRepository();
    const refused = stubClient(1);
    assert.equal(await repo.finishRetry("m1", "RETRYING", {}, refused.client), false);
    assert.deepEqual(refused.calls, []);

    const guarded = stubClient(1);
    await repo.finishRetry("m1", "OPEN", { status: "RESOLVED", retryStartedAt: NOW }, guarded.client);
    assert.equal(guarded.calls[0][1].data.status, "OPEN");
    assert.equal(guarded.calls[0][1].data.retryStartedAt, null);
  });

  it("findRetryTargets selects OPEN or stale/legacy RETRYING with the existing ordering, limit and include", async () => {
    const { client, calls } = stubClient(1);
    const staleBefore = minutesAgo(10);
    await new MapperErrorRepository().findRetryTargets({ staleBefore, take: 25 }, client);
    assert.deepEqual(calls[0][1], {
      where: {
        OR: [
          { status: "OPEN" },
          { status: "RETRYING", OR: [{ retryStartedAt: { lt: staleBefore } }, { retryStartedAt: null }] },
        ],
      },
      take: 25,
      orderBy: { createdAt: "desc" },
      include: { entity: { select: { id: true, externalId: true, networkSource: true, entityType: true } } },
    });
  });

  it("findRetryTargets defaults to the repository's page size of 20", async () => {
    const { client, calls } = stubClient(1);
    await new MapperErrorRepository().findRetryTargets({ staleBefore: NOW }, client);
    assert.equal(calls[0][1].take, 20);
  });
});
