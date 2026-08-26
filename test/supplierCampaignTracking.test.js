import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAssignedTrackingSlug,
  buildSupplierCampaignMboTracking,
  resolveSupplierCampaignBrandSlug,
} from "../src/modules/commercial/supplierCampaignTracking.js";

describe("supplierCampaignTracking", () => {
  it("builds brand-only MBO tracking at supplier sync", () => {
    const built = buildSupplierCampaignMboTracking({
      merchantNameRaw: "dazn.com",
      campaignName: "NFL Game Pass International (RETIRED)",
      trackingUrl: "https://prf.hn/click/?camref=1100",
    });
    assert.match(built.mboTrackingUrl, /\/r\/dazn-com\/[A-Z0-9]+$/);
    assert.equal(built.mboTrackingSlug, "dazn-com");
    assert.ok(built.mboTrackingToken);
  });

  it("skips MBO tracking when supplier URL is missing", () => {
    const built = buildSupplierCampaignMboTracking({
      merchantNameRaw: "dazn.com",
      campaignName: "NFL Game Pass International (RETIRED)",
    });
    assert.equal(built.mboTrackingUrl, null);
  });

  it("appends client slug at the end when assigned", () => {
    assert.equal(
      buildAssignedTrackingSlug({
        brandSlug: "dazn-com",
        clientSlug: "thecosmicstack",
      }),
      "dazn-com-thecosmicstack",
    );
  });

  it("preserves existing token on resync", () => {
    const first = buildSupplierCampaignMboTracking({
      merchantNameRaw: "H&M",
      trackingUrl: "https://prf.hn/click/?camref=1",
    });
    const second = buildSupplierCampaignMboTracking(
      {
        merchantNameRaw: "H&M",
        trackingUrl: "https://prf.hn/click/?camref=1",
      },
      first,
    );
    assert.equal(second.mboTrackingToken, first.mboTrackingToken);
  });

  it("derives brand slug from merchant display name", () => {
    assert.equal(
      resolveSupplierCampaignBrandSlug({
        merchant: { displayName: "Bath & Body Works" },
        campaignName: "UAE",
      }),
      "bath-body-works",
    );
  });
});
