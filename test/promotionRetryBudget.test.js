/**
 * Promotion retry request budget: at most PROMOTION_RETRY_BATCH_SIZE targets per call, enforced by
 * the HTTP schema and again inside PromotionJob.retryFailed() for direct callers.
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

const { PROMOTION_BATCH_SIZE, PROMOTION_RETRY_BATCH_SIZE } = await import(
  "../src/modules/supplier/constants.js"
);
const { PROMOTION_PAGE_SIZE } = await import("../src/jobs/promotionUnit.js");
const { promotionRetryBodySchema } = await import("../src/modules/supplier/validators/schemas.js");
const { PromotionJob, MAPPER_ERROR_RETRY_LEASE_MS } = await import("../src/jobs/promotion.job.js");

const CAP = PROMOTION_RETRY_BATCH_SIZE;
const NOW = new Date("2026-09-25T12:00:00.000Z");
const minutesAgo = (minutes) => new Date(NOW.getTime() - minutes * 60_000);
const ids = (n, prefix = "m") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function row(id, overrides = {}) {
  return {
    id,
    entityId: `entity-${id}`,
    entityType: "campaign",
    errorCode: "MAPPER_FAILED",
    message: "original message",
    status: "OPEN",
    attempts: 0,
    createdAt: new Date(2026, 8, 1),
    resolvedAt: null,
    retryStartedAt: null,
    ...overrides,
  };
}

/** Same conditional semantics as the Prisma repository, in memory, with a call log. */
class FakeRepo {
  constructor(rows = []) {
    this.rows = new Map(rows.map((r) => [r.id, { ...r }]));
    this.calls = [];
  }
  row(id) {
    return this.rows.get(id);
  }
  calledMethods() {
    return this.calls.map((c) => c[0]);
  }
  async findByIds(list = []) {
    this.calls.push(["findByIds", list]);
    // Prisma `id IN (...)` returns each matching row once, whatever the list repeats.
    const unique = [...new Set(list)];
    return unique
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
    this.calls.push(["claim", id, from]);
    const r = this.rows.get(id);
    if (!r || r.status !== from) return false;
    if (from === "RETRYING" && staleBefore && !(r.retryStartedAt === null || r.retryStartedAt < staleBefore)) {
      return false;
    }
    if (from === "OPEN") Object.assign(r, { status: "RETRYING", retryStartedAt: now, resolvedAt: null });
    else r.retryStartedAt = now;
    return true;
  }
  async finishRetry(id, status, extra = {}) {
    this.calls.push(["finish", id, status]);
    const r = this.rows.get(id);
    if (!r || r.status !== "RETRYING") return false;
    Object.assign(r, extra, { status, retryStartedAt: null });
    if (status === "RESOLVED") r.resolvedAt = NOW;
    if (status === "OPEN") r.resolvedAt = null;
    return true;
  }
}

function buildJob({ repo, promotions = { count: 0 } } = {}) {
  return new PromotionJob({
    mapperErrorRepo: repo,
    entityRepo: {
      findById: async (id) => ({
        id,
        entityType: "campaign",
        networkSource: "boostiny",
        externalId: `boostiny-campaign-${id}`,
        rawData: {},
        normalizedData: {},
      }),
    },
    campaignPromotion: {
      promoteEntity: async () => {
        promotions.count += 1;
        return { result: "updated" };
      },
    },
    couponPromotion: { promoteEntity: async () => ({ result: "updated" }) },
    normalization: { normalizeSupplierCampaign: async () => ({ matchOutcome: "matched" }) },
    trackierPayouts: { persistPromotedCampaign: async () => ({ rules: 0 }) },
    promotionService: { ensureSuppliersSeeded: async () => {} },
    now: () => NOW,
  });
}

async function expect400(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, 400);
    assert.ok(!/prisma|select|where/i.test(error.message), error.message);
    return true;
  });
}

// ─── constant ────────────────────────────────────────────────────────────────────────────────

describe("PROMOTION_RETRY_BATCH_SIZE", () => {
  it("1. is 50", () => {
    assert.equal(PROMOTION_RETRY_BATCH_SIZE, 50);
  });

  it("2. equals the bounded promotion page size, so the safety rationale cannot drift", () => {
    assert.equal(PROMOTION_RETRY_BATCH_SIZE, PROMOTION_PAGE_SIZE);
  });

  it("leaves the legacy PROMOTION_BATCH_SIZE untouched", () => {
    assert.equal(PROMOTION_BATCH_SIZE, 100);
  });
});

