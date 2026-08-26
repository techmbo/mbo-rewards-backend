/**
 * Client portal / partner campaign API — isolation, 06C contract, security.
 */
import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import {
  toPartnerCampaignDto,
  buildClientCommission,
  resolveClientFacingCurrency,
  mapDiscountType,
} from "../src/modules/client/dto/partnerCampaign.dto.js";
import { PartnerCampaignService } from "../src/modules/client/services/partnerCampaign.service.js";
import { ClientVisibilityService } from "../src/modules/client/services/visibility.service.js";
import { partnerListCampaignsHandler } from "../src/controllers/partnerCampaigns.controller.js";
import { clientListCampaignsAliasHandler } from "../src/controllers/clientReporting.controller.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

const FORBIDDEN_SUBSTRINGS = [
  "supplier_campaign_id",
  "supplierCampaignId",
  "supplier_tracking_url",
  "supplierTrackingUrl",
  "supplierReceivable",
  "mboMargin",
  "mboCommission",
  "raw_payload",
  "rawPayload",
  "rawData",
  "sourceAccountLabel",
  "SUP-SECRET",
  "supplier.example",
];

function buildAssignment({
  id = "a1",
  clientId = "client-a",
  campaignId = "cc1",
  brand = "Ubuy",
  logoUrl = "https://cdn.example/ubuy.png",
  website = "https://www.ubuy.com",
  status = "ACTIVE",
  published = true,
  countries = ["AE", "SA"],
  trackingUrl = "https://go.mbo.example/r/a-ubuy/7HF82KLM",
  couponCode = "SAVE10",
  clientShare = 70,
  gross = 100,
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
    canonicalCampaign: {
      id: campaignId,
      merchantId: "m1",
      displayName: `${brand} Global`,
      description: null,
      status: "PUBLISHED",
      visibility: "ASSIGNABLE",
      deletedAt: null,
      category: "Marketplace",
      countries,
      defaultCurrency: "USD",
      merchant: {
        id: "m1",
        displayName: brand,
        logoUrl,
        website,
      },
    },
    campaignSource: {
      supportsLink: true,
      supportsCoupon: Boolean(couponCode),
      supplierCampaign: {
        campaignName: `${brand} Raw`,
        campaignDescription: "Shop and earn rewards.",
        deepLinkingEnabled: false,
        campaignType: "CPS",
        pricingModel: "CPS",
        campaignStatus: "ACTIVE",
        campaignLogoUrl: "https://supplier.example/logo.png",
        destinationUrl: "https://supplier.example/dest",
        merchantNameRaw: brand,
        countryCodes: countries,
      },
    },
    trackingLinks: trackingUrl
      ? [
          {
            isPrimary: true,
            status: "ACTIVE",
            slug: "a-ubuy",
            subId: "7HF82KLM",
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
            supplierCouponCode: "SUP-SECRET",
            discountPercentage: "10",
            validFrom: new Date("2026-01-01"),
            validUntil: new Date("2026-12-31"),
          },
        ]
      : [],
    commissionRules: [
      {
        status: "EFFECTIVE",
        grossCommission: String(gross),
        clientCommission: String(clientShare),
        mboCommission: String(gross - clientShare),
        commissionType: "PERCENT",
        currency: "USD",
        displayLabel: null,
        displayRangeMin: null,
        displayRangeMax: null,
        orderValuePercent: null,
        fixedAmount: null,
        manualAmount: null,
        manualApproved: false,
      },
    ],
  };
}

describe("Partner route mounting", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("GET /partner/v1/campaigns is mounted (401 without auth, not 404)", async () => {
    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/partner/v1/campaigns?pageSize=100",
    });
    assert.notEqual(status, 404);
    assert.equal(status, 401);
    assert.equal(json?.ok, false);
  });

  it("GET /v1/client/campaigns canonical is mounted (401 without auth, not 404)", async () => {
    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/v1/client/campaigns?pageSize=100",
    });
    assert.notEqual(status, 404);
    assert.equal(status, 401);
    assert.equal(json?.ok, false);
  });
});

