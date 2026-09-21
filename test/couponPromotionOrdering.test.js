import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PromotionJob } from "../src/jobs/promotion.job.js";
import { EntityRepository } from "../src/modules/supplier/repositories/entity.repository.js";
import { SupplierCouponPromotionService } from "../src/modules/supplier/services/supplierCouponPromotion.service.js";
import { PROMOTION_BATCH_SIZE, SUPPLIER_ENTITY_TYPES } from "../src/modules/supplier/constants.js";

/**
 * Phase 16 — a coupon may never be promoted before its parent campaign.
 *
 * SupplierCoupon connects to SupplierCampaign by id and throws PARENT_CAMPAIGN_NOT_FOUND when the
 * parent row is absent, so the unbounded walk must finish every campaign in scope before it
 * attempts the first coupon. It used to ask for both types in one query and let row order decide.
 *
 * These tests drive the REAL EntityRepository against an in-memory prisma double, so the query
 * shape itself is exercised rather than re-described by a hand-written stub.
 */

function fakePrisma(rows) {
  const queries = [];
  return {
    queries,
    client: {
      entity: {
        findMany: async (query) => {
          queries.push(query);
          const where = query.where ?? {};
          const matched = rows.filter((row) => {
            if (where.entityType?.in && !where.entityType.in.includes(row.entityType)) return false;
            if (where.networkSource && row.networkSource !== where.networkSource) return false;
            if (where.id?.in && !where.id.in.includes(row.id)) return false;
            if (where.id?.gt && !(row.id > where.id.gt)) return false;
            return true;
          });
          // The repository asks for `orderBy: { id: "asc" }` and nothing else; honour exactly that
          // so a regression back to updatedAt ordering cannot be hidden by the double.
          assert.deepEqual(query.orderBy, { id: "asc" }, "the walk must order by id alone");
          assert.equal(query.cursor, undefined, "no Prisma cursor positioning");
          assert.equal(query.skip, undefined, "no skip");
          matched.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          return query.take ? matched.slice(0, query.take) : matched;
        },
      },
    },
  };
}

function entity({ id, entityType, networkSource = "trackier", parentKey = null, campaignKey = null, updatedAt }) {
  return {
    id,
    entityType,
    networkSource,
    externalId: `${networkSource}-${entityType}-${id}`,
    updatedAt,
    rawData: { parentKey, campaignKey },
    normalizedData: {},
  };
}

/**
 * A job wired to the real repository, with promotion doubles that enforce the dependency the
 * production services enforce: a coupon fails unless its parent campaign is already promoted.
 */
function buildJob(rows) {
  const store = fakePrisma(rows);
  const repo = new EntityRepository();
  const order = [];
  const promotedCampaigns = new Set();

  const job = new PromotionJob({
    promotionService: { ensureSuppliersSeeded: async () => {} },
    normalization: { normalizeSupplierCampaign: async () => ({}) },
    rakutenCommissionPromotion: async () => ({}),
    // Awin parent materialization runs before the walk; stubbed so these ordering tests exercise
    // the walk alone and never reach a database.
    awinParentMaterialization: async () => ({}),
    entityRepo: {
      findManyForPromotion: (args) => repo.findManyForPromotion(args, store.client),
    },
    campaignPromotion: {
      promoteEntity: async (row) => {
        order.push(row.id);
        promotedCampaigns.add(row.rawData.campaignKey);
        return { result: "created", record: null };
      },
    },
    couponPromotion: {
      promoteEntity: async (row) => {
        order.push(row.id);
        if (!promotedCampaigns.has(row.rawData.parentKey)) {
          return { result: "failed", error: { code: "PARENT_CAMPAIGN_NOT_FOUND" } };
        }
        return { result: "created", record: null };
      },
    },
  });

  return { job, order, store };
}

