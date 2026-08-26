import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractSupplierCampaignId,
  extractSupplierCouponId,
  parseNetworkSource,
  parseSourceAccountLabel,
} from "../src/modules/supplier/entityIdentity.js";

describe("entityIdentity", () => {
  it("parses network source for optimise regions", () => {
    assert.deepEqual(parseNetworkSource("optimise_sea"), {
      supplier: "OPTIMISE",
      supplierRegion: "SEA",
    });
    assert.deepEqual(parseNetworkSource("boostiny"), {
      supplier: "BOOSTINY",
      supplierRegion: "GLOBAL",
    });
  });

  it("parses account label from scoped external id", () => {
    assert.deepEqual(parseSourceAccountLabel("sea-account:boostiny-campaign-42"), {
      sourceAccountLabel: "sea-account",
      localExternalId: "boostiny-campaign-42",
    });
    assert.deepEqual(parseSourceAccountLabel("boostiny-campaign-42"), {
      sourceAccountLabel: "default",
      localExternalId: "boostiny-campaign-42",
    });
  });

  it("extracts supplier campaign id from prefixed external id", () => {
    assert.equal(extractSupplierCampaignId("optimise_sea", "optimise_sea-campaign-991"), "991");
    assert.equal(extractSupplierCampaignId("boostiny", "boostiny-campaign-12"), "12");
  });

  it("extracts supplier coupon id from prefixed external id", () => {
    assert.equal(extractSupplierCouponId("trackier", "trackier-coupon-55"), "55");
    assert.equal(extractSupplierCouponId("optimise_sea", "optimise_sea-voucher-77"), "77");
  });
});
