import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { MerchantQueryService } from "../src/modules/merchant/services/query/merchantQuery.service.js";
import { MerchantService } from "../src/modules/merchant/services/merchant.service.js";

describe("MerchantQueryService duplicate detection", () => {
  it("finds merchants with matching normalized names", async () => {
    const merchantRepo = {
      findById: mock.fn(async () => ({
        id: "m1",
        displayName: "Ubuy India",
        normalizedName: "ubuy india",
      })),
      findMany: mock.fn(async () => ({
        rows: [
          { id: "m1", displayName: "Ubuy India", normalizedName: "ubuy india", status: "ACTIVE", isVerified: false },
          { id: "m2", displayName: "UBUY India Store", normalizedName: "ubuy india store", status: "ACTIVE", isVerified: false },
          { id: "m3", displayName: "Other", normalizedName: "other", status: "ACTIVE", isVerified: false },
        ],
      })),
    };

    const service = new MerchantQueryService({ merchantRepo });
    const duplicates = await service.findDuplicates("m1");

    assert.ok(duplicates.some((d) => d.merchant.id === "m2"));
    assert.ok(!duplicates.some((d) => d.merchant.id === "m3"));
  });
});

describe("MerchantService merge", () => {
  it("marks source merchant as merged and reassigns aliases", async () => {
    const updates = [];
    const merchantRepo = {
      findById: mock.fn(async (id) => {
        if (id === "source") return { id: "source", status: "ACTIVE", notes: null };
        if (id === "target") return { id: "target", status: "ACTIVE" };
        return null;
      }),
      update: mock.fn(async (id, data) => {
        updates.push({ id, data });
        return { id, ...data };
      }),
    };
    const aliasRepo = {
      reassignMerchant: mock.fn(async () => ({ count: 2 })),
    };
    const campaignRepo = {};
    const reviewRepo = {};

    const tx = {
      supplierCampaign: { updateMany: mock.fn(async () => ({})) },
      merchantReview: { updateMany: mock.fn(async () => ({})) },
    };

    const service = new MerchantService({ merchantRepo, aliasRepo, campaignRepo, reviewRepo });
    const result = await service.merge("source", { targetMerchantId: "target" }, "user-1", tx);

    assert.equal(result.id, "target");
    assert.equal(aliasRepo.reassignMerchant.mock.calls.length, 1);
    assert.ok(updates.some((u) => u.id === "source" && u.data.status === "MERGED"));
  });
});