describe("Phase 16 — promotion walks entity types in dependency order", () => {
  it("1. a coupon staged BEFORE its parent campaign still promotes after it, in one run", async () => {
    // Both orderings that a single mixed walk could have chosen put the coupon first: its id sorts
    // lower AND its updatedAt is older. Only walking campaign to completion first can save it.
    const rows = [
      entity({ id: "e-100", entityType: "coupon", parentKey: "k1", updatedAt: new Date("2026-01-01") }),
      entity({ id: "e-900", entityType: "campaign", campaignKey: "k1", updatedAt: new Date("2026-06-01") }),
    ];

    const { job, order } = buildJob(rows);
    const summary = await job.run({});

    assert.deepEqual(order, ["e-900", "e-100"], "the campaign must be promoted before the coupon");
    assert.equal(summary.failed, 0, "no coupon may fail for a parent that exists in the same run");
    assert.equal(summary.created, 2);
    assert.equal(summary.processed, 2);
  });

  it("2. every campaign completes before the first coupon, across batch boundaries", async () => {
    const rows = [];
    for (let i = 0; i < 5; i += 1) {
      rows.push(entity({ id: `e-c${i}`, entityType: "coupon", parentKey: `k${i}`, updatedAt: new Date("2026-01-01") }));
      rows.push(entity({ id: `e-p${i}`, entityType: "campaign", campaignKey: `k${i}`, updatedAt: new Date("2026-06-01") }));
    }

    const { job, order } = buildJob(rows);
    // batchSize 2 over 5 rows per type: three pages per type, so the split must hold across pages.
    const summary = await job.run({ batchSize: 2 });

    const firstCouponAt = order.findIndex((id) => id.startsWith("e-c"));
    const lastCampaignAt = order.map((id) => id.startsWith("e-p")).lastIndexOf(true);
    assert.equal(order.length, 10, "every row is walked exactly once");
    assert.ok(lastCampaignAt < firstCouponAt, "a coupon was promoted before the last campaign");
    assert.equal(summary.failed, 0);
    assert.equal(summary.created, 10);
  });

  it("3. networkSource scoping is preserved", async () => {
    const rows = [
      entity({ id: "e-1", entityType: "campaign", campaignKey: "k1", networkSource: "trackier", updatedAt: new Date() }),
      entity({ id: "e-2", entityType: "coupon", parentKey: "k1", networkSource: "trackier", updatedAt: new Date() }),
      entity({ id: "e-3", entityType: "campaign", campaignKey: "k2", networkSource: "awin", updatedAt: new Date() }),
      entity({ id: "e-4", entityType: "coupon", parentKey: "k2", networkSource: "awin", updatedAt: new Date() }),
    ];

    const { job, order, store } = buildJob(rows);
    const summary = await job.run({ networkSource: "trackier" });

    assert.deepEqual(order, ["e-1", "e-2"], "only the requested network is walked");
    assert.equal(summary.processed, 2);
    for (const query of store.queries) {
      assert.equal(query.where.networkSource, "trackier", "the network filter reached every query");
    }
  });

  it("4. entityIds scoping is preserved, and still pages", async () => {
    const rows = [
      entity({ id: "e-1", entityType: "campaign", campaignKey: "k1", updatedAt: new Date() }),
      entity({ id: "e-2", entityType: "campaign", campaignKey: "k2", updatedAt: new Date() }),
      entity({ id: "e-3", entityType: "campaign", campaignKey: "k3", updatedAt: new Date() }),
      entity({ id: "e-4", entityType: "coupon", parentKey: "k1", updatedAt: new Date() }),
      entity({ id: "e-5", entityType: "coupon", parentKey: "k9", updatedAt: new Date() }),
    ];

    const { job, order } = buildJob(rows);
    // batchSize 1 forces the cursor and the id list to constrain `id` at the same time.
    const summary = await job.run({ entityIds: ["e-1", "e-3", "e-4"], batchSize: 1 });

    assert.deepEqual(order, ["e-1", "e-3", "e-4"], "only the requested ids are walked, campaigns first");
    assert.equal(summary.processed, 3);
    assert.equal(summary.failed, 0);
  });

  it("5. the cursor resets for each entity type", async () => {
    const rows = [
      entity({ id: "e-100", entityType: "coupon", parentKey: "k1", updatedAt: new Date() }),
      entity({ id: "e-900", entityType: "campaign", campaignKey: "k1", updatedAt: new Date() }),
    ];

    const { job, store } = buildJob(rows);
    await job.run({ batchSize: 1 });

    const campaignQueries = store.queries.filter((q) => q.where.entityType.in.includes("campaign"));
    const couponQueries = store.queries.filter((q) => q.where.entityType.in.includes("coupon"));

    for (const query of store.queries) {
      assert.equal(query.where.entityType.in.length, 1, "each query asks for exactly one type");
    }
    assert.equal(campaignQueries[0].where.id, undefined, "the campaign walk starts with no cursor");
    // e-900 (campaign) sorts AFTER e-100 (coupon). Carrying its cursor into the coupon walk would
    // skip the coupon entirely, so the reset is what makes the coupon reachable at all.
    assert.equal(couponQueries[0].where?.id, undefined, "the coupon walk must start from its own beginning");
  });

  it("6. summary counts stay correct across the per-type walks", async () => {
    const rows = [
      entity({ id: "e-1", entityType: "campaign", campaignKey: "k1", updatedAt: new Date() }),
      entity({ id: "e-2", entityType: "coupon", parentKey: "k1", updatedAt: new Date() }),
      entity({ id: "e-3", entityType: "coupon", parentKey: "missing", updatedAt: new Date() }),
    ];

    const { job } = buildJob(rows);
    const summary = await job.run({ batchSize: 2 });

    assert.equal(summary.created, 2);
    assert.equal(summary.updated, 0);
    assert.equal(summary.failed, 1, "a genuinely parentless coupon still fails");
    assert.equal(summary.skipped, 0);
    assert.equal(summary.processed, 3);
    assert.ok(typeof summary.durationMs === "number");
  });

  it("the requested entityTypes order is honoured, not a hard-coded one", async () => {
    const rows = [
      entity({ id: "e-1", entityType: "campaign", campaignKey: "k1", updatedAt: new Date() }),
      entity({ id: "e-2", entityType: "coupon", parentKey: "k1", updatedAt: new Date() }),
    ];

    const { job, order } = buildJob(rows);
    // Reversed on purpose: the caller's order is the contract, so the coupon runs first and fails.
    await job.run({ entityTypes: [SUPPLIER_ENTITY_TYPES.COUPON, SUPPLIER_ENTITY_TYPES.CAMPAIGN] });

    assert.deepEqual(order, ["e-2", "e-1"]);
  });

  it("the default entityTypes are campaign then coupon, and batchSize defaults unchanged", async () => {
    const rows = [entity({ id: "e-1", entityType: "campaign", campaignKey: "k1", updatedAt: new Date() })];
    const { job, store } = buildJob(rows);
    await job.run();

    assert.deepEqual(
      store.queries.map((q) => q.where.entityType.in[0]),
      [SUPPLIER_ENTITY_TYPES.CAMPAIGN, SUPPLIER_ENTITY_TYPES.COUPON],
      "campaign is walked first, coupon second, by default",
    );
    assert.equal(store.queries[0].take, PROMOTION_BATCH_SIZE);
  });
});

