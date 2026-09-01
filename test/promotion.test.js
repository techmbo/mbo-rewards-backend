import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { SupplierCampaignPromotionService } from "../src/modules/supplier/services/supplierCampaignPromotion.service.js";

function buildEntity(overrides = {}) {
  return {
    id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    externalId: "boostiny-campaign-10",
    networkSource: "boostiny",
    entityType: "campaign",
    entityName: "First",
    campaignName: "First",
    advertiserName: "Brand",
    entityStatus: "Active",
    entitySubType: null,
    commission: null,
    eventDate: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date(),
    isManual: false,
    normalizedData: {},
    rawData: { id: 10, name: "First", status: "active" },
    hasSyncConflict: false,
    fieldPolicies: null,
    ...overrides,
  };
}

describe("SupplierCampaignPromotionService idempotency", () => {
  it("creates on first promotion and updates on second with upsert", async () => {
    let stored = null;

    const campaignRepo = {
      findByBusinessKey: mock.fn(async () => stored),
      upsertByBusinessKey: mock.fn(async (_key, createData) => {
        stored = { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", archivedAt: null, ...createData };
        return stored;
      }),
      update: mock.fn(async (_id, data) => {
        stored = { ...stored, ...data };
        return stored;
      }),
    };

    const outboxWriter = {
      append: mock.fn(async () => ({ id: "outbox-1" })),
    };

    const service = new SupplierCampaignPromotionService({
      campaignRepo,
      outboxWriter,
      runInTransaction: async (fn) => fn({}),
      supplierRepo: {
        findByKey: async () => ({ id: "ssssssss-ssss-ssss-ssss-ssssssssssss" }),
      },
      mapperErrorRepo: {
        findOpenByEntityId: async () => null,
        create: async () => ({}),
      },
    });

    const first = await service.promoteEntity(buildEntity());
    const second = await service.promoteEntity(buildEntity({ campaignName: "Updated Name" }));

    assert.equal(first.result, "created");
    assert.equal(second.result, "updated");
    assert.equal(campaignRepo.upsertByBusinessKey.mock.calls.length, 2);
    assert.equal(outboxWriter.append.mock.calls.length, 2);
  });
});