describe("Partner list handler tenant gate", () => {
  function mockRes() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  it("rejects mismatched ?clientId= with authenticated tenant", async () => {
    const req = { partnerClientId: "client-a", query: { clientId: "client-b", pageSize: "100" } };
    const res = mockRes();
    await partnerListCampaignsHandler(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });

  it("canonical /v1/client handler rejects mismatched ?clientId=", async () => {
    const req = { partnerClientId: "client-a", query: { clientId: "client-b", pageSize: "100" } };
    const res = mockRes();
    await clientListCampaignsAliasHandler(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });

  it("rejects missing partner credential", async () => {
    const req = { partnerClientId: null, query: { pageSize: "100" } };
    const res = mockRes();
    await partnerListCampaignsHandler(req, res, () => {});
    assert.equal(res.statusCode, 401);
  });
});

describe("Client campaign tenant isolation", () => {
  it("Client A sees A1+A2 only; Client B sees B1 only; ?clientId ignored", async () => {
    const clientA = { id: "client-a", name: "A", slug: "a", status: "ACTIVE", deletedAt: null, currency: null };
    const clientB = { id: "client-b", name: "B", slug: "b", status: "ACTIVE", deletedAt: null, currency: null };
    const a1 = buildAssignment({ id: "a1", clientId: "client-a", brand: "BrandA1", trackingUrl: "https://go.mbo.example/r/a1/t" });
    const a2 = buildAssignment({
      id: "a2",
      clientId: "client-a",
      campaignId: "cc2",
      brand: "BrandA2",
      trackingUrl: "https://go.mbo.example/r/a2/t",
      couponCode: null,
    });
    const b1 = buildAssignment({
      id: "b1",
      clientId: "client-b",
      campaignId: "cc1",
      brand: "BrandB1",
      trackingUrl: "https://go.mbo.example/r/b1/t",
      couponCode: "BONLY",
    });

    const byClient = {
      "client-a": [a1, a2],
      "client-b": [b1],
    };

    function makeService(client) {
      return new PartnerCampaignService({
        clientRepo: {
          findById: mock.fn(async (id) => (id === client.id ? client : null)),
        },
        assignmentRepo: {
          findManyForPartner: mock.fn(async (filters) => {
            assert.equal(filters.clientId, client.id);
            return { rows: byClient[filters.clientId] || [], total: (byClient[filters.clientId] || []).length };
          }),
        },
      });
    }

    const resultA = await makeService(clientA).listCampaigns("client-a", { pageSize: 100 });
    assert.deepEqual(
      resultA.campaigns.map((c) => c.assignmentId).sort(),
      ["a1", "a2"],
    );
    assert.ok(!resultA.campaigns.some((c) => c.assignmentId === "b1"));

    const resultB = await makeService(clientB).listCampaigns("client-b", { pageSize: 100 });
    assert.deepEqual(
      resultB.campaigns.map((c) => c.assignmentId),
      ["b1"],
    );
    assert.ok(!resultB.campaigns.some((c) => c.assignmentId === "a1" || c.assignmentId === "a2"));
  });
});

describe("Client campaign security leakage", () => {
  it("DTO JSON contains none of the forbidden supplier/MBO keys", () => {
    const visibility = new ClientVisibilityService();
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(buildAssignment()));
    const blob = JSON.stringify(dto);
    for (const needle of FORBIDDEN_SUBSTRINGS) {
      assert.equal(blob.includes(needle), false, `leaked: ${needle}`);
    }
    assert.equal(dto.supplierCampaignId, undefined);
    assert.equal(dto.tracking?.supplierTrackingUrl, undefined);
    assert.equal(dto.commission?.mboCommission, undefined);
    assert.equal(dto.commission?.grossCommission, undefined);
  });
});

describe("Brand logo projection", () => {
  const visibility = new ClientVisibilityService();

  it("returns merchant logo when present", () => {
    const dto = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(
        buildAssignment({ logoUrl: "https://cdn.example/real.png" }),
      ),
    );
    assert.equal(dto.brandLogoUrl, "https://cdn.example/real.png");
    assert.equal(dto.brand.logoUrl, "https://cdn.example/real.png");
  });

  it("returns null when merchant has no logo (does not invent)", () => {
    const assignment = buildAssignment({ logoUrl: null });
    assignment.canonicalCampaign.merchant.logoUrl = null;
    assignment.campaignSource.supplierCampaign.campaignLogoUrl = null;
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(assignment));
    assert.equal(dto.brandLogoUrl, null);
  });

  it("rejects invalid supplier logo URL", () => {
    const assignment = buildAssignment({ logoUrl: null });
    assignment.canonicalCampaign.merchant.logoUrl = null;
    assignment.campaignSource.supplierCampaign.campaignLogoUrl = "not-a-url";
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(assignment));
    assert.equal(dto.brandLogoUrl, null);
  });
});

describe("Tracking link isolation", () => {
  it("same campaign yields different MBO links per client assignment", async () => {
    const visibility = new ClientVisibilityService();
    const a = buildAssignment({
      id: "a1",
      clientId: "client-a",
      campaignId: "shared",
      trackingUrl: "https://go.mbo.example/r/client-a/token",
    });
    const b = buildAssignment({
      id: "b1",
      clientId: "client-b",
      campaignId: "shared",
      trackingUrl: "https://go.mbo.example/r/client-b/token",
      couponCode: null,
    });

    const dtoA = toPartnerCampaignDto(visibility.projectVisibleCampaign(a));
    const dtoB = toPartnerCampaignDto(visibility.projectVisibleCampaign(b));
    assert.equal(dtoA.link, "https://go.mbo.example/r/client-a/token");
    assert.equal(dtoB.link, "https://go.mbo.example/r/client-b/token");
    assert.notEqual(dtoA.link, dtoB.link);
    assert.equal(JSON.stringify(dtoA).includes("supplier.example"), false);
    assert.equal(JSON.stringify(dtoB).includes("supplier.example"), false);
  });
});