// ─── HTTP schema ─────────────────────────────────────────────────────────────────────────────

describe("promotionRetryBodySchema", () => {
  const parse = (body) => promotionRetryBodySchema.safeParse(body);

  it("3. limit 1 accepted", () => {
    const r = parse({ limit: 1 });
    assert.equal(r.success, true);
    assert.equal(r.data.limit, 1);
  });

  it("4. limit 50 accepted, and a numeric string is coerced", () => {
    assert.equal(parse({ limit: CAP }).success, true);
    assert.equal(parse({ limit: String(CAP) }).data.limit, CAP);
  });

  it("5. limit 51 rejected", () => {
    const r = parse({ limit: CAP + 1 });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ["limit"]);
  });

  it("6. limit 500 rejected (the previous maximum)", () => {
    assert.equal(parse({ limit: 500 }).success, false);
  });

  it("limit omitted is valid and stays undefined for the job default", () => {
    const r = parse({});
    assert.equal(r.success, true);
    assert.equal(r.data.limit, undefined);
    assert.equal(r.data.mapperErrorIds, undefined);
  });

  it("limit 0 and non-numeric are rejected", () => {
    assert.equal(parse({ limit: 0 }).success, false);
    assert.equal(parse({ limit: "many" }).success, false);
  });

  it("7. mapperErrorIds with 50 ids accepted, in the order given", () => {
    const r = parse({ mapperErrorIds: ids(CAP) });
    assert.equal(r.success, true);
    assert.deepEqual(r.data.mapperErrorIds, ids(CAP));
  });

  it("8. mapperErrorIds with 51 ids rejected, never sliced", () => {
    const r = parse({ mapperErrorIds: ids(CAP + 1) });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ["mapperErrorIds"]);
    assert.equal(r.error.issues[0].code, "too_big");
  });

  it("9. an empty-string id is rejected", () => {
    const r = parse({ mapperErrorIds: ["ok", ""] });
    assert.equal(r.success, false);
    assert.deepEqual(r.error.issues[0].path, ["mapperErrorIds", 1]);
  });

  it("10. mapperErrorIds [] accepted", () => {
    const r = parse({ mapperErrorIds: [] });
    assert.equal(r.success, true);
    assert.deepEqual(r.data.mapperErrorIds, []);
  });

  it("duplicates count toward the cap and are not deduplicated by the schema", () => {
    const dup = Array.from({ length: CAP }, () => "same");
    assert.equal(parse({ mapperErrorIds: dup }).success, true);
    assert.deepEqual(parse({ mapperErrorIds: dup }).data.mapperErrorIds, dup);
    assert.equal(parse({ mapperErrorIds: [...dup, "same"] }).success, false);
  });
});

// ─── job defense in depth ────────────────────────────────────────────────────────────────────

