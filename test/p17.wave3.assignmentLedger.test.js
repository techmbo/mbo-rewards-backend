/**
 * P1.7 Wave 3 — assignment list DTO enrichment (staff ledger).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toClientCampaignAssignmentDto } from "../src/modules/client/dto/client.dto.js";

function buildRecord(overrides = {}) {
  return {
    id: "asg1",
    clientId: "c1",
    canonicalCampaignId: "cc1",
    campaignSourceId: "src1",
    status: "ASSIGNED",
    published: false,
    publishedAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    channel: "WEB",
    notes: null,
    client: {
      id: "c1",
      name: "Hello1",
      slug: "hello-1",
      status: "ACTIVE",
      commercialModel: "OFFERS_PLUS_COMMISSION",
      clientSharePercent: 70,
      country: "IN",
      currency: "INR",
    },
    canonicalCampaign: {
      id: "cc1",
      displayName: "Staycation",
      status: "PUBLISHED",
      visibility: "ASSIGNABLE",
      merchant: {
        id: "m1",
        displayName: "Klook",
        logoUrl: null,
        website: "https://www.klook.com",
      },
    },
    campaignSource: {
      id: "src1",
      supportsLink: true,
      supportsCoupon: false,
      relationshipStatus: "JOINED",
      supplierCampaign: {
        id: "sc1",
        supplier: "OPTIMISE",
        campaignType: "CPS",
        pricingModel: "CPS",
        campaignLogoUrl: null,
        deepLinkingEnabled: false,
      },
    },
    trackingLinks: [],
    couponAssignments: [],
    commissionRules: [],
    ...overrides,
  };
}

describe("P1.7 Wave 3 assignment ledger DTO", () => {
  it("separates commercialModel from channelType and derives assignmentStatus", () => {
    const dto = toClientCampaignAssignmentDto(buildRecord(), { includeStaffCommercial: true });
    assert.equal(dto.commercialModel, "CPS");
    assert.equal(dto.channelType, "LINK");
    assert.notEqual(dto.commercialModel, dto.channelType);
    assert.equal(dto.assignmentStatus, "ASSIGNED");
    assert.equal(dto.published, false);
    assert.equal(dto.brandName, "Klook");
    assert.equal(dto.brandLogoLink, null);
    assert.equal(dto.clientCommercialModel, "OFFERS_PLUS_COMMISSION");
    assert.equal(dto.clientSharePercent, 70);
  });

  it("COMMISSION_READY when EFFECTIVE rule and no tracking/coupon", () => {
    const dto = toClientCampaignAssignmentDto(
      buildRecord({
        commissionRules: [
          { id: "r1", status: "EFFECTIVE", commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION" },
        ],
      }),
      { includeStaffCommercial: true },
    );
    assert.equal(dto.assignmentStatus, "COMMISSION_READY");
    assert.equal(dto.commissionRuleStatus, "EFFECTIVE");
    assert.equal(dto.hasTrackingUrl, false);
  });

  it("TRACKING_READY when URL present but commission not EFFECTIVE", () => {
    const dto = toClientCampaignAssignmentDto(
      buildRecord({
        commissionRules: [{ id: "r1", status: "DRAFT", commissionType: "PERCENT" }],
        trackingLinks: [
          {
            id: "t1",
            isPrimary: true,
            status: "ACTIVE",
            mboTrackingUrl: "https://go.mbo.example/r/x",
          },
        ],
      }),
      { includeStaffCommercial: true },
    );
    assert.equal(dto.assignmentStatus, "TRACKING_READY");
    assert.equal(dto.hasTrackingUrl, true);
    assert.equal(dto.trackingUrl, "https://go.mbo.example/r/x");
  });

  it("PROVISIONED vs CLIENT_VISIBLE respect published flag", () => {
    const provisioned = toClientCampaignAssignmentDto(
      buildRecord({
        status: "ACTIVE",
        published: false,
        commissionRules: [{ id: "r1", status: "EFFECTIVE" }],
        trackingLinks: [{ id: "t1", isPrimary: true, status: "ACTIVE", mboTrackingUrl: "https://x" }],
      }),
      { includeStaffCommercial: true },
    );
    assert.equal(provisioned.assignmentStatus, "PROVISIONED");

    const visible = toClientCampaignAssignmentDto(
      buildRecord({
        status: "ACTIVE",
        published: true,
        commissionRules: [{ id: "r1", status: "EFFECTIVE" }],
        trackingLinks: [{ id: "t1", isPrimary: true, status: "ACTIVE", mboTrackingUrl: "https://x" }],
      }),
      { includeStaffCommercial: true },
    );
    assert.equal(visible.assignmentStatus, "CLIENT_VISIBLE");
  });

  it("PAUSED and REVOKED", () => {
    assert.equal(
      toClientCampaignAssignmentDto(buildRecord({ status: "PAUSED" }), {
        includeStaffCommercial: true,
      }).assignmentStatus,
      "PAUSED",
    );
    assert.equal(
      toClientCampaignAssignmentDto(buildRecord({ status: "REVOKED" }), {
        includeStaffCommercial: true,
      }).assignmentStatus,
      "REVOKED",
    );
  });

  it("does not leak apiKey / keyHash / rawPayload / supplierReceivable", () => {
    const dto = toClientCampaignAssignmentDto(buildRecord(), { includeStaffCommercial: true });
    const blob = JSON.stringify(dto);
    for (const needle of ["apiKey", "keyHash", "rawPayload", "supplierReceivable", "mboMargin"]) {
      assert.equal(blob.includes(needle), false, needle);
    }
  });

  it("UNKNOWN relationship becomes Needs review label", () => {
    const dto = toClientCampaignAssignmentDto(
      buildRecord({
        campaignSource: {
          id: "src1",
          supportsLink: true,
          relationshipStatus: "UNKNOWN",
          supplierCampaign: { supplier: "OPTIMISE", campaignType: "CPS" },
        },
      }),
      { includeStaffCommercial: true },
    );
    assert.equal(dto.relationshipLabel, "Needs review");
  });
});