describe("Client commission projection", () => {
  it("returns client share from ClientCommissionRule, not supplier 5% / MBO 30%", () => {
    const visibility = new ClientVisibilityService();
    // gross=100, client=70 → 70% share (display). Supplier headline 5% must not appear.
    const assignment = buildAssignment({ clientShare: 70, gross: 100 });
    assignment.commissionRules[0].mboCommission = "30";
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(assignment));
    assert.equal(dto.commission.clientSharePercent, 70);
    assert.equal(dto.commission.isDisplayOnly, true);
    assert.match(dto.commission.commissionDisplay, /70%/);
    assert.equal(JSON.stringify(dto).includes('"mboCommission"'), false);
    assert.equal(JSON.stringify(dto).includes("5%"), false);
  });

  it("formats order-value percent and fixed amount displays", () => {
    assert.equal(
      buildClientCommission({
        orderValuePercent: 3.5,
        commissionType: "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE",
      }).commissionDisplay,
      "3.5%",
    );
    assert.equal(
      buildClientCommission({
        fixedAmount: 5,
        currency: "USD",
        commissionType: "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER",
      }).commissionDisplay,
      "USD 5 per confirmed order",
    );
    assert.equal(
      buildClientCommission({
        displayRangeMax: 5,
        commissionType: "DISPLAY_RANGE_WITH_ACTUAL_SPLIT",
      }).commissionDisplay,
      "Up to 5%",
    );
  });
});

describe("Coupon isolation", () => {
  it("returns only the client's assigned coupon code", () => {
    const visibility = new ClientVisibilityService();
    const dtoA = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(buildAssignment({ couponCode: "CODE-A" })),
    );
    const dtoB = toPartnerCampaignDto(
      visibility.projectVisibleCampaign(
        buildAssignment({ id: "b1", clientId: "client-b", couponCode: null }),
      ),
    );
    assert.equal(dtoA.couponCode, "CODE-A");
    assert.equal(dtoB.couponCode, null);
    assert.equal(JSON.stringify(dtoA).includes("SUP-SECRET"), false);
  });
});

describe("Currency regional rule", () => {
  it("India → INR; non-India → USD; unknown → null; override → contract", () => {
    assert.equal(resolveClientFacingCurrency({ primaryCountry: "IN" }), "INR");
    assert.equal(resolveClientFacingCurrency({ primaryCountry: "AE" }), "USD");
    assert.equal(resolveClientFacingCurrency({ primaryCountry: null }), null);
    assert.equal(
      resolveClientFacingCurrency({ primaryCountry: "AE", clientCurrency: "INR" }),
      "INR",
    );

    const visibility = new ClientVisibilityService();
    const india = buildAssignment({ countries: ["IN"] });
    const dtoIn = toPartnerCampaignDto(visibility.projectVisibleCampaign(india), {
      client: { currency: null },
    });
    assert.equal(dtoIn.currency, "INR");

    const ae = buildAssignment({ countries: ["AE", "SA"] });
    const dtoAe = toPartnerCampaignDto(visibility.projectVisibleCampaign(ae), {
      client: { currency: null },
    });
    assert.equal(dtoAe.currency, "USD");
  });
});

describe("06C campaignType is channel, not commercial model", () => {
  it("maps CPS commercial + coupon+link → campaignType COUPON_LINK", () => {
    const visibility = new ClientVisibilityService();
    const dto = toPartnerCampaignDto(visibility.projectVisibleCampaign(buildAssignment()));
    assert.equal(dto.campaignType, "COUPON_LINK");
    assert.equal(dto.commercialModel, "CPS");
    assert.equal(dto.channelType, "COUPON_LINK");
  });

  it("mapDiscountType never invents percent from fixed text", () => {
    assert.equal(mapDiscountType({ discountPercent: null, discountRaw: "₹100 off" }), "FIXED_AMOUNT");
    assert.equal(mapDiscountType({ discountPercent: 10 }), "PERCENT");
    assert.equal(mapDiscountType({ discountRaw: "Free shipping" }), "FREE_SHIPPING");
  });
});

describe("Visibility hides draft / revoked / archived", () => {
  it("projectAssignment hides unpublished and revoked", () => {
    const service = new PartnerCampaignService();
    const client = { status: "ACTIVE", deletedAt: null };
    assert.equal(
      service.projectAssignment(buildAssignment({ published: false }), client),
      null,
    );
    assert.equal(
      service.projectAssignment(buildAssignment({ status: "REVOKED" }), client),
      null,
    );
  });
});
