import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { CatalogService } from "../src/modules/catalog/services/catalog.service.js";

describe("CatalogService", () => {
  it("rejects attaching supplier campaign linked to another catalog entry", async () => {
    const catalogRepo = {
      findById: mock.fn(async () => ({ id: "cc1", merchantId: "m1" })),
    };
    const campaignRepo = {
      findById: mock.fn(async () => ({
        id: "sc1",
        merchantId: "m1",
        archivedAt: null,
        isJoined: true,
        participationStatus: "JOINED",
        trackingUrl: "https://track.example",
        defaultCommissionValue: "5.0000",
      })),
    };
    const sourceRepo = {
      findByCampaignPair: mock.fn(async () => null),
      findBySupplierCampaignId: mock.fn(async () => [{ canonicalCampaignId: "cc-other" }]),
      findByCanonicalCampaignId: mock.fn(async () => []),
      clearPrimaryForCampaign: mock.fn(async () => ({})),
      create: mock.fn(async () => ({})),
    };
    const merchantRepo = { findById: mock.fn(async () => ({ id: "m1", status: "ACTIVE" })) };

    const service = new CatalogService({
      catalogRepo,
      sourceRepo,
      campaignRepo,
      merchantRepo,
    });

    await assert.rejects(
      () => service.attachSource("cc1", { supplierCampaignId: "sc1" }),
      (error) => error.statusCode === 409,
    );
  });

  it("promotes a joined active source to primary", async () => {
    const sourceRepo = {
      findById: mock.fn(async () => ({
        id: "src1",
        canonicalCampaignId: "cc1",
        isActive: true,
        status: "ACTIVE",
        relationshipStatus: "JOINED",
        priority: 50,
        supplierCampaign: { id: "sc1" },
      })),
      clearPrimaryForCampaign: mock.fn(async () => ({})),
      update: mock.fn(async (_id, data) => ({ id: "src1", ...data })),
    };

    const service = new CatalogService({ sourceRepo });
    const result = await service.promotePrimarySource("src1");

    assert.equal(result.isPrimary, true);
    assert.equal(result.status, "PREFERRED");
    assert.equal(sourceRepo.clearPrimaryForCampaign.mock.calls.length, 1);
  });
});
