import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { MerchantMatchingService } from "../src/modules/merchant/services/merchantMatching.service.js";
import { MATCH_METHODS, MATCH_OUTCOMES } from "../src/modules/merchant/constants.js";

describe("MerchantMatchingService", () => {
  it("returns exact normalized name match with full confidence", async () => {
    const merchantRepo = {
      findByNormalizedName: mock.fn(async () => ({ id: "m1", displayName: "Ubuy" })),
    };
    const aliasRepo = { findBySupplierAlias: mock.fn(async () => null), findByNormalizedAlias: mock.fn(async () => []) };
    const service = new MerchantMatchingService({ merchantRepo, aliasRepo });

    const result = await service.findMatchCandidate({
      merchantNameRaw: "UBUY",
      supplier: "BOOSTINY",
    });

    assert.equal(result.merchantId, "m1");
    assert.equal(result.matchMethod, MATCH_METHODS.EXACT_NORMALIZED_NAME);
    assert.equal(result.outcome, MATCH_OUTCOMES.MATCHED);
    assert.equal(result.confidence, 1);
  });

  it("returns no match when name is empty after normalization", async () => {
    const service = new MerchantMatchingService({
      merchantRepo: { findByNormalizedName: mock.fn(async () => null) },
      aliasRepo: {
        findBySupplierAlias: mock.fn(async () => null),
        findByNormalizedAlias: mock.fn(async () => []),
      },
    });

    const result = await service.findMatchCandidate({
      merchantNameRaw: "!!!",
      supplier: "OPTIMISE",
    });

    assert.equal(result.merchantId, null);
    assert.equal(result.outcome, MATCH_OUTCOMES.NO_MATCH);
  });

  it("auto-links campaign on high-confidence alias match", async () => {
    const campaign = {
      id: "sc1",
      supplier: "TRACKIER",
      merchantNameRaw: "UBUY.COM",
      merchantId: null,
    };

    const merchantRepo = { findByNormalizedName: mock.fn(async () => null) };
    const aliasRepo = {
      findBySupplierAlias: mock.fn(async () => ({
        merchantId: "m-ubuy",
        status: "CONFIRMED",
      })),
      findByNormalizedAlias: mock.fn(async () => []),
      upsertBySupplierAlias: mock.fn(async () => ({})),
    };
    const reviewRepo = {
      upsertBySupplierCampaignId: mock.fn(async () => ({ id: "r1", status: "AUTO_MATCHED" })),
    };
    const campaignRepo = {
      linkMerchant: mock.fn(async () => ({})),
    };

    const service = new MerchantMatchingService({
      merchantRepo,
      aliasRepo,
      reviewRepo,
      campaignRepo,
    });

    const result = await service.matchCampaign(campaign, { matchedBy: "system" });

    assert.equal(result.outcome, MATCH_OUTCOMES.MATCHED);
    assert.equal(campaignRepo.linkMerchant.mock.calls.length, 1);
    assert.equal(aliasRepo.upsertBySupplierAlias.mock.calls.length, 1);
  });
});
