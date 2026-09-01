/**
 * P1.7 Wave 1 — Client API / DTO contract corrections.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  toPartnerCampaignDto,
  resolveDiscountDisplay,
  derivePartnerAssignmentStatus,
} from "../src/modules/client/dto/partnerCampaign.dto.js";
import { ClientVisibilityService } from "../src/modules/client/services/visibility.service.js";
import {
  projectBrandIdentity,
  brandIdentityToClientLinks,
} from "../src/modules/merchant/brandIdentity.js";
import {
  CLIENT_CAMPAIGN_FORBIDDEN_KEYS,
  CLIENT_CAMPAIGN_06C_KEYS,
} from "../src/modules/client/dto/clientCampaignContract.06c.js";

const FORBIDDEN_EXTRA = ["apiKey", "keyHash", "supplierReceivable", "mboMargin", "rawPayload", "rawData"];

function baseAssignment(overrides = {}) {
  const {
    status = "ACTIVE",
    published = true,
    trackingUrl = "https://go.mbo.example/r/x/token",
    couponCode = "SAVE20",
    discountPercentage = "20% OFF",
    commissionStatus = "EFFECTIVE",
    website = "https://www.klook.com",
    displayName = "Klook Staycation",
    destinationUrl = "https://www.klook.com/activity/99999-deep-activity",
    ...rest
  } = overrides;

  return {
    id: "a1",
    clientId: "client-a",
    status,
    published,
    channel: "WEB",
    startDate: new Date("2026-01-01"),
    endDate: null,
    createdAt: new Date(),
    displayName,
    canonicalCampaign: {
      id: "cc1",
      merchantId: "m1",
      displayName,
      description: null,
      status: "PUBLISHED",
      visibility: "ASSIGNABLE",
      deletedAt: null,
      category: null,
      countries: ["IN"],
      defaultCurrency: null,
      merchant: {
        id: "m1",
        displayName: "Klook",
        logoUrl: null,
        website,
      },
    },
    campaignSource: {
      supportsLink: true,
      supportsCoupon: Boolean(couponCode),
      supplierCampaign: {
        campaignName: displayName,
        campaignDescription: null,
        deepLinkingEnabled: false,
        campaignType: "CPS",
        pricingModel: "CPS",
        campaignStatus: "ACTIVE",
        campaignLogoUrl: null,
        destinationUrl,
        merchantNameRaw: "Klook",
        countryCodes: ["IN"],
      },
    },
    trackingLinks: trackingUrl
      ? [
          {
            isPrimary: true,
            status: "ACTIVE",
            mboTrackingUrl: trackingUrl,
            supplierTrackingUrl: "https://supplier.example/track",
          },
        ]
      : [],
    couponAssignments: couponCode
      ? [
          {
            status: "ACTIVE",
            couponType: "CODE",
            clientCouponCode: couponCode,
            discountPercentage,
            validFrom: null,
            validUntil: null,
          },
        ]
      : [],
    commissionRules: commissionStatus
      ? [
          {
            status: commissionStatus,
            grossCommission: "100",
            clientCommission: "70",
            commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
            currency: "INR",
          },
        ]
      : [],
    ...rest,
  };
}

describe("P1.7 Wave 1 — discountDisplay", () => {
  const visibility = new ClientVisibilityService();

  it("resolveDiscountDisplay never uses campaignName as offer", () => {
    assert.equal(
      resolveDiscountDisplay({
        offer: "Klook Staycation",
        discountPercent: null,
        campaignName: "Klook Staycation",
      }),
      null,
    );
    assert.equal(
      resolveDiscountDisplay({
        offer: null,
        discountPercent: null,
        campaignName: "Klook Staycation",
      }),
      null,
    );
    assert.equal(
      resolveDiscountDisplay({
        offer: "20% OFF",
        discountPercent: 20,
        campaignName: "Klook Staycation",
      }),
      "20% OFF",
    );
    assert.equal(
      resolveDiscountDisplay({
        offer: null,
        discountPercent: 20,
        campaignName: "Klook Staycation",
      }),
      "20% off",
    );
  });

  it("no coupon → discountDisplay null (not campaign name)", () => {
    const assignment = baseAssignment({
      couponCode: null,
      discountPercentage: null,
      displayName: "Klook Staycation",
    });
    assignment.campaignSource.supportsCoupon = false;
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(assignment));
    assert.equal(dto.campaignName, "Klook Staycation");
    assert.equal(dto.discountDisplay, null);
    assert.equal(dto.offer, null);
    assert.equal(dto.discountPercent, null);
  });

  it("real coupon text → discountDisplay; exact percent only when parseable", () => {
    const withText = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(
        baseAssignment({ couponCode: "SAVE20", discountPercentage: "20% OFF" }),
      ),
    );
    assert.equal(withText.discountDisplay, "20% off");
    assert.equal(withText.discountPercent, 20); // authoritative 06A: "10% off" → exact percent
    assert.notEqual(withText.discountDisplay, withText.campaignName);

    const withExact = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(
        baseAssignment({ couponCode: "SAVE20", discountPercentage: "20" }),
      ),
    );
    assert.equal(withExact.discountPercent, 20);
    assert.equal(withExact.discountDisplay, "20% off");
  });
});

describe("P1.7 Wave 1 — assignmentStatus derivation", () => {
  const visibility = new ClientVisibilityService();

  it("ASSIGNED when no commission and no tracking", () => {
    const projected = visibility.projectVisibleCampaign(
      baseAssignment({
        status: "ASSIGNED",
        published: false,
        trackingUrl: null,
        couponCode: null,
        commissionStatus: null,
      }),
    );
    assert.equal(derivePartnerAssignmentStatus(projected), "ASSIGNED");
    assert.equal(toPartnerCampaignDto(projected).assignmentStatus, "ASSIGNED");
    assert.equal(toPartnerCampaignDto(projected).status, "ASSIGNED");
  });

  it("COMMISSION_READY when EFFECTIVE rule but no tracking/coupon", () => {
    const projected = visibility.projectVisibleCampaign(
      baseAssignment({
        status: "ASSIGNED",
        published: false,
        trackingUrl: null,
        couponCode: null,
        commissionStatus: "EFFECTIVE",
      }),
    );
    assert.equal(toPartnerCampaignDto(projected).assignmentStatus, "COMMISSION_READY");
  });

  it("TRACKING_READY when tracking present but commission not EFFECTIVE", () => {
    const projected = visibility.projectVisibleCampaign(
      baseAssignment({
        status: "ASSIGNED",
        published: false,
        couponCode: null,
        commissionStatus: "DRAFT",
      }),
    );
    assert.equal(toPartnerCampaignDto(projected).assignmentStatus, "TRACKING_READY");
  });

  it("PROVISIONED when commission + tracking but not published", () => {
    const projected = visibility.projectVisibleCampaign(
      baseAssignment({
        status: "ACTIVE",
        published: false,
        commissionStatus: "EFFECTIVE",
      }),
    );
    assert.equal(toPartnerCampaignDto(projected).assignmentStatus, "PROVISIONED");
  });

  it("CLIENT_VISIBLE when published ACTIVE with tracking/coupon", () => {
    const projected = visibility.projectVisibleCampaign(
      baseAssignment({ status: "ACTIVE", published: true }),
    );
    const dto = toPartnerCampaignDto(projected);
    assert.equal(dto.assignmentStatus, "CLIENT_VISIBLE");
    assert.equal(dto.published, true);
    assert.equal(dto.status, "ACTIVE");
    assert.notEqual(dto.assignmentStatus, dto.campaignStatus);
  });

  it("PAUSED and REVOKED from DB status", () => {
    assert.equal(
      toPartnerCampaignDto(
        visibility.projectVisibleCampaign(baseAssignment({ status: "PAUSED", published: false })),
      ).assignmentStatus,
      "PAUSED",
    );
    assert.equal(
      toPartnerCampaignDto(
        visibility.projectVisibleCampaign(baseAssignment({ status: "REVOKED", published: false })),
      ).assignmentStatus,
      "REVOKED",
    );
  });
});

describe("P1.7 Wave 1 — brandWebsiteUrl", () => {
  const visibility = new ClientVisibilityService();

  it("Case A: Merchant.website used", () => {
    const brand = projectBrandIdentity(
      { id: "m1", displayName: "Klook", website: "https://www.klook.com" },
      { destinationUrl: "https://www.klook.com/activity/123" },
    );
    assert.equal(brandIdentityToClientLinks(brand).brandWebsiteUrl, "https://www.klook.com");

    const dto = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(baseAssignment({ website: "https://www.klook.com" })),
    );
    assert.equal(dto.brandWebsiteUrl, "https://www.klook.com");
  });

  it("Case B: no Merchant.website → fall back to landing destinationUrl (never tracking)", () => {
    const brand = projectBrandIdentity(
      { id: "m1", displayName: "Klook", website: null },
      {
        destinationUrl: "https://www.klook.com/activity/12345-deep",
        trackingUrl: "https://track.example/x",
      },
    );
    assert.equal(brand.websiteUrl, "https://www.klook.com/activity/12345-deep");

    const dto = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(
        baseAssignment({
          website: null,
          destinationUrl: "https://www.klook.com/activity/12345-deep",
        }),
      ),
    );
    assert.equal(dto.brandWebsiteUrl, "https://www.klook.com/activity/12345-deep");
  });

  it("Case C: no Merchant.website + no brand source → null", () => {
    const brand = projectBrandIdentity(
      { id: "m1", displayName: "Acme", website: null },
      { destinationUrl: null },
    );
    assert.equal(brand.websiteUrl, null);
  });
});

describe("P1.7 Wave 1 — campaignType vs commercialModel", () => {
  it("channel campaignType is not commercial CPS when both present", () => {
    const visibility = new ClientVisibilityService();
    const dto = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(baseAssignment()),
    );
    assert.equal(dto.commercialModel, "CPS");
    assert.ok(["LINK", "COUPON", "COUPON_LINK", "DEEPLINK"].includes(dto.campaignType));
    assert.notEqual(dto.campaignType, dto.commercialModel);
    assert.equal(dto.channelType, dto.campaignType);
  });
});

describe("P1.7 Wave 1 — forbidden fields + 06C keys", () => {
  it("serialized DTO never includes forbidden finance/secrets", () => {
    const visibility = new ClientVisibilityService();
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(baseAssignment()));
    const blob = JSON.stringify(dto);
    for (const key of [...CLIENT_CAMPAIGN_FORBIDDEN_KEYS, ...FORBIDDEN_EXTRA]) {
      assert.equal(blob.includes(`"${key}"`), false, `leaked key ${key}`);
      assert.equal(dto[key], undefined, `top-level ${key}`);
    }
    assert.equal(blob.includes("supplier.example"), false);
    assert.equal(dto.tracking?.supplierTrackingUrl, undefined);
    assert.ok(CLIENT_CAMPAIGN_06C_KEYS.includes("assignmentStatus"));
    assert.equal("assignmentStatus" in dto, true);
  });
});
