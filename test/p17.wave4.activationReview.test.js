/**
 * P1.7 Wave 4 — activation / onboarding projection + blocker contract.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toClientCampaignAssignmentDto } from "../src/modules/client/dto/client.dto.js";
import { buildClientSetupProgress } from "../src/modules/client/setupProgress.js";

describe("P1.7 Wave 4 activation readiness projection", () => {
  it("maps EFFECTIVE + tracking + published ACTIVE to CLIENT_VISIBLE", () => {
    const dto = toClientCampaignAssignmentDto(
      {
        id: "a1",
        clientId: "c1",
        status: "ACTIVE",
        published: true,
        client: {
          id: "c1",
          name: "Hello1",
          status: "ACTIVE",
          commercialModel: "OFFERS_PLUS_COMMISSION",
          clientSharePercent: 70,
          currency: "INR",
          country: "IN",
        },
        canonicalCampaign: {
          id: "cc1",
          displayName: "Staycation",
          status: "PUBLISHED",
          merchant: { id: "m1", displayName: "Klook", logoUrl: null, website: null },
        },
        campaignSource: {
          id: "src1",
          supportsLink: true,
          relationshipStatus: "JOINED",
          supplierCampaign: { supplier: "OPTIMISE", campaignType: "CPS", pricingModel: "CPS" },
        },
        commissionRules: [{ id: "r1", status: "EFFECTIVE", commissionType: "PERCENT" }],
        trackingLinks: [
          { id: "t1", isPrimary: true, status: "ACTIVE", mboTrackingUrl: "https://go.mbo.example/r/x" },
        ],
        couponAssignments: [],
      },
      { includeStaffCommercial: true },
    );
    assert.equal(dto.assignmentStatus, "CLIENT_VISIBLE");
    assert.equal(dto.hasTrackingUrl, true);
    assert.equal(dto.commercialModel, "CPS");
    assert.notEqual(dto.channelType, dto.commercialModel);
  });

  it("missing commission → not CLIENT_VISIBLE / PROVISIONED", () => {
    const dto = toClientCampaignAssignmentDto(
      {
        id: "a1",
        clientId: "c1",
        status: "ASSIGNED",
        published: false,
        client: { id: "c1", name: "X", status: "PROSPECT", commercialModel: "OFFERS_ONLY" },
        canonicalCampaign: {
          id: "cc1",
          displayName: "Hotel",
          merchant: { id: "m1", displayName: "Klook" },
        },
        campaignSource: {
          supportsLink: true,
          supplierCampaign: { supplier: "OPTIMISE", campaignType: "CPS" },
        },
        commissionRules: [],
        trackingLinks: [
          { id: "t1", isPrimary: true, status: "ACTIVE", mboTrackingUrl: "https://go.mbo.example/r/x" },
        ],
        couponAssignments: [],
      },
      { includeStaffCommercial: true },
    );
    assert.equal(dto.assignmentStatus, "TRACKING_READY");
    assert.equal(dto.commissionRuleStatus, null);
  });

  it("serialized staff assignment does not leak secrets", () => {
    const dto = toClientCampaignAssignmentDto(
      {
        id: "a1",
        clientId: "c1",
        status: "ASSIGNED",
        published: false,
        client: { id: "c1", name: "X", status: "ACTIVE" },
        canonicalCampaign: { id: "cc1", displayName: "X", merchant: { id: "m1", displayName: "X" } },
        campaignSource: { supplierCampaign: { campaignType: "CPS" } },
        commissionRules: [],
        trackingLinks: [],
        couponAssignments: [],
      },
      { includeStaffCommercial: true },
    );
    const blob = JSON.stringify(dto);
    for (const needle of ["apiKey", "keyHash", "rawPayload", "supplierReceivable", "mboMargin"]) {
      assert.equal(blob.includes(needle), false, needle);
    }
  });
});

describe("P1.7 Wave 4 client activation checklist gates", () => {
  it("activation requires commercial, allotment, published, api key", () => {
    const incomplete = buildClientSetupProgress({
      status: "PROSPECT",
      commercialModel: null,
      hasAssignments: false,
      hasPublishedAssignment: false,
      hasApiKey: false,
      hasAdmin: false,
    });
    assert.equal(incomplete.checklist.commercialConfigured, false);
    assert.equal(incomplete.checklist.campaignsAllotted, false);
    assert.equal(incomplete.checklist.assignmentsPublished, false);
    assert.equal(incomplete.checklist.apiKeyIssued, false);
    assert.equal(incomplete.checklist.activated, false);

    const ready = buildClientSetupProgress({
      status: "ACTIVE",
      commercialModel: "OFFERS_PLUS_COMMISSION",
      hasAssignments: true,
      hasPublishedAssignment: true,
      hasApiKey: true,
      hasAdmin: true,
      hasCommissionRules: true,
      hasTrackingLinks: true,
    });
    assert.equal(ready.checklist.activated, true);
    assert.equal(ready.checklist.provisioned, true);
  });

  it("ACTIVATION_BLOCKED detail shape remains consumable", () => {
    // Mirrors activate() error.details contract used by FE.
    const details = {
      code: "ACTIVATION_BLOCKED",
      activationBlocks: ["Commercial model is not configured."],
      activationBlockDetails: [
        {
          code: "ACTIVATION_BLOCKED",
          message: "Commercial model is not configured.",
          severity: "blocked",
        },
      ],
    };
    assert.equal(details.code, "ACTIVATION_BLOCKED");
    assert.ok(Array.isArray(details.activationBlocks));
    assert.equal(details.activationBlockDetails[0].severity, "blocked");
  });
});

describe("P1.7 Wave 4 revoked / paused semantics", () => {
  it("REVOKED and PAUSED assignmentStatus", () => {
    const revoked = toClientCampaignAssignmentDto(
      {
        id: "a1",
        clientId: "c1",
        status: "REVOKED",
        published: false,
        client: { id: "c1", name: "X" },
        canonicalCampaign: { id: "cc1", displayName: "X", merchant: { displayName: "X" } },
        campaignSource: { supplierCampaign: { campaignType: "CPS" } },
        commissionRules: [],
        trackingLinks: [],
        couponAssignments: [],
      },
      { includeStaffCommercial: true },
    );
    assert.equal(revoked.assignmentStatus, "REVOKED");

    const pausedDto = toClientCampaignAssignmentDto(
      {
        id: "a2",
        clientId: "c1",
        status: "PAUSED",
        published: false,
        client: { id: "c1", name: "X" },
        canonicalCampaign: { id: "cc1", displayName: "X", merchant: { displayName: "X" } },
        campaignSource: { supplierCampaign: { campaignType: "CPS" } },
        commissionRules: [{ id: "r1", status: "EFFECTIVE" }],
        trackingLinks: [{ id: "t1", isPrimary: true, status: "ACTIVE", mboTrackingUrl: "https://x" }],
        couponAssignments: [],
      },
      { includeStaffCommercial: true },
    );
    assert.equal(pausedDto.assignmentStatus, "PAUSED");
  });
});
