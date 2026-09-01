/**
 * P1.7 Wave 2 — allocation list filter / DTO contract (no eligibility rewrite).
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { ClientAllocationService } from "../src/modules/client/services/clientAllocation.service.js";

function makeService({ client, items, sourcesByCampaign = {} }) {
  return new ClientAllocationService({
    clientRepo: {
      findById: mock.fn(async () => client),
    },
    adminContract: {
      listCampaigns: mock.fn(async () => ({
        items,
        total: items.length,
      })),
    },
    assignmentService: {
      loadCatalogSources: mock.fn(async (id) => sourcesByCampaign[id] || []),
    },
    eligibility: {
      evaluate: mock.fn(({ catalogCampaign }) => {
        if (catalogCampaign.id === "blocked") {
          return {
            ok: false,
            eligibilityStatus: "NOT_ELIGIBLE",
            reasons: ["currency_mismatch"],
            reasonLabels: ["Currency mismatch"],
            eligibleSourceId: null,
          };
        }
        if (catalogCampaign.id === "review") {
          return {
            ok: false,
            eligibilityStatus: "NEEDS_REVIEW",
            reasons: ["relationship_needs_review"],
            reasonLabels: ["Relationship needs review"],
            eligibleSourceId: null,
          };
        }
        return {
          ok: true,
          eligibilityStatus: "ELIGIBLE",
          reasons: [],
          reasonLabels: [],
          eligibleSourceId: "src1",
        };
      }),
    },
    prisma: {
      clientCampaignAssignment: {
        findMany: mock.fn(async () => [
          {
            id: "asg1",
            canonicalCampaignId: "assigned",
            status: "ASSIGNED",
            published: false,
            campaignSourceId: "src1",
          },
        ]),
      },
    },
  });
}

const client = {
  id: "c1",
  name: "Hello1",
  status: "ACTIVE",
  country: "IN",
  currency: "INR",
  commercialModel: "OFFERS_PLUS_COMMISSION",
  clientSharePercent: 70,
};

function campaign(id, overrides = {}) {
  return {
    id,
    brandName: "Klook",
    brandLogoLink: null,
    brandWebsiteLink: null,
    campaignName: `${id} campaign`,
    campaignDescription: null,
    networkSource: "OPTIMISE",
    campaignType: "CPS",
    country: ["IN"],
    currency: "INR",
    campaignCommission: "5%",
    commissionRuleCount: 1,
    campaignStatus: "ACTIVE",
    relationshipStatus: "JOINED",
    linkSupport: true,
    couponSupport: false,
    deeplinkSupport: false,
    ...overrides,
  };
}

describe("P1.7 Wave 2 allocation list", () => {
  it("separates commercialModel from channelType on DTO", async () => {
    const service = makeService({
      client,
      items: [campaign("ok", { campaignType: "CPS", linkSupport: true, couponSupport: true })],
      sourcesByCampaign: {
        ok: [
          {
            id: "src1",
            supportsLink: true,
            supportsCoupon: true,
            supportsDeeplink: false,
            supplierCampaign: {
              campaignType: "CPS",
              pricingModel: "CPS",
              coupons: [{ couponCode: "SAVE" }],
            },
          },
        ],
      },
    });
    const result = await service.listForClient("c1", {});
    const row = result.items.find((r) => r.id === "ok");
    assert.ok(row);
    assert.equal(row.commercialModel, "CPS");
    assert.equal(row.campaignType, "CPS");
    assert.equal(row.channelType, "COUPON_LINK");
    assert.notEqual(row.channelType, row.commercialModel);
  });

  it("exposes relationship and eligibility reason; blocked is not assignable", async () => {
    const service = makeService({
      client,
      items: [
        campaign("blocked", { relationshipStatus: "UNKNOWN" }),
        campaign("ok"),
      ],
      sourcesByCampaign: {
        ok: [
          {
            id: "src1",
            supportsLink: true,
            supplierCampaign: { campaignType: "CPS", coupons: [] },
          },
        ],
      },
    });
    const result = await service.listForClient("c1", {});
    const blocked = result.items.find((r) => r.id === "blocked");
    assert.equal(blocked.isAssignable, false);
    assert.equal(blocked.issue, "Currency mismatch");
    assert.equal(blocked.relationshipDisplayStatus, "NEEDS_REVIEW");
    assert.equal(blocked.relationshipLabel, "Needs review");
    const ok = result.items.find((r) => r.id === "ok");
    assert.equal(ok.isAssignable, true);
  });

  it("already assigned is not re-assignable", async () => {
    const service = makeService({
      client,
      items: [campaign("assigned")],
      sourcesByCampaign: {
        assigned: [
          {
            id: "src1",
            supportsLink: true,
            supplierCampaign: { campaignType: "CPS", coupons: [] },
          },
        ],
      },
    });
    const result = await service.listForClient("c1", {});
    const row = result.items[0];
    assert.equal(row.allocationState, "ASSIGNED");
    assert.equal(row.isAssignable, false);
    assert.equal(row.assignmentId, "asg1");
  });

  it("filters by commercialModel, channel, currency, eligibility via query", async () => {
    const service = makeService({
      client,
      items: [
        campaign("cps-link", { campaignType: "CPS", currency: "INR" }),
        campaign("cpa", { campaignType: "CPA", currency: "USD" }),
      ],
      sourcesByCampaign: {
        "cps-link": [
          {
            id: "src1",
            supportsLink: true,
            supportsCoupon: false,
            supplierCampaign: { campaignType: "CPS", coupons: [] },
          },
        ],
        cpa: [
          {
            id: "src2",
            supportsLink: true,
            supportsCoupon: true,
            supplierCampaign: {
              campaignType: "CPA",
              coupons: [{ couponCode: "X" }],
            },
          },
        ],
      },
    });

    // commercialModel is passed through to adminContract; enrichment still returns matching rows
    const byChannel = await service.listForClient("c1", { channel: "COUPON" });
    assert.ok(byChannel.items.every((r) => r.channels.coupon === true));

    const byCurrency = await service.listForClient("c1", { currency: "INR" });
    assert.ok(byCurrency.items.every((r) => String(r.currency).toUpperCase() === "INR"));

    const eligible = await service.listForClient("c1", { eligibility: "ELIGIBLE" });
    assert.ok(eligible.items.every((r) => r.isAssignable === true));
  });

  it("does not invent commission when backend has none", async () => {
    const service = makeService({
      client,
      items: [campaign("ok", { campaignCommission: null, commissionRuleCount: 0 })],
      sourcesByCampaign: {
        ok: [
          {
            id: "src1",
            supportsLink: true,
            supplierCampaign: { campaignType: "CPS", coupons: [] },
          },
        ],
      },
    });
    const result = await service.listForClient("c1", {});
    assert.equal(result.items[0].campaignCommission, null);
  });

  it("serialized row has no supplierReceivable / rawPayload", async () => {
    const service = makeService({
      client,
      items: [campaign("ok")],
      sourcesByCampaign: {
        ok: [
          {
            id: "src1",
            supportsLink: true,
            supplierCampaign: { campaignType: "CPS", coupons: [], rawPayload: { secret: 1 } },
          },
        ],
      },
    });
    const result = await service.listForClient("c1", {});
    const blob = JSON.stringify(result.items[0]);
    assert.equal(blob.includes("supplierReceivable"), false);
    assert.equal(blob.includes("rawPayload"), false);
    assert.equal(result.items[0].rawPayload, undefined);
  });

  it("assigned tab uses assignment-first pagination (not catalog page window)", async () => {
    const assignedOnly = campaign("assigned-deep", { campaignType: "CPS", linkSupport: true });
    const service = new ClientAllocationService({
      clientRepo: { findById: mock.fn(async () => client) },
      adminContract: {
        listCampaigns: mock.fn(async (query) => {
          if (query.ids) {
            return {
              items: query.ids.includes("assigned-deep") ? [assignedOnly] : [],
              total: query.ids.length,
            };
          }
          return { items: [], total: 745 };
        }),
      },
      assignmentService: {
        loadCatalogSources: mock.fn(async (id) =>
          id === "assigned-deep"
            ? [
                {
                  id: "src-deep",
                  supportsLink: true,
                  supplierCampaign: {
                    campaignType: "CPS",
                    coupons: [],
                  },
                },
              ]
            : [],
        ),
      },
      eligibility: {
        evaluate: mock.fn(() => ({
          ok: true,
          eligibilityStatus: "ELIGIBLE",
          reasons: [],
          reasonLabels: [],
          eligibleSourceId: "src-deep",
        })),
      },
      prisma: {
        clientCampaignAssignment: {
          findMany: mock.fn(async (args) => {
            if (args?.select?.trackingLinks) {
              return [
                {
                  id: "asg-deep",
                  canonicalCampaignId: "assigned-deep",
                  status: "ACTIVE",
                  published: true,
                  campaignSourceId: "src-deep",
                  channel: "LINK",
                  trackingLinks: [{ mboTrackingUrl: "http://localhost/r/test", isPrimary: true }],
                  couponAssignments: [],
                },
              ];
            }
            return [];
          }),
          count: mock.fn(async () => 1),
        },
      },
    });

    const result = await service.listForClient("c1", { assignmentStatus: "ASSIGNED", page: 1, pageSize: 25 });
    assert.equal(result.total, 1);
    assert.equal(result.summary.totalAssigned, 1);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, "assigned-deep");
    assert.equal(result.items[0].allocationState, "ASSIGNED");
    assert.equal(result.items[0].channelType, "LINK");
  });
});
