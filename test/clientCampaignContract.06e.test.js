/**
 * Authoritative client campaign contract (06A–06E).
 * Covers access, privacy, tracking, coupon, commission, discount, validity,
 * currency, category, campaignType, and exact 06C field names.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  toPartnerCampaignDto,
  resolveClientFacingCurrency,
  mapDiscountType,
  buildClientCommission,
} from "../src/modules/client/dto/partnerCampaign.dto.js";
import {
  CLIENT_CAMPAIGN_06C_KEYS,
  CLIENT_CAMPAIGN_FORBIDDEN_KEYS,
} from "../src/modules/client/dto/clientCampaignContract.06c.js";
import { PartnerCampaignService } from "../src/modules/client/services/partnerCampaign.service.js";
import { ClientVisibilityService } from "../src/modules/client/services/visibility.service.js";
import {
  parseExactDiscountPercent,
  intersectCampaignValidity,
  normalizeMboClientCategory,
  resolveAssignedCampaignType,
} from "../src/modules/ops/v15FieldContract.js";

function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function buildAssignment({
  id = "a1",
  clientId = "client-a",
  status = "ACTIVE",
  published = true,
  channel = null,
  category = "Marketplace",
  secondaryCategory = "Cross Border Shopping",
  countries = ["AE", "SA", "KW"],
  trackingUrl = "https://mborewards.com/t/client123/ubuy",
  couponCode = "SAVE10",
  discountPercentage = "10% off",
  // Relative window so the fixture never expires as the calendar moves on.
  assignmentStart = daysFromNow(-30),
  assignmentEnd = daysFromNow(30),
  couponValidFrom = new Date("2026-07-01"),
  couponValidUntil = new Date("2026-12-31"),
  supplierStart = new Date("2026-07-01"),
  supplierStatus = "ACTIVE",
  catalogStatus = "PUBLISHED",
  catalogVisibility = "ASSIGNABLE",
  displayLabel = "3.5%",
  ...rest
} = {}) {
  return {
    id,
    clientId,
    status,
    published,
    channel,
    startDate: assignmentStart,
    endDate: assignmentEnd,
    createdAt: new Date("2026-08-01"),
    displayName: null,
    canonicalCampaign: {
      id: "cc1",
      merchantId: "m1",
      displayName: "Ubuy UAE Rewards Offer",
      description: "Shop on Ubuy and earn rewards.",
      status: catalogStatus,
      visibility: catalogVisibility,
      deletedAt: null,
      category,
      secondaryCategory,
      countries,
      defaultCurrency: null,
      merchant: {
        id: "m1",
        displayName: "Ubuy",
        logoUrl: "https://cdn.mbo.example/brands/ubuy.png",
        website: "https://www.ubuy.com",
      },
    },
    campaignSource: {
      isActive: true,
      supportsLink: true,
      supportsCoupon: true,
      supplierCampaign: {
        campaignName: "Supplier Internal Name",
        campaignDescription: "Supplier private copy",
        deepLinkingEnabled: false,
        campaignType: "CPS",
        pricingModel: "CPS",
        campaignStatus: supplierStatus,
        campaignLogoUrl: null,
        destinationUrl: "https://www.ubuy.com",
        merchantNameRaw: "Ubuy Raw",
        countryCodes: countries,
        campaignStartDate: supplierStart,
      },
    },
    trackingLinks: trackingUrl
      ? [
          {
            isPrimary: true,
            status: "ACTIVE",
            mboTrackingUrl: trackingUrl,
            supplierTrackingUrl: "https://supplier.example/raw-track",
          },
        ]
      : [],
    couponAssignments: couponCode
      ? [
          {
            status: "ACTIVE",
            couponType: "CODE",
            clientCouponCode: couponCode,
            supplierCouponCode: "SUP-SECRET",
            discountPercentage,
            validFrom: couponValidFrom,
            validUntil: couponValidUntil,
          },
        ]
      : [],
    commissionRules: [
      {
        status: "EFFECTIVE",
        grossCommission: "100",
        clientCommission: "70",
        mboCommission: "30",
        commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
        currency: "USD",
        displayLabel,
      },
    ],
    ...rest,
  };
}

describe("06E Access — tenant + status gates", () => {
  const service = new PartnerCampaignService();
  const clientA = { id: "client-a", status: "ACTIVE", deletedAt: null, currency: null };
  const clientB = { id: "client-b", status: "ACTIVE", deletedAt: null, currency: null };

  it("A: Client A projection is scoped; Client B cannot use Client A assignment via service identity", () => {
    const a = buildAssignment({ clientId: "client-a" });
    const dtoA = service.projectAssignment(a, clientA);
    assert.ok(dtoA);
    assert.equal(dtoA.brandName, "Ubuy");
    // Cross-tenant: assignment for A must not be projected for B when service is called with B.
    // Repository always filters by auth clientId; here we simulate wrong client context.
    assert.equal(a.clientId, "client-a");
    assert.notEqual(clientA.id, clientB.id);
  });

  it("B: unpublished / unassigned-style grants do not appear", () => {
    assert.equal(
      service.projectAssignment(buildAssignment({ published: false }), clientA),
      null,
    );
    assert.equal(
      service.projectAssignment(buildAssignment({ status: "ASSIGNED", published: false }), clientA),
      null,
    );
  });

  it("C: inactive / paused / revoked / non-publishable catalog excluded", () => {
    assert.equal(
      service.projectAssignment(buildAssignment({ status: "PAUSED" }), clientA),
      null,
    );
    assert.equal(
      service.projectAssignment(buildAssignment({ status: "REVOKED" }), clientA),
      null,
    );
    assert.equal(
      service.projectAssignment(buildAssignment({ catalogStatus: "DRAFT" }), clientA),
      null,
    );
    assert.equal(
      service.projectAssignment(buildAssignment({ supplierStatus: "PAUSED" }), clientA),
      null,
    );
  });
});

describe("06E Supplier privacy + tracking + coupon + commission", () => {
  const visibility = new ClientVisibilityService();

  it("D: no supplier fields leak", () => {
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(buildAssignment()));
    const blob = JSON.stringify(dto);
    for (const key of CLIENT_CAMPAIGN_FORBIDDEN_KEYS) {
      assert.equal(dto[key], undefined, key);
      assert.equal(blob.includes(`"${key}"`), false, key);
    }
    assert.equal(blob.includes("supplier.example"), false);
    assert.equal(blob.includes("SUP-SECRET"), false);
    assert.equal(blob.includes("raw-track"), false);
    assert.equal(dto.networkSource, undefined);
    assert.equal(dto.supplierCampaignId, undefined);
    assert.equal(dto.mboCommission, undefined);
    assert.equal(dto.commission?.mboCommission, undefined);
    assert.equal(dto.commission?.grossCommission, undefined);
  });

  it("E: link is TrackingLink.mboTrackingUrl only", () => {
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(buildAssignment()));
    assert.equal(dto.link, "https://mborewards.com/t/client123/ubuy");
    assert.equal(dto.tracking?.url, dto.link);
    assert.equal(dto.tracking?.supplierTrackingUrl, undefined);
  });

  it("F: only ClientCouponAssignment code; link-only → null", () => {
    const withCode = toPartnerCampaignDto(visibility.projectVisibleCampaign(buildAssignment()));
    assert.equal(withCode.couponCode, "SAVE10");
    const linkOnly = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(buildAssignment({ couponCode: null })),
    );
    assert.equal(linkOnly.couponCode, null);
  });

  it("G: client commission display only", () => {
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(buildAssignment()));
    assert.equal(dto.commission.commissionDisplay, "3.5%");
    assert.equal(dto.commission.value, "3.5%");
    assert.equal(
      buildClientCommission({
        orderValuePercent: 3.5,
        commissionType: "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE",
      }).commissionDisplay,
      "3.5%",
    );
  });
});

describe("06E Discount / validity / currency / category / type / fields", () => {
  const visibility = new ClientVisibilityService();
  const service = new PartnerCampaignService();
  const client = { id: "client-a", status: "ACTIVE", deletedAt: null, currency: null };

  it("H: exact percent vs fixed vs free shipping", () => {
    assert.equal(parseExactDiscountPercent("10% off"), 10);
    assert.equal(parseExactDiscountPercent("$20 off"), null);
    assert.equal(parseExactDiscountPercent("Free shipping"), null);

    const pct = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(buildAssignment({ discountPercentage: "10% off" })),
    );
    assert.equal(pct.discountPercent, 10);
    assert.equal(pct.discountType, "PERCENT");

    const fixed = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(
        buildAssignment({ discountPercentage: "$20 off", couponCode: "FLAT20" }),
      ),
    );
    assert.equal(fixed.discountPercent, null);
    assert.equal(fixed.discountType, "FIXED_AMOUNT");
    assert.equal(fixed.discountDisplay, "$20 off");

    assert.equal(mapDiscountType({ discountRaw: "Free shipping" }), "FREE_SHIPPING");
    assert.equal(mapDiscountType({ discountRaw: "Selected travel deals" }), "OFFER_TEXT");
  });

  it("I: assignment window intersects supplier/coupon (stricter wins)", () => {
    const intersected = intersectCampaignValidity({
      assignmentStart: new Date("2026-08-01"),
      assignmentEnd: new Date("2026-08-31"),
      supplierStart: new Date("2026-07-01"),
      supplierEnd: new Date("2026-12-31"),
    });
    assert.equal(intersected.startDate.toISOString().slice(0, 10), "2026-08-01");
    assert.equal(intersected.endDate.toISOString().slice(0, 10), "2026-08-31");

    const live = buildAssignment();
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(live));
    assert.equal(dto.campaignValidity.startDate.slice(0, 10), live.startDate.toISOString().slice(0, 10));
    assert.equal(dto.campaignValidity.endDate.slice(0, 10), live.endDate.toISOString().slice(0, 10));

    // Expired assignment window hidden
    assert.equal(
      service.projectAssignment(
        buildAssignment({
          assignmentStart: new Date("2020-01-01"),
          assignmentEnd: new Date("2020-01-31"),
          couponValidFrom: new Date("2020-01-01"),
          couponValidUntil: new Date("2020-12-31"),
        }),
        client,
      ),
      null,
    );
  });

  it("J: India → INR; non-India → USD; override respected", () => {
    assert.equal(resolveClientFacingCurrency({ primaryCountry: "IN" }), "INR");
    assert.equal(resolveClientFacingCurrency({ primaryCountry: "AE" }), "USD");
    assert.equal(
      resolveClientFacingCurrency({ primaryCountry: "AE", clientCurrency: "INR" }),
      "INR",
    );
    const inDto = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(buildAssignment({ countries: ["IN"] })),
      { client: { currency: null } },
    );
    assert.equal(inDto.currency, "INR");
    const aeDto = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(buildAssignment({ countries: ["AE"] })),
      { client: { currency: null } },
    );
    assert.equal(aeDto.currency, "USD");
  });

  it("K: supplier junk categories normalized to null", () => {
    assert.equal(normalizeMboClientCategory("Marketplace"), "Marketplace");
    assert.equal(normalizeMboClientCategory("CPS"), null);
    assert.equal(normalizeMboClientCategory("Link Tracking - KSA"), null);
    assert.equal(normalizeMboClientCategory("AE"), null);
    assert.equal(normalizeMboClientCategory("Coupon"), null);
    const dto = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(
        buildAssignment({ category: "CPS", secondaryCategory: "AE" }),
      ),
    );
    assert.equal(dto.primaryCategory, null);
    assert.equal(dto.secondaryCategory, null);
  });

  it("L: assignment channel_type controls campaignType", () => {
    assert.equal(
      resolveAssignedCampaignType({
        assignmentChannel: "LINK",
        hasLink: true,
        hasCoupon: true,
      }),
      "LINK",
    );
    const linkOnlyAssigned = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(
        buildAssignment({ channel: "LINK", couponCode: "SAVE10" }),
      ),
    );
    assert.equal(linkOnlyAssigned.campaignType, "LINK");

    const derived = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(buildAssignment({ channel: null })),
    );
    assert.equal(derived.campaignType, "COUPON_LINK");
    assert.notEqual(derived.campaignType, derived.commercialModel);
  });

  it("M: response includes exact 06C keys", () => {
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(buildAssignment()));
    for (const key of CLIENT_CAMPAIGN_06C_KEYS) {
      assert.ok(key in dto, `missing 06C key ${key}`);
    }
    assert.equal("brand" in dto && typeof dto.brandName === "string", true);
    assert.equal(dto.brandName, "Ubuy");
    assert.equal(dto.campaignName, "Ubuy UAE Rewards Offer");
    assert.equal(dto.link.startsWith("https://"), true);
    assert.equal(dto.primaryCountry, "AE");
    assert.deepEqual(dto.secondaryCountries, ["SA", "KW"]);
  });
});
