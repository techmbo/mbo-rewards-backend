import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientVisibilityService } from "../src/modules/client/services/visibility.service.js";

describe("ClientVisibilityService", () => {
  const visibility = new ClientVisibilityService();

  const activeClient = { id: "c1", status: "ACTIVE", deletedAt: null };
  const publishedCampaign = {
    id: "cc1",
    status: "PUBLISHED",
    visibility: "ASSIGNABLE",
    deletedAt: null,
    displayName: "Ubuy Global",
    merchantId: "m1",
  };

  it("allows visible assignments only when published and active", () => {
    const visible = visibility.isAssignmentVisibleToClient(
      { published: true, status: "ACTIVE", canonicalCampaign: publishedCampaign },
      { client: activeClient },
    );
    const hidden = visibility.isAssignmentVisibleToClient(
      { published: false, status: "ASSIGNED", canonicalCampaign: publishedCampaign },
      { client: activeClient },
    );

    assert.equal(visible, true);
    assert.equal(hidden, false);
  });

  it("rejects hidden catalog campaigns", () => {
    assert.equal(
      visibility.isCatalogAssignable({ ...publishedCampaign, visibility: "HIDDEN" }),
      false,
    );
    assert.equal(
      visibility.isCatalogPublishable({ ...publishedCampaign, visibility: "HIDDEN" }),
      false,
    );
  });

  it("projects client-safe campaign data without supplier fields", () => {
    const projection = visibility.projectVisibleCampaign({
      id: "a1",
      channel: "WEB",
      startDate: new Date("2026-01-01"),
      endDate: null,
      published: true,
      status: "ACTIVE",
      canonicalCampaign: publishedCampaign,
      trackingLinks: [
        {
          isPrimary: true,
          status: "ACTIVE",
          mboTrackingUrl: "https://go.mbo.example/r/mbo_abc",
          supplierTrackingUrl: "https://supplier.example/track",
        },
      ],
      couponAssignments: [
        {
          status: "ACTIVE",
          couponType: "CODE",
          clientCouponCode: "SAVE10",
          supplierCouponCode: "SUP-SECRET",
          discountPercentage: "10",
        },
      ],
      commissionRules: [
        {
          status: "EFFECTIVE",
          grossCommission: "100",
          clientCommission: "70",
          mboCommission: "30",
          commissionType: "PERCENT",
        },
      ],
    });

    assert.equal(projection.campaign.displayName, "Ubuy Global");
    assert.equal(projection.campaign.supplier, undefined);
    assert.equal(projection.campaign.sources, undefined);
    assert.equal(projection.tracking.mboTrackingUrl, "https://go.mbo.example/r/mbo_abc");
    assert.equal(projection.tracking.supplierTrackingUrl, undefined);
    assert.equal(projection.coupon.code, "SAVE10");
    assert.equal(projection.coupon.supplierCouponCode, undefined);
    assert.equal(projection.commercial.clientSharePercent, 70);
    assert.equal(projection.commercial.mboSharePercent, undefined);
    assert.equal(projection.commercial.mboCommission, undefined);
  });
});
