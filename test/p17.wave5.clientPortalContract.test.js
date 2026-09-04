/**
 * P1.7 Wave 5 — Client Portal / 06A–06E contract & UX rebuild regression.
 * Portal campaigns must consume PartnerCampaignService / GET /api/v1/client/campaigns.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  toPartnerCampaignDto,
  derivePartnerAssignmentStatus,
  resolveDiscountDisplay,
} from "../src/modules/client/dto/partnerCampaign.dto.js";
import { CLIENT_CAMPAIGN_FORBIDDEN_KEYS } from "../src/modules/client/dto/clientCampaignContract.06c.js";
import { PartnerCampaignService } from "../src/modules/client/services/partnerCampaign.service.js";
import { ClientVisibilityService } from "../src/modules/client/services/visibility.service.js";
import { PortalDashboardService } from "../src/modules/client/services/portalDashboard.service.js";
import { CLIENT_API, assertBackendRegisters } from "./helpers/clientApiRoutes.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

const FORBIDDEN = [
  ...CLIENT_CAMPAIGN_FORBIDDEN_KEYS,
  "supplier.example",
  "SUP-SECRET",
];

function buildAssignment({
  id = "a1",
  clientId = "client-a",
  published = true,
  status = "ACTIVE",
  trackingUrl = "https://go.mbo.example/r/a1/t",
  couponCode = "SAVE10",
  commercialStatus = "EFFECTIVE",
  logoUrl = "https://cdn.example/brand.png",
  website = "https://www.brand.example",
  destinationUrl = "https://supplier.example/dest",
  offer = null,
  discountPercentage = null,
} = {}) {
  return {
    id,
    clientId,
    status,
    published,
    channel: "WEB",
    startDate: new Date("2026-01-01"),
    endDate: null,
    createdAt: new Date(),
    commissionRules: commercialStatus
      ? [
          {
            status: commercialStatus,
            clientSharePercent: 70,
            clientCommission: "70",
            grossCommission: "100",
            mboCommission: "30",
            currency: "USD",
            commissionType: "PERCENT",
            displayLabel: null,
            displayRangeMin: null,
            displayRangeMax: null,
            orderValuePercent: null,
            fixedAmount: null,
            manualAmount: null,
            manualApproved: false,
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
            validFrom: new Date("2026-01-01"),
            validUntil: new Date("2026-12-31"),
          },
        ]
      : [],
    trackingLinks: trackingUrl
      ? [
          {
            isPrimary: true,
            status: "ACTIVE",
            slug: "a1",
            subId: "x",
            mboTrackingUrl: trackingUrl,
            supplierTrackingUrl: "https://supplier.example/track",
          },
        ]
      : [],
    canonicalCampaign: {
      id: "cc1",
      merchantId: "m1",
      displayName: "Brand Campaign",
      description: "Desc",
      status: "PUBLISHED",
      visibility: "ASSIGNABLE",
      deletedAt: null,
      category: "Travel",
      secondaryCategory: null,
      countries: ["AE"],
      defaultCurrency: "USD",
      offer,
      merchant: {
        id: "m1",
        displayName: "Brand",
        logoUrl,
        website,
      },
    },
    campaignSource: {
      supportsLink: true,
      supportsCoupon: Boolean(couponCode),
      supportsDeeplink: false,
      supplierCampaign: {
        campaignName: "Raw",
        campaignDescription: "Desc",
        deepLinkingEnabled: false,
        campaignType: "CPS",
        pricingModel: "CPS",
        campaignStatus: "ACTIVE",
        campaignLogoUrl: null,
        destinationUrl,
        merchantNameRaw: "Brand",
        countryCodes: ["AE"],
      },
    },
  };
}

describe("P1.7 Wave 5 — portal source of truth", () => {
  it("CLIENT_API.campaigns points at canonical /v1/client/campaigns", () => {
    assert.equal(CLIENT_API.campaigns, "/v1/client/campaigns");
    assert.equal(assertBackendRegisters(CLIENT_API.campaigns), true);
  });

  it("portal overview campaign KPIs use PartnerCampaignService population", async () => {
    const client = {
      id: "client-a",
      name: "Hello1",
      slug: "hello1",
      status: "ACTIVE",
      deletedAt: null,
      currency: "USD",
      clientSharePercent: 70,
    };
    const live = buildAssignment({ id: "live1" });
    const partner = new PartnerCampaignService({
      clientRepo: { findById: mock.fn(async () => client) },
      assignmentRepo: {
        findManyForPartner: mock.fn(async () => ({ rows: [live], total: 1 })),
      },
    });
    const portal = new PortalDashboardService({
      partnerCampaigns: partner,
      clientReporting: {
        listPerformance: mock.fn(async () => ({
          rows: [],
          items: [],
          kpis: { linkClicks: null },
          dataAvailable: false,
          brands: [],
        })),
      },
      prisma: {
        clientBankAccount: { findUnique: mock.fn(async () => null) },
        clientCampaignAssignment: { findMany: mock.fn(async () => []) },
        conversion: { findMany: mock.fn(async () => []) },
        click: { groupBy: mock.fn(async () => []), findMany: mock.fn(async () => []) },
        clientWithdrawal: { findMany: mock.fn(async () => []) },
      },
      financeConsumer: {
        getMode: () => "LEGACY",
        compareClientEarnings: mock.fn(async () => ({
          finance: { net: 0 },
          legacy: {},
          comparison: { status: "MATCH" },
        })),
        resolveDisplayCommission: ({ legacyApproved, legacyPending }) => ({
          approvedCommission: legacyApproved,
          pendingCommission: legacyPending,
          source: "legacy",
          authoritative: true,
        }),
      },
    });

    const overview = await portal.getOverview("client-a");
    const list = await partner.listCampaigns("client-a", { pageSize: 100 });
    assert.equal(overview.kpis.campaignPopulation, "client_api_visible");
    assert.equal(overview.kpis.totalCampaigns, list.campaigns.length);
    assert.equal(overview.kpis.activeCampaigns, list.campaigns.length);
    assert.equal(list.campaigns[0].assignmentStatus, "CLIENT_VISIBLE");
    assert.equal(list.campaigns[0].displayStatus, "Live");
  });
});

describe("P1.7 Wave 5 — DTO contract for portal", () => {
  const visibility = new ClientVisibilityService();

  it("separates commercialModel from campaignType/channel", () => {
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(buildAssignment()));
    assert.equal(dto.commercialModel, "CPS");
    assert.ok(["LINK", "COUPON", "COUPON_LINK", "DEEPLINK"].includes(dto.campaignType));
    assert.notEqual(dto.commercialModel, dto.campaignType);
  });

  it("offer does not fall back to campaign name", () => {
    assert.equal(resolveDiscountDisplay({ campaignName: "Staycation", offer: "Staycation" }), null);
    const dto = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(buildAssignment({ offer: null, discountPercentage: null, couponCode: null })),
    );
    assert.equal(dto.discountDisplay, null);
    assert.notEqual(dto.discountDisplay, dto.campaignName);
  });

  it("brand website prefers Merchant.website; landing destinationUrl is fallback; never trackingUrl", () => {
    const assignment = buildAssignment({
      website: null,
      destinationUrl: "https://supplier.example/dest",
    });
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(assignment));
    assert.equal(dto.brandWebsiteUrl, "https://supplier.example/dest");

    const withMaster = buildAssignment({
      website: "https://brand-master.example",
      destinationUrl: "https://supplier.example/dest",
    });
    const dtoMaster = toPartnerCampaignDto(visibility.projectVisibleCampaign(withMaster));
    assert.equal(dtoMaster.brandWebsiteUrl, "https://brand-master.example");
  });

  it("missing logo stays null (initials are FE-only)", () => {
    const assignment = buildAssignment({ logoUrl: null });
    assignment.campaignSource.supplierCampaign.campaignLogoUrl = null;
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(assignment));
    assert.equal(dto.brandLogoUrl, null);
  });

  it("CLIENT_VISIBLE is not inferred from published alone", () => {
    const projected = visibility.projectVisibleCampaign(
      buildAssignment({ published: true, trackingUrl: null, couponCode: null, commercialStatus: "DRAFT" }),
    );
    // Without tracking/coupon, project may still produce status — derive must not claim CLIENT_VISIBLE
    // solely from published when tracking/coupon missing.
    const status = derivePartnerAssignmentStatus({
      ...projected,
      published: true,
      tracking: null,
      coupon: null,
      commercial: { status: "DRAFT" },
      assignmentStatus: "ACTIVE",
    });
    assert.notEqual(status, "CLIENT_VISIBLE");
  });

  it("displayStatus Live aligns with CLIENT_VISIBLE derived status", () => {
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(buildAssignment()));
    assert.equal(dto.assignmentStatus, "CLIENT_VISIBLE");
    assert.equal(dto.displayStatus, "Live");
  });

  it("tracking exposes MBO URL only; commission has no supplier/MBO internals", () => {
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(buildAssignment()));
    assert.equal(dto.link, "https://go.mbo.example/r/a1/t");
    assert.equal(dto.tracking?.url, "https://go.mbo.example/r/a1/t");
    const blob = JSON.stringify(dto);
    for (const key of FORBIDDEN) {
      assert.equal(blob.includes(key), false, `leaked: ${key}`);
    }
  });

  it("coupon exposes assigned code only", () => {
    const withCode = toPartnerCampaignDto(visibility.projectVisibleCampaign(buildAssignment({ couponCode: "SAVE10" })));
    assert.equal(withCode.couponCode, "SAVE10");
    const without = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(buildAssignment({ couponCode: null })),
    );
    assert.equal(without.couponCode, null);
  });
});

describe("P1.7 Wave 5 — HTTP auth gates (preserve P0)", () => {
  let server;
  it("boots test server", async () => {
    server = await startTestServer();
  });

  it("missing credentials → 401 on client campaigns", async () => {
    const { status } = await apiRequest(server.baseUrl, { path: "/v1/client/campaigns?pageSize=10" });
    assert.equal(status, 401);
  });

  it("portal campaigns alias also requires auth (401, not 404)", async () => {
    const { status } = await apiRequest(server.baseUrl, { path: "/portal/v1/campaigns?pageSize=10" });
    assert.equal(status, 401);
  });

  it("teardown", async () => {
    await server.close();
  });
});
