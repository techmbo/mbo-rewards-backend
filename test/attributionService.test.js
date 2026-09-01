import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { AttributionService } from "../src/modules/reporting/services/attribution.service.js";
import {
  applyCommissionRuleToGross,
  computeConversionRate,
  computeEpc,
  grossCommissionForConversion,
} from "../src/modules/reporting/attributionMath.js";

describe("attributionMath", () => {
  it("uses approved commission for approved conversions", () => {
    const gross = grossCommissionForConversion({
      status: "APPROVED",
      supplierCommission: "10.0000",
      approvedCommission: "8.0000",
    });
    assert.equal(gross.toString(), "8.0000");
  });

  it("applies commission rule ratio to gross", () => {
    const split = applyCommissionRuleToGross("100.0000", {
      grossCommission: "10.0000",
      clientCommission: "6.0000",
    });
    assert.equal(split.ok, true);
    assert.equal(split.clientCommission, "60.0000");
    assert.equal(split.mboCommission, "40.0000");
  });

  it("computes conversion rate and epc", () => {
    assert.equal(computeConversionRate(2, 10), 0.2);
    assert.equal(computeEpc(50, 10), 5);
  });
});

describe("AttributionService", () => {
  it("records click with hashed pii", async () => {
    const trackingRepo = {
      findById: mock.fn(async () => ({
        id: "tl1",
        assignmentId: "a1",
        campaignSourceId: "cs1",
        subId: "mbo_sub",
        status: "ACTIVE",
      })),
    };
    const assignmentRepo = {
      findById: mock.fn(async () => ({ id: "a1" })),
    };
    const clickRepo = {
      create: mock.fn(async (data) => ({ id: "c1", ...data })),
    };

    const service = new AttributionService({ trackingRepo, assignmentRepo, clickRepo });
    const click = await service.recordClick({
      trackingLinkId: "tl1",
      ip: "1.2.3.4",
      userAgent: "Mozilla/5.0",
    });

    assert.equal(click.trackingLinkId, "tl1");
    assert.ok(click.ipHash);
    assert.notEqual(click.ipHash, "1.2.3.4");
    assert.ok(click.userAgentHash);
  });

  it("marks conversion orphan when no tracking context", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv1",
        clickId: null,
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "5.0000",
        status: "PENDING",
      })),
      update: mock.fn(async (_id, data) => data),
    };
    const clickRepo = { findById: mock.fn(async () => null), findBySubId: mock.fn(async () => null) };
    const trackingRepo = { findById: mock.fn(async () => null) };
    const commissionRepo = { findEffectiveForAssignment: mock.fn(async () => null) };

    const service = new AttributionService({
      conversionRepo,
      clickRepo,
      trackingRepo,
      commissionRepo,
      assignmentRepo: {
        findById: mock.fn(async () => null),
        findPublishedActiveByCampaignSource: mock.fn(async () => []),
      },
      couponAssignmentRepo: { findActiveByCouponCode: mock.fn(async () => []) },
      exceptions: { report: async () => ({}) },
    });

    const result = await service.attributeConversion("cv1");
    assert.equal(result.attributionStatus, "ORPHAN");
  });

  it("attributes conversion via subId click match", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv1",
        subId: "mbo_sub",
        clickId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "10.0000",
        status: "APPROVED",
        approvedCommission: "10.0000",
        metadata: {},
      })),
      update: mock.fn(async (_id, data) => ({ id: "cv1", ...data })),
    };
    const clickRepo = {
      findById: mock.fn(async () => null),
      findBySubId: mock.fn(async () => ({
        id: "clk1",
        trackingLinkId: "tl1",
        clientAssignmentId: "a1",
        campaignSourceId: "cs1",
        subId: "mbo_sub",
      })),
    };
    const trackingRepo = {
      findById: mock.fn(async () => ({
        id: "tl1",
        assignmentId: "a1",
        campaignSourceId: "cs1",
      })),
      findPrimaryForAssignment: mock.fn(async () => null),
    };
    const commissionRepo = {
      findEffectiveForAssignment: mock.fn(async () => ({
        id: "rule1",
        grossCommission: "10.0000",
        clientCommission: "7.0000",
      })),
    };

    const service = new AttributionService({
      conversionRepo,
      clickRepo,
      trackingRepo,
      commissionRepo,
      assignmentRepo: {
        findById: mock.fn(async () => null),
        findPublishedActiveByCampaignSource: mock.fn(async () => []),
      },
      couponAssignmentRepo: { findActiveByCouponCode: mock.fn(async () => []) },
    });

    const result = await service.attributeConversion("cv1");
    assert.equal(result.attributionStatus, "ATTRIBUTED");
    assert.equal(result.clientAssignmentId, "a1");
    assert.equal(result.clientCommission, "7.0000");
    assert.equal(result.mboCommission, "3.0000");
  });

  it("attributes conversion via unique assigned coupon", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv-coupon",
        clickId: null,
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "10.0000",
        status: "APPROVED",
        approvedCommission: "10.0000",
        metadata: { attributionHints: { couponCode: "UNIQUE1" } },
      })),
      update: mock.fn(async (_id, data) => ({ id: "cv-coupon", ...data })),
    };
    const couponAssignmentRepo = {
      findActiveByCouponCode: mock.fn(async () => [
        { assignmentId: "a-unique", assignment: { id: "a-unique", clientId: "c1" } },
      ]),
    };
    const service = new AttributionService({
      conversionRepo,
      clickRepo: { findById: async () => null, findBySubId: async () => null },
      trackingRepo: {
        findById: async () => null,
        findPrimaryForAssignment: async () => ({
          id: "tl-u",
          assignmentId: "a-unique",
          campaignSourceId: "cs-u",
        }),
      },
      assignmentRepo: {
        findById: async () => ({ id: "a-unique", clientId: "c1" }),
        findPublishedActiveByCampaignSource: async () => [],
      },
      couponAssignmentRepo,
      commissionRepo: {
        findEffectiveForAssignment: async () => ({
          id: "rule1",
          grossCommission: "10.0000",
          clientCommission: "7.0000",
        }),
      },
      exceptions: { report: async () => ({}) },
    });

    const result = await service.attributeConversion("cv-coupon");
    assert.equal(result.attributionStatus, "ATTRIBUTED");
    assert.equal(result.clientAssignmentId, "a-unique");
    assert.equal(result.metadata.attributionEvidence, "unique_coupon");
  });

  it("marks REVIEW_REQUIRED for shared coupon", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv-shared",
        clickId: null,
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "5.0000",
        status: "PENDING",
        metadata: { attributionHints: { couponCode: "SHARE1" } },
      })),
      update: mock.fn(async (_id, data) => ({ id: "cv-shared", ...data })),
    };
    const service = new AttributionService({
      conversionRepo,
      clickRepo: { findById: async () => null, findBySubId: async () => null },
      trackingRepo: { findById: async () => null, findPrimaryForAssignment: async () => null },
      assignmentRepo: {
        findById: async () => null,
        findPublishedActiveByCampaignSource: async () => [],
      },
      couponAssignmentRepo: {
        findActiveByCouponCode: async () => [
          { assignmentId: "a1" },
          { assignmentId: "a2" },
        ],
      },
      commissionRepo: { findEffectiveForAssignment: async () => null },
      exceptions: { report: async () => ({}) },
    });

    const result = await service.attributeConversion("cv-shared");
    assert.equal(result.attributionStatus, "REVIEW_REQUIRED");
    assert.equal(result.metadata.attributionReview.reason, "shared_coupon_ambiguous");
  });

  it("attributes via single published assignment for campaign source", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv-single",
        clickId: null,
        subId: null,
        trackingLinkId: null,
        campaignSourceId: "cs-only",
        conversionDate: new Date(),
        supplierCommission: "5.0000",
        status: "PENDING",
        metadata: {},
      })),
      update: mock.fn(async (_id, data) => ({ id: "cv-single", ...data })),
    };
    const service = new AttributionService({
      conversionRepo,
      clickRepo: { findById: async () => null, findBySubId: async () => null },
      trackingRepo: {
        findById: async () => null,
        findPrimaryForAssignment: async () => ({
          id: "tl-s",
          assignmentId: "a-only",
          campaignSourceId: "cs-only",
        }),
      },
      assignmentRepo: {
        findById: async () => ({ id: "a-only", clientId: "c1" }),
        findPublishedActiveByCampaignSource: async () => [
          { id: "a-only", campaignSourceId: "cs-only" },
        ],
      },
      couponAssignmentRepo: { findActiveByCouponCode: async () => [] },
      commissionRepo: { findEffectiveForAssignment: async () => null },
      exceptions: { report: async () => ({}) },
    });

    const result = await service.attributeConversion("cv-single");
    assert.equal(result.attributionStatus, "ATTRIBUTED");
    assert.equal(result.clientAssignmentId, "a-only");
    assert.equal(result.metadata.attributionEvidence, "single_assignment");
  });
});
