import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CjProgramTermsPersistenceService } from "../src/modules/commercial/cjProgramTermsPersistence.service.js";

function contract(overrides = {}) {
  return {
    advertiserId: overrides.advertiserId ?? "3022407",
    status: "ACTIVE",
    startTime: "2026-09-01T00:00:00Z",
    endTime: null,
    programTerms: {
      id: "pt-eukhost",
      name: "Default Terms",
      isDefault: true,
      actionTerms: [{
        id: "action-sale",
        actionTracker: { id: "tracker-sale", name: "Pay Per Sale", type: "sim_sale" },
        referralPeriod: 60,
        referralOccurrences: null,
        lockingMethod: { type: "FIXED_DATE", durationInDays: null },
        commissions: [{
          rank: 1,
          rate: { type: "FIXED_PER_ORDER", value: 40, currency: "GBP" },
          itemList: null,
          situation: null,
          promotionalProperties: [],
          isViewThrough: false,
        }],
        performanceIncentives: [],
      }],
    },
  };
}

function createDb({ campaign = null } = {}) {
  return {
    supplierCampaign: {
      async findFirst() {
        return campaign;
      },
    },
  };
}

describe("CJ Program Terms persistence", () => {
  it("skips safely until the CJ advertiser has been promoted to SupplierCampaign", async () => {
    const service = new CjProgramTermsPersistenceService({
      prisma: createDb({ campaign: null }),
      ruleService: { async upsertNormalizedFact() { throw new Error("must not persist"); } },
    });

    const result = await service.persistContract(contract(), { sourceAccountLabel: "default" });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "supplier_campaign_not_promoted");
    assert.equal(result.persisted, 0);
  });

  it("persists finance-ready fixed-per-order Program Terms with campaign lineage", async () => {
    const writes = [];
    const service = new CjProgramTermsPersistenceService({
      prisma: createDb({
        campaign: {
          id: "supplier-campaign-db-1",
          supplierCampaignId: "3022407",
          campaignSources: [{ id: "campaign-source-1" }],
        },
      }),
      ruleService: {
        async upsertNormalizedFact(fact) {
          writes.push(fact);
          return { id: `rule-${writes.length}` };
        },
      },
    });

    const result = await service.persistContract(contract(), {
      sourceAccountLabel: "default",
      sourceEvidenceAt: "2026-09-03T12:00:00Z",
      sourceTransportVerified: true,
    });

    assert.equal(result.skipped, false);
    assert.equal(result.persisted, 1);
    assert.equal(result.financeReady, 1);
    assert.equal(result.reviewRequired, 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].supplier, "CJ");
    assert.equal(writes[0].supplierCampaignId, "supplier-campaign-db-1");
    assert.equal(writes[0].campaignSourceId, "campaign-source-1");
    assert.equal(writes[0].basis, "FIXED_PER_ORDER");
    assert.equal(writes[0].fixedAmount, 40);
    assert.equal(writes[0].currency, "GBP");
    assert.equal(writes[0].metadata.sourceTransportVerified, true);
  });

  it("persists conditional Program Terms as review-required evidence, not payable truth", async () => {
    const writes = [];
    const conditional = contract();
    conditional.programTerms.actionTerms[0].commissions[0] = {
      rank: 20,
      rate: { type: "PERCENT", value: 12, currency: null },
      itemList: { id: "list-premium", name: "Premium SKUs" },
      situation: null,
      promotionalProperties: [],
      isViewThrough: false,
    };
    conditional.programTerms.actionTerms[0].actionTracker.type = "item_sale";

    const service = new CjProgramTermsPersistenceService({
      prisma: createDb({
        campaign: {
          id: "supplier-campaign-db-1",
          supplierCampaignId: "3022407",
          campaignSources: [{ id: "campaign-source-1" }],
        },
      }),
      ruleService: {
        async upsertNormalizedFact(fact) {
          writes.push(fact);
          return fact;
        },
      },
    });

    const result = await service.persistContract(conditional, {
      sourceAccountLabel: "default",
      sourceTransportVerified: true,
    });

    assert.equal(result.persisted, 1);
    assert.equal(result.financeReady, 0);
    assert.equal(result.reviewRequired, 1);
    assert.equal(writes[0].mappingStatus, "REVIEW_REQUIRED");
    assert.equal(writes[0].metadata.financeReady, false);
  });
});