describe("PromotionJob.retryFailed request budget", () => {
  it("11. automatic path with no limit asks the repository for exactly 50", async () => {
    const repo = new FakeRepo([]);
    await buildJob({ repo }).retryFailed();
    const [, args] = repo.calls.find((c) => c[0] === "findRetryTargets");
    assert.equal(args.take, CAP);
    assert.equal(args.staleBefore.getTime(), NOW.getTime() - MAPPER_ERROR_RETRY_LEASE_MS);
  });

  it("12. automatic path with limit 50 asks for 50", async () => {
    const repo = new FakeRepo([]);
    await buildJob({ repo }).retryFailed({ limit: CAP });
    const [, args] = repo.calls.find((c) => c[0] === "findRetryTargets");
    assert.equal(args.take, CAP);
  });

  it("13. internal limit 51 throws statusCode 400 before findRetryTargets", async () => {
    const repo = new FakeRepo([row("a")]);
    await expect400(buildJob({ repo }).retryFailed({ limit: CAP + 1 }));
    assert.deepEqual(repo.calls, []);
    assert.equal(repo.row("a").status, "OPEN");
  });

  it("internal non-positive or non-integer limits are refused before any read", async () => {
    for (const limit of [0, -1, 2.5, NaN, "50"]) {
      const repo = new FakeRepo([row("a")]);
      // eslint-disable-next-line no-await-in-loop
      await expect400(buildJob({ repo }).retryFailed({ limit }));
      assert.deepEqual(repo.calls, [], `limit ${String(limit)}`);
    }
  });

  it("14. explicit ids of length 50 are accepted and all processed", async () => {
    const list = ids(CAP);
    const repo = new FakeRepo(list.map((id, i) => row(id, { createdAt: new Date(2026, 8, 1, 0, i) })));
    const promotions = { count: 0 };
    const summary = await buildJob({ repo, promotions }).retryFailed({ mapperErrorIds: list });
    assert.equal(summary.processed, CAP);
    assert.equal(promotions.count, CAP);
    assert.ok(list.every((id) => repo.row(id).status === "RESOLVED"));
  });

  it("15. explicit ids of length 51 throw statusCode 400 before findByIds", async () => {
    const list = ids(CAP + 1);
    const repo = new FakeRepo(list.map((id) => row(id)));
    await expect400(buildJob({ repo }).retryFailed({ mapperErrorIds: list }));
    assert.deepEqual(repo.calls, []);
    assert.ok(list.every((id) => repo.row(id).status === "OPEN"), "nothing was claimed");
  });

  it("16. explicit ids ignore limit: limit never truncates a named list", async () => {
    const list = ids(10);
    const repo = new FakeRepo(list.map((id, i) => row(id, { createdAt: new Date(2026, 8, 1, 0, i) })));
    const summary = await buildJob({ repo }).retryFailed({ mapperErrorIds: list, limit: 1 });
    assert.equal(summary.processed, 10);
    assert.ok(!repo.calledMethods().includes("findRetryTargets"));
    assert.deepEqual(repo.calls[0], ["findByIds", list]);
  });

  it("17. duplicate explicit ids: the repository returns the row once, so it is promoted once", async () => {
    const repo = new FakeRepo([row("a")]);
    const promotions = { count: 0 };
    const summary = await buildJob({ repo, promotions }).retryFailed({ mapperErrorIds: ["a", "a", "a"] });
    assert.equal(promotions.count, 1);
    assert.equal(summary.processed, 1);
    assert.equal(repo.calls.filter((c) => c[0] === "claim").length, 1);
    assert.equal(repo.calls.filter((c) => c[0] === "finish").length, 1);
    assert.equal(repo.row("a").status, "RESOLVED");
  });

  it("empty ids still take the automatic path, exactly like omitted ids", async () => {
    const repo = new FakeRepo([row("a")]);
    const summary = await buildJob({ repo }).retryFailed({ mapperErrorIds: [] });
    assert.equal(repo.calls[0][0], "findRetryTargets");
    assert.equal(repo.calls[0][1].take, CAP);
    assert.equal(summary.processed, 1);
  });

  it("18. the single-id retry call shape (one id, limit 1) is unchanged", async () => {
    const repo = new FakeRepo([row("only")]);
    const promotions = { count: 0 };
    const summary = await buildJob({ repo, promotions }).retryFailed({ mapperErrorIds: ["only"], limit: 1 });
    assert.equal(summary.processed, 1);
    assert.equal(summary.updated, 1);
    assert.equal(promotions.count, 1);
    assert.equal(repo.row("only").status, "RESOLVED");
    assert.deepEqual(repo.calls[0], ["findByIds", ["only"]]);
  });

  it("19. explicit RESOLVED and DISCARDED are still skipped and unchanged", async () => {
    const resolved = row("r", { status: "RESOLVED", resolvedAt: minutesAgo(30) });
    const discarded = row("d", { status: "DISCARDED" });
    const repo = new FakeRepo([resolved, discarded]);
    const promotions = { count: 0 };
    const summary = await buildJob({ repo, promotions }).retryFailed({ mapperErrorIds: ["r", "d"] });
    assert.equal(summary.skipped, 2);
    assert.equal(summary.processed, 0);
    assert.equal(promotions.count, 0);
    assert.deepEqual(repo.row("r"), resolved);
    assert.deepEqual(repo.row("d"), discarded);
  });

  it("20. stale RETRYING is still reclaimed by the automatic path", async () => {
    const repo = new FakeRepo([row("stale", { status: "RETRYING", retryStartedAt: minutesAgo(11) })]);
    const summary = await buildJob({ repo }).retryFailed();
    assert.equal(summary.reclaimedStale, 1);
    assert.equal(repo.row("stale").status, "RESOLVED");
  });

  it("21. fresh RETRYING is still excluded from the automatic path", async () => {
    const fresh = row("fresh", { status: "RETRYING", retryStartedAt: minutesAgo(2) });
    const repo = new FakeRepo([fresh]);
    const summary = await buildJob({ repo }).retryFailed();
    assert.equal(summary.processed, 0);
    assert.equal(summary.reclaimedStale, 0);
    assert.ok(!repo.calledMethods().includes("claim"));
    assert.deepEqual(repo.row("fresh"), fresh);
  });
});