/** A coupon promotion service wired to doubles, with a controllable parent and mapper error store. */
function couponService({ parent, openError }) {
  const statusCalls = [];

  const service = new SupplierCouponPromotionService({
    runInTransaction: async (fn) => fn({}),
    campaignRepo: {
      findByBusinessKey: async () => parent,
      findByCampaignName: async () => parent,
    },
    couponRepo: {
      findByEntityId: async () => null,
      findByNaturalKey: async () => null,
      create: async (data) => ({ id: "coupon-1", ...data }),
      update: async (id) => ({ id }),
    },
    outboxWriter: { append: async () => ({ id: "outbox" }) },
    mapperErrorRepo: {
      findOpenByEntityId: async () => openError,
      updateStatus: async (id, status, extra) => {
        statusCalls.push({ id, status, extra });
        return { id, status };
      },
      create: async (data) => {
        statusCalls.push({ id: "new", status: data.status, extra: null });
        return { id: "new" };
      },
    },
  });

  return { service, statusCalls };
}

function couponEntity(overrides = {}) {
  return {
    id: "e-coupon",
    externalId: "boostiny-coupon-1",
    networkSource: "boostiny",
    entityType: "coupon",
    entityName: "Coupon",
    entityStatus: "Active",
    code: "SAVE",
    discount: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    normalizedData: {},
    rawData: { id: 1, campaign_id: 9, coupon: "SAVE" },
    ...overrides,
  };
}

