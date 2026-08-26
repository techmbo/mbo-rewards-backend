import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { Prisma } from "@prisma/client";
import { PromotionJob } from "../src/jobs/promotion.job.js";

describe("PromotionJob retry", () => {
  it("loads exactly the requested mapper error ids", async () => {
    const findByIds = mock.fn(async (ids) =>
      ids.map((id) => ({ id, entityId: `entity-${id}`, status: "OPEN" })),
    );

    const job = new PromotionJob({
      mapperErrorRepo: {
        findByIds,
        findMany: async () => {
          throw new Error("findMany should not be called when ids are provided");
        },
        updateStatus: async () => ({}),
      },
      entityRepo: {
        findById: async (id) => ({
          id,
          entityType: "campaign",
          networkSource: "boostiny",
          externalId: "boostiny-campaign-1",
          rawData: { id: 1, name: "A", status: "active" },
          normalizedData: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
      campaignPromotion: {
        promoteEntity: async () => ({ result: "updated" }),
      },
      couponPromotion: {
        promoteEntity: async () => ({ result: "skipped" }),
      },
      promotionService: {
        ensureSuppliersSeeded: async () => {},
      },
    });

    const summary = await job.retryFailed({ mapperErrorIds: ["err-a", "err-b"] });

    assert.equal(findByIds.mock.calls.length, 1);
    assert.deepEqual(findByIds.mock.calls[0].arguments[0], ["err-a", "err-b"]);
    assert.equal(summary.processed, 2);
    assert.equal(summary.updated, 2);
  });
});

describe("PromotionJob concurrency handling", () => {
  it("campaign promotion uses upsert path", async () => {
    const { SupplierCampaignPromotionService } = await import(
      "../src/modules/supplier/services/supplierCampaignPromotion.service.js"
    );

    const upsertByBusinessKey = mock.fn(async () => ({
      id: "camp-1",
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const service = new SupplierCampaignPromotionService({
      runInTransaction: async (fn) => fn({}),
      campaignRepo: {
        findByBusinessKey: async () => null,
        upsertByBusinessKey,
        update: async () => ({ id: "camp-1", archivedAt: null }),
      },
      outboxWriter: { append: async () => ({ id: "outbox" }) },
      supplierRepo: { findByKey: async () => ({ id: "sup-1" }) },
      mapperErrorRepo: { findOpenByEntityId: async () => null, create: async () => ({}) },
    });

    const entity = {
      id: "e1",
      externalId: "boostiny-campaign-9",
      networkSource: "boostiny",
      entityType: "campaign",
      entityName: "A",
      campaignName: "A",
      advertiserName: "B",
      entityStatus: "Active",
      entitySubType: null,
      commission: null,
      eventDate: null,
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date(),
      isManual: false,
      normalizedData: {},
      rawData: { id: 9, name: "A", status: "active" },
      hasSyncConflict: false,
      fieldPolicies: null,
    };

    const result = await service.promoteEntity(entity);
    assert.equal(result.result, "created");
    assert.equal(upsertByBusinessKey.mock.calls.length, 1);
  });

  it("recovers from P2002 unique violations on coupon create", async () => {
    const { SupplierCouponPromotionService } = await import(
      "../src/modules/supplier/services/supplierCouponPromotion.service.js"
    );

    const uniqueError = new Prisma.PrismaClientKnownRequestError("Unique constraint", {
      code: "P2002",
      clientVersion: "test",
    });

    let createAttempts = 0;

    const service = new SupplierCouponPromotionService({
      runInTransaction: async (fn) => fn({}),
      campaignRepo: {
        findByBusinessKey: async () => ({ id: "parent-1" }),
      },
      couponRepo: {
        findByEntityId: async () => null,
        findByNaturalKey: async () => (createAttempts > 0 ? { id: "coupon-raced" } : null),
        create: async () => {
          createAttempts += 1;
          throw uniqueError;
        },
        update: async (id) => ({ id }),
      },
      outboxWriter: { append: async () => ({ id: "outbox" }) },
      mapperErrorRepo: { findOpenByEntityId: async () => null, create: async () => ({}) },
    });

    const entity = {
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
    };

    const result = await service.promoteEntity(entity);
    assert.equal(result.result, "updated");
    assert.equal(createAttempts, 1);
  });
});
