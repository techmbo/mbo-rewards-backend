import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RakutenCommissionPersistenceService } from "../src/modules/commercial/rakutenCommissionPersistence.service.js";

function offerEntity(overrides = {}) {
  return {
    id: "offer-entity-1",
    networkSource: "rakuten",
    entityType: "offer",
    externalId: "rakuten-offer-1001",
    updatedAt: new Date("2026-09-03T06:00:00Z"),
    rawData: {
      advertiser: { id: 42 },
      goid: 1001,
      name: "Baseline Offer",
      status: "active",
      start_datetime: "2026-09-01T00:00:00Z",
      offer_rules: [
        {
          oid: 9001,
          is_base_commission: true,
          commissions: [
            {
              commission_type: "sale",
              description: "3% Base Commission",
              dynamic_rules: [],
              tiers: [{ commission: 3, threshold: 0, upper_threshold: null }],
            },
            {
              commission_type: "flat",
              description: "Flat payout",
              dynamic_rules: [],
              tiers: [{ commission: 2, threshold: 0, upper_threshold: null }],
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe("Rakuten commission persistence", () => {
  it("persists only VERIFIED finance-ready candidates against the promoted campaign source", async () => {
    const writes = [];
    const db = {
      supplierCampaign: {
        findFirst: async () => ({
          id: "supplier-campaign-db-42",
          supplierCampaignId: "42",
          currencyCode: "USD",
          commissionCurrency: null,
          campaignSources: [{ id: "campaign-source-42" }],
        }),
      },
    };
    const ruleService = {
      upsertNormalizedFact: async (input) => {
        writes.push(input);
        return { id: `rule-${writes.length}` };
      },
    };

    const service = new RakutenCommissionPersistenceService({ prisma: db, ruleService });
    const result = await service.persistOfferEntity(offerEntity());

    assert.equal(result.skipped, false);
    assert.equal(result.candidateCount, 2);
    assert.equal(result.financeReady, 1);
    assert.equal(result.reviewRequired, 1);
    assert.equal(result.persisted, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].supplier, "RAKUTEN");
    assert.equal(writes[0].supplierCampaignId, "supplier-campaign-db-42");
    assert.equal(writes[0].campaignSourceId, "campaign-source-42");
    assert.equal(writes[0].mappingStatus, "VERIFIED");
    assert.equal(writes[0].metadata.financeReady, true);
    assert.equal(writes[0].metadata.promotionGate, "VERIFIED_FINANCE_READY_ONLY");
  });

  it("fails closed when the Rakuten advertiser has not been promoted", async () => {
    const db = {
      supplierCampaign: {
        findFirst: async () => null,
      },
    };
    const service = new RakutenCommissionPersistenceService({
      prisma: db,
      ruleService: { upsertNormalizedFact: async () => assert.fail("must not persist") },
    });

    const result = await service.persistOfferEntity(offerEntity());
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "supplier_campaign_not_promoted");
    assert.equal(result.sourceAdvertiserId, "42");
  });

  it("fails closed when CampaignSource normalization is not complete", async () => {
    const db = {
      supplierCampaign: {
        findFirst: async () => ({
          id: "supplier-campaign-db-42",
          supplierCampaignId: "42",
          campaignSources: [],
        }),
      },
    };
    const service = new RakutenCommissionPersistenceService({
      prisma: db,
      ruleService: { upsertNormalizedFact: async () => assert.fail("must not persist") },
    });

    const result = await service.persistOfferEntity(offerEntity());
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "campaign_source_not_normalized");
  });
});