describe("Phase 16 — a coupon's stale MapperError closes when promotion later succeeds", () => {
  it("7. an OPEN coupon MapperError becomes RESOLVED on a successful normal promotion", async () => {
    const { service, statusCalls } = couponService({
      parent: { id: "parent-1" },
      openError: { id: "me-1", message: "SupplierCampaign not found for parent id 9" },
    });

    const result = await service.promoteEntity(couponEntity());

    assert.equal(result.result, "created");
    assert.equal(statusCalls.length, 1, "exactly one lifecycle write");
    assert.equal(statusCalls[0].id, "me-1");
    assert.equal(statusCalls[0].status, "RESOLVED");
    assert.equal(
      statusCalls[0].extra.message,
      "SupplierCampaign not found for parent id 9",
      "the original message is carried, as the campaign service carries it",
    );
  });

  it("does not write a lifecycle row when there was no open error", async () => {
    const { service, statusCalls } = couponService({ parent: { id: "parent-1" }, openError: null });

    const result = await service.promoteEntity(couponEntity());

    assert.equal(result.result, "created");
    assert.deepEqual(statusCalls, [], "a clean coupon must not touch the mapper error table");
  });

  it("8. a coupon that still fails keeps its MapperError OPEN", async () => {
    const { service, statusCalls } = couponService({
      parent: null,
      openError: { id: "me-1", message: "SupplierCampaign not found for parent id 9" },
    });

    const result = await service.promoteEntity(couponEntity());

    assert.equal(result.result, "failed");
    assert.equal(result.error.code, "PARENT_CAMPAIGN_NOT_FOUND");
    assert.equal(statusCalls.length, 1);
    assert.equal(statusCalls[0].status, "OPEN", "a still-failing coupon is never resolved");
    assert.deepEqual(
      statusCalls[0].extra.attempts,
      { increment: 1 },
      "the existing failure counts another attempt",
    );
  });

  it("11. a coupon whose parent is genuinely absent still FAILS — it is never silently skipped", async () => {
    // Deliberate: disabled/absent-parent coupons stay fail-closed until a trustworthy disabled
    // signal exists. This test exists to make a premature skip loud.
    const { service } = couponService({ parent: null, openError: null });

    const result = await service.promoteEntity(couponEntity());

    assert.equal(result.result, "failed");
    assert.notEqual(result.result, "skipped");
    assert.equal(result.error.code, "PARENT_CAMPAIGN_NOT_FOUND");
  });

  it("12. an Awin coupon with no parent reference at all still fails MISSING_PARENT_CAMPAIGN", async () => {
    // A payload-level gap raised by the mapper BEFORE any campaign lookup. Walk ordering cannot
    // fix it and must not appear to: this code has to survive the ordering change untouched.
    const { service } = couponService({ parent: { id: "parent-1" }, openError: null });

    const result = await service.promoteEntity(
      couponEntity({
        id: "e-awin-coupon",
        externalId: "awin-coupon-1",
        networkSource: "awin",
        code: null,
        rawData: {},
      }),
    );

    assert.equal(result.result, "failed");
    assert.equal(
      result.error.code,
      "MISSING_PARENT_CAMPAIGN",
      "the payload-level gap is still reported distinctly from PARENT_CAMPAIGN_NOT_FOUND",
    );
  });
});
