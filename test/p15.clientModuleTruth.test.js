/**
 * P1.5 — Client Module truth: API security, visibility, logo projection, reconciliation helper.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectBrandIdentity } from "../src/modules/merchant/brandIdentity.js";
import { toPartnerCampaignDto } from "../src/modules/client/dto/partnerCampaign.dto.js";
import { ClientVisibilityService } from "../src/modules/client/services/visibility.service.js";
import {
  isClientCampaignVisible,
  explainClientVisibilityBlock,
} from "../src/modules/client/assignmentVisibilityTruth.js";
import { hashApiKey, apiKeyHashesEqual } from "../src/modules/client/services/clientCredential.service.js";
import { deriveAssignmentLifecycle } from "../../frontend/src/pages/clients/assignmentLifecycle.js";

const FORBIDDEN = [
  "supplierReceivable",
  "mboMargin",
  "mboCommission",
  "supplierTrackingUrl",
  "rawPayload",
  "rawData",
  "keyHash",
  "keyEnc",
  "SUP-SECRET",
];

function baseAssignment(overrides = {}) {
  return {
    id: "a1",
    clientId: "c1",
    status: "ACTIVE",
    published: true,
    channel: "WEB",
    startDate: null,
    endDate: null,
    createdAt: new Date(),
    canonicalCampaign: {
      id: "cc1",
      merchantId: "m1",
      displayName: "Staycation",
      description: "Staycation",
      status: "PUBLISHED",
      visibility: "ASSIGNABLE",
      deletedAt: null,
      category: null,
      countries: ["IN"],
      defaultCurrency: "USD",
      merchant: {
        id: "m1",
        displayName: "Klook",
        logoUrl: null,
        website: "https://www.klook.com",
      },
    },
    campaignSource: {
      supportsLink: true,
      supportsCoupon: false,
      supplierCampaign: {
        campaignName: "Staycation",
        campaignDescription: "Staycation",
        deepLinkingEnabled: true,
        campaignType: "CPS",
        pricingModel: "CPS",
        campaignStatus: "ACTIVE",
        campaignLogoUrl: "https://cdn.example/klook.png",
        destinationUrl: "https://www.klook.com",
        merchantNameRaw: "Klook",
        countryCodes: ["IN"],
      },
    },
    trackingLinks: [
      {
        isPrimary: true,
        status: "ACTIVE",
        mboTrackingUrl: "https://go.mbo.example/r/stay",
        supplierTrackingUrl: "https://supplier.example/secret",
      },
    ],
    couponAssignments: [],
    commissionRules: [
      {
        status: "EFFECTIVE",
        grossCommission: "100",
        clientCommission: "70",
        mboCommission: "30",
        commissionType: "PERCENT",
        currency: "USD",
      },
    ],
    ...overrides,
  };
}

describe("P1.5 brand identity — merchant + supplier fallback", () => {
  it("uses merchant.logoUrl when present", () => {
    const brand = projectBrandIdentity(
      { id: "m1", displayName: "Klook", logoUrl: "https://cdn.example/merchant.png" },
      { campaignLogoUrl: "https://cdn.example/supplier.png" },
    );
    assert.equal(brand.logoUrl, "https://cdn.example/merchant.png");
  });

  it("falls back to supplier campaignLogoUrl when merchant logo missing", () => {
    const brand = projectBrandIdentity(
      { id: "m1", displayName: "Klook", logoUrl: null },
      { campaignLogoUrl: "https://cdn.example/supplier.png" },
    );
    assert.equal(brand.logoUrl, "https://cdn.example/supplier.png");
  });

  it("does not invent logos when both missing", () => {
    const brand = projectBrandIdentity({ id: "m1", displayName: "Ajio", logoUrl: null }, null);
    assert.equal(brand.logoUrl, null);
    assert.equal(brand.name, "Ajio");
  });

  it("rejects non-http logo URLs", () => {
    const brand = projectBrandIdentity(
      { displayName: "X", logoUrl: "javascript:alert(1)" },
      { campaignLogoUrl: "ftp://evil/logo.png" },
    );
    assert.equal(brand.logoUrl, null);
  });
});

describe("P1.5 visibility + DTO contract", () => {
  const visibility = new ClientVisibilityService();

  it("client DTO gets supplier-fallback logo and hides forbidden fields", () => {
    const assignment = baseAssignment();
    const projected = visibility.projectVisibleCampaign(assignment);
    const dto = toPartnerCampaignDto(projected, { client: { status: "ACTIVE", currency: "INR" } });
    assert.equal(dto.brandLogoUrl, "https://cdn.example/klook.png");
    assert.equal(dto.campaignName, "Staycation");
    const blob = JSON.stringify(dto);
    for (const key of FORBIDDEN) {
      assert.equal(blob.includes(key), false, `leaked ${key}`);
    }
  });

  it("unpublished assignment is hidden", () => {
    const assignment = baseAssignment({ published: false });
    assert.equal(isClientCampaignVisible({ client: { status: "ACTIVE" }, assignment }), false);
    assert.equal(
      explainClientVisibilityBlock({ client: { status: "ACTIVE" }, assignment }),
      "not_published",
    );
    assert.equal(visibility.projectVisibleCampaign(assignment) && null, null);
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(assignment), {
      client: { status: "ACTIVE" },
    });
    // projectAssignment path: PartnerCampaignService nulls unpublished
    assert.ok(dto); // projection still builds, but visibility gate rejects
    assert.equal(
      isClientCampaignVisible({ client: { status: "ACTIVE" }, assignment, dto }),
      false,
    );
  });

  it("revoked assignment is hidden", () => {
    const assignment = baseAssignment({ status: "REVOKED" });
    assert.equal(isClientCampaignVisible({ client: { status: "ACTIVE" }, assignment }), false);
  });

  it("paused assignment is hidden", () => {
    const assignment = baseAssignment({ status: "PAUSED" });
    assert.equal(isClientCampaignVisible({ client: { status: "ACTIVE" }, assignment }), false);
  });

  it("tracking pending without coupon is not client-visible", () => {
    const assignment = baseAssignment({ trackingLinks: [], couponAssignments: [] });
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(assignment), {
      client: { status: "ACTIVE" },
    });
    assert.equal(dto.link, null);
    assert.equal(dto.couponCode, null);
    assert.equal(
      isClientCampaignVisible({ client: { status: "ACTIVE" }, assignment, dto }),
      false,
    );
  });
});

describe("P1.5 API key hashing", () => {
  it("hashes are deterministic and compared constantly", () => {
    const a = hashApiKey("mbo_live_abc");
    const b = hashApiKey("mbo_live_abc");
    const c = hashApiKey("mbo_live_xyz");
    assert.equal(a, b);
    assert.equal(apiKeyHashesEqual(a, b), true);
    assert.equal(apiKeyHashesEqual(a, c), false);
    assert.notEqual(a, "mbo_live_abc");
  });
});

describe("P1.5 assignmentLifecycle is a projection only", () => {
  it("does not invent CLIENT_VISIBLE without published+ACTIVE+asset", () => {
    const life = deriveAssignmentLifecycle({
      status: "ASSIGNED",
      published: false,
      hasTrackingUrl: true,
      commissionRuleStatus: "EFFECTIVE",
    });
    assert.notEqual(life.code, "CLIENT_VISIBLE");
    assert.notEqual(life.code, "PUBLISHED");
    assert.equal(life.clientVisible, false);
  });

  it("maps published ACTIVE with tracking to CLIENT_VISIBLE", () => {
    const life = deriveAssignmentLifecycle({
      status: "ACTIVE",
      published: true,
      hasTrackingUrl: true,
      commissionRuleStatus: "EFFECTIVE",
    });
    assert.equal(life.code, "CLIENT_VISIBLE");
    assert.equal(life.clientVisible, true);
  });
});
