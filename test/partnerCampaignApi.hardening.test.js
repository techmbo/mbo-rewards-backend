import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { createHash } from "node:crypto";
import {
  apiKeyHashesEqual,
  hashApiKey,
} from "../src/modules/client/services/clientCredential.service.js";
import { toPartnerCampaignDto } from "../src/modules/client/dto/partnerCampaign.dto.js";
import { PartnerCampaignService } from "../src/modules/client/services/partnerCampaign.service.js";
import { ClientVisibilityService } from "../src/modules/client/services/visibility.service.js";

describe("API key hashing security", () => {
  it("hashes keys with sha256 and compares in constant time", () => {
    const raw = "mbo_live_abcdefghijklmnopqrstuvwx";
    const hash = hashApiKey(raw);
    assert.equal(hash, createHash("sha256").update(raw).digest("hex"));
    assert.equal(apiKeyHashesEqual(hash, hashApiKey(raw)), true);
    assert.equal(apiKeyHashesEqual(hash, hashApiKey("mbo_live_different")), false);
    assert.equal(apiKeyHashesEqual(null, hash), false);
  });
});

describe("Partner campaign published visibility", () => {
  const visibility = new ClientVisibilityService();

  function assignment({ published = true, status = "ACTIVE" } = {}) {
    return {
      id: "a1",
      clientId: "client-a",
      status,
      published,
      channel: "WEB",
      createdAt: new Date(),
      canonicalCampaign: {
        id: "cc1",
        merchantId: "m1",
        displayName: "Staycation",
        status: "PUBLISHED",
        visibility: "ASSIGNABLE",
        deletedAt: null,
        category: "Travel",
        countries: ["AE"],
        defaultCurrency: "USD",
        merchant: {
          id: "m1",
          displayName: "Klook",
          logoUrl: "https://cdn.example/klook.png",
          website: "https://www.klook.com",
        },
      },
      campaignSource: {
        supportsLink: true,
        supportsCoupon: false,
        supplierCampaign: {
          deepLinkingEnabled: true,
          campaignType: "CPS",
          pricingModel: "CPS",
          campaignStatus: "ACTIVE",
          campaignLogoUrl: null,
          destinationUrl: "https://www.klook.com",
        },
      },
      trackingLinks: [
        {
          isPrimary: true,
          status: "ACTIVE",
          mboTrackingUrl: "https://go.mbo.example/r/x/y",
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
    };
  }

  it("hides unpublished assignments by default", () => {
    const service = new PartnerCampaignService({ visibility });
    const draft = assignment({ published: false, status: "ACTIVE" });
    assert.equal(service.projectAssignment(draft, { status: "ACTIVE", deletedAt: null }), null);
  });

  it("includes published assignments with brand + client commission", () => {
    const service = new PartnerCampaignService({ visibility });
    const dto = service.projectAssignment(assignment(), { status: "ACTIVE", deletedAt: null });
    assert.ok(dto);
    assert.equal(dto.brand.name, "Klook");
    assert.equal(dto.brand.logoUrl, "https://cdn.example/klook.png");
    assert.equal(dto.brandName, "Klook");
    assert.equal(dto.campaignName, "Staycation");
    assert.equal(dto.commission.clientSharePercent, 70);
    assert.equal(dto.commission.isDisplayOnly, true);
    assert.equal(dto.channels.link, true);
    assert.equal(dto.channels.deeplink, true);
    assert.equal(dto.tracking.url, "https://go.mbo.example/r/x/y");
    assert.equal(JSON.stringify(dto).includes("supplier.example"), false);
    assert.equal(JSON.stringify(dto).includes("mboCommission"), false);
  });

  it("defaults list filters to published=true", async () => {
    const findManyForPartner = mock.fn(async (filters) => {
      assert.equal(filters.clientId, "client-a");
      assert.equal(filters.published, true);
      return { rows: [], total: 0 };
    });
    const service = new PartnerCampaignService({
      clientRepo: {
        findById: mock.fn(async () => ({
          id: "client-a",
          name: "A",
          slug: "a",
          status: "ACTIVE",
          deletedAt: null,
        })),
      },
      assignmentRepo: { findManyForPartner },
      visibility,
    });
    await service.listCampaigns("client-a", { page: 1, pageSize: 20 });
    assert.equal(findManyForPartner.mock.calls.length, 1);
  });

  it("rejects getCampaign for unpublished assignment", async () => {
    const service = new PartnerCampaignService({
      clientRepo: {
        findById: mock.fn(async () => ({
          id: "client-a",
          status: "ACTIVE",
          deletedAt: null,
          name: "A",
          slug: "a",
        })),
      },
      assignmentRepo: {
        findPartnerCampaignForClient: mock.fn(async () =>
          assignment({ published: false, status: "ASSIGNED" }),
        ),
      },
      visibility,
    });
    await assert.rejects(
      () => service.getCampaign("client-a", "a1"),
      (error) => error.statusCode === 404,
    );
  });
});

describe("Partner DTO brand nested projection", () => {
  it("exposes nested brand without inventing logos", () => {
    const dto = toPartnerCampaignDto({
      assignmentId: "a1",
      assignmentStatus: "ACTIVE",
      published: true,
      createdAt: new Date().toISOString(),
      campaign: {
        id: "cc1",
        merchantId: "m1",
        brand: "Acme",
        brandLogoUrl: null,
        brandWebsiteUrl: null,
        displayName: "Acme Offer",
        countries: [],
        status: "PUBLISHED",
        campaignTypeRaw: "CPS",
      },
      sourceCapabilities: { supportsLink: true, supportsCoupon: false, supportsDeeplink: false },
      tracking: null,
      commercial: { clientSharePercent: 50, commissionType: "PERCENT", currency: "USD" },
      coupon: null,
    });
    assert.deepEqual(dto.brand, {
      id: "m1",
      name: "Acme",
      logoUrl: null,
      websiteUrl: null,
    });
    assert.equal(dto.brandLogoUrl, null);
  });
});
