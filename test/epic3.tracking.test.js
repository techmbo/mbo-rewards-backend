/**
 * Epic 3 — Supplier Tracking & Attribution Verification tests.
 * Never invent supplier parameters; unverified networks must remain non-injecting.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  appendTrackingParams,
  buildAttributionQueryParams,
  getTrackingParamRule,
  TRACKING_VERIFICATION,
  TRACKING_PARAM_CONFIRMATION,
} from "../src/modules/tracking/index.js";
import { TrackingRedirectService } from "../src/modules/reporting/services/trackingRedirect.service.js";
import { AttributionService } from "../src/modules/reporting/services/attribution.service.js";
import { extractAttributionHints } from "../src/modules/reporting/services/conversionPromotion.service.js";

function liveLink(overrides = {}) {
  return {
    id: "tl1",
    assignmentId: "a1",
    slug: "nova-benefits-ajio",
    subId: "8V5DAXR6",
    status: "ACTIVE",
    deletedAt: null,
    supplierTrackingUrl: null,
    campaignSource: {
      supplierCampaign: { supplier: "TRACKIER", trackingUrl: "https://track.example/click?campaign_id=1" },
    },
    assignment: {
      id: "a1",
      clientId: "client-1",
      status: "ACTIVE",
      published: true,
      client: { id: "client-1", status: "ACTIVE", deletedAt: null },
      canonicalCampaign: { status: "PUBLISHED", visibility: "ASSIGNABLE", deletedAt: null },
      campaignSource: {
        supplierCampaign: { supplier: "TRACKIER" },
      },
      couponAssignments: [],
    },
    ...overrides,
  };
}

describe("Epic 3 — Impact confirmed params", () => {
  it("injects subId1/subId2/subId3", () => {
    const built = buildAttributionQueryParams({
      supplier: "IMPACT",
      clientId: "client-a",
      assignmentId: "asg-a",
      mboClickId: "click-a",
    });
    assert.equal(built.injected, true);
    assert.equal(built.params.subId1, "client-a");
    assert.equal(built.params.subId2, "asg-a");
    assert.equal(built.params.subId3, "click-a");
    assert.ok(
      getTrackingParamRule("IMPACT").verificationFlags.includes(
        TRACKING_VERIFICATION.IMPACT_PRODUCTION_ECHO_UNVERIFIED,
      ),
    );
  });

  it("redirect injects Impact params and preserves supplier query", async () => {
    const attribution = { recordClick: mock.fn(async () => ({ id: "click-impact-1" })) };
    const trackingRepo = {
      findBySlugAndToken: mock.fn(async () =>
        liveLink({
          supplierTrackingUrl: "https://goto.impact.com/c?mid=1&existing=keep#hash1",
          campaignSource: { supplierCampaign: { supplier: "IMPACT" } },
          assignment: {
            ...liveLink().assignment,
            campaignSource: { supplierCampaign: { supplier: "IMPACT" } },
          },
        }),
      ),
      findBySubId: mock.fn(async () => null),
      update: mock.fn(async (id, data) => ({ id, ...data })),
    };
    const service = new TrackingRedirectService({ trackingRepo, attribution });
    const result = await service.redirect({ slug: "nova-benefits-ajio", token: "8V5DAXR6" });
    const dest = new URL(result.destination);
    assert.equal(dest.searchParams.get("existing"), "keep");
    assert.equal(dest.hash, "#hash1");
    assert.equal(dest.searchParams.get("subId1"), "client-1");
    assert.equal(dest.searchParams.get("subId2"), "a1");
    assert.equal(dest.searchParams.get("subId3"), "click-impact-1");
  });

  it("conversion echo maps SubId1/2/3 into attribution hints", () => {
    const hints = extractAttributionHints({
      SubId1: "client-a",
      SubId2: "asg-a",
      SubId3: "click-a",
      Id: "action-1",
    });
    assert.equal(hints.clientId, "client-a");
    assert.equal(hints.assignmentId, "asg-a");
    assert.equal(hints.clickId, "click-a");
  });
});

describe("Epic 3 — Trackier confirmed params + production echo flag", () => {
  it("injects p1/p2/p3/click_id", () => {
    const built = buildAttributionQueryParams({
      supplier: "TRACKIER",
      clientId: "c1",
      assignmentId: "a1",
      mboClickId: "clk1",
    });
    assert.equal(built.params.p1, "c1");
    assert.equal(built.params.p2, "a1");
    assert.equal(built.params.p3, "clk1");
    assert.equal(built.params.click_id, "clk1");
    assert.ok(
      getTrackingParamRule("TRACKIER").verificationFlags.includes(
        TRACKING_VERIFICATION.TRACKIER_PRODUCTION_ECHO_UNVERIFIED,
      ),
    );
  });

  it("vCommission aliases to Trackier rules", () => {
    assert.equal(getTrackingParamRule("VCOMMISSION").supplier, "TRACKIER");
  });
});

describe("Epic 3 — Optimise UID/UID2; click-ref remains unverified", () => {
  it("does not invent a click-reference parameter", () => {
    const built = buildAttributionQueryParams({
      supplier: "OPTIMISE",
      clientId: "c1",
      assignmentId: "a1",
      mboClickId: "clk1",
    });
    assert.equal(built.params.UID, "c1");
    assert.equal(built.params.UID2, "a1");
    assert.equal(getTrackingParamRule("OPTIMISE").mboClickIdParam, null);
    assert.equal(Object.keys(built.params).includes("click_id"), false);
    assert.ok(
      getTrackingParamRule("OPTIMISE").verificationFlags.includes(
        TRACKING_VERIFICATION.OPTIMISE_CLICK_REFERENCE_UNVERIFIED,
      ),
    );
  });
});

describe("Epic 3 — Partnerize v15 12F confirmed params; Boostiny remains unverified", () => {
  it("Boostiny stays UNCONFIRMED with empty params", () => {
    const built = buildAttributionQueryParams({
      supplier: "BOOSTINY",
      clientId: "c1",
      assignmentId: "a1",
      mboClickId: "clk1",
    });
    assert.equal(built.injected, false);
    assert.deepEqual(built.params, {});
    assert.equal(getTrackingParamRule("BOOSTINY").confirmation, TRACKING_PARAM_CONFIRMATION.UNCONFIRMED);
    assert.ok(
      getTrackingParamRule("BOOSTINY").verificationFlags.includes(
        TRACKING_VERIFICATION.BOOSTINY_TRACKING_UNVERIFIED,
      ),
    );
  });

  it("Partnerize injects adref/pubref/clickref per v15 12F", async () => {
    const built = buildAttributionQueryParams({
      supplier: "PARTNERIZE",
      clientId: "c1",
      assignmentId: "a1",
      mboClickId: "clk1",
    });
    assert.equal(built.injected, true);
    assert.equal(built.params.adref, "c1");
    assert.equal(built.params.pubref, "a1");
    assert.equal(built.params.clickref, "clk1");
    assert.equal(getTrackingParamRule("PARTNERIZE").confirmation, TRACKING_PARAM_CONFIRMATION.CONFIRMED);
    assert.ok(
      getTrackingParamRule("PARTNERIZE").verificationFlags.includes(
        TRACKING_VERIFICATION.PARTNERIZE_PRODUCTION_ECHO_UNVERIFIED,
      ),
    );

    const attribution = { recordClick: mock.fn(async () => ({ id: "click-pz" })) };
    const trackingRepo = {
      findBySlugAndToken: mock.fn(async () =>
        liveLink({
          supplierTrackingUrl: "https://prf.hn/click/camref:1?x=1",
          campaignSource: { supplierCampaign: { supplier: "PARTNERIZE" } },
          assignment: {
            ...liveLink().assignment,
            campaignSource: { supplierCampaign: { supplier: "PARTNERIZE" } },
          },
        }),
      ),
      findBySubId: mock.fn(async () => null),
      update: mock.fn(async (id, data) => ({ id, ...data })),
    };
    const service = new TrackingRedirectService({ trackingRepo, attribution });
    const result = await service.redirect({ slug: "nova-benefits-ajio", token: "8V5DAXR6" });
    const dest = new URL(result.destination);
    assert.equal(dest.searchParams.get("x"), "1");
    assert.equal(dest.searchParams.get("adref"), "client-1");
    assert.equal(dest.searchParams.get("pubref"), "a1");
    assert.equal(dest.searchParams.get("clickref"), "click-pz");
    assert.equal(result.attributionInjection.injected, true);
  });

  it("Partnerize conversion echo maps adref/pubref/clickref into hints", () => {
    const hints = extractAttributionHints({
      conversion_id: "pz-1",
      adref: "client-a",
      pubref: "asg-a",
      clickref: "click-a",
    });
    assert.equal(hints.clientId, "client-a");
    assert.equal(hints.assignmentId, "asg-a");
    assert.equal(hints.clickId, "click-a");
  });
});

describe("Epic 3 — URL safety", () => {
  it("preserves query, hash, encoding; does not overwrite existing keys", () => {
    const result = appendTrackingParams(
      "https://go.example/path?mid=9&subId1=keep#sec",
      { subId1: "new", subId2: "asg", weird: "a b/c" },
    );
    const url = new URL(result.url);
    assert.equal(url.searchParams.get("mid"), "9");
    assert.equal(url.searchParams.get("subId1"), "keep");
    assert.equal(url.searchParams.get("subId2"), "asg");
    assert.equal(url.searchParams.get("weird"), "a b/c");
    assert.equal(url.hash, "#sec");
    assert.deepEqual(result.skipped, ["subId1"]);
  });
});

describe("Epic 3 — Attribution precedence and safety", () => {
  it("prefers click id over assignment hint", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv1",
        clickId: "click-strong",
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "10",
        status: "APPROVED",
        metadata: { attributionHints: { assignmentId: "wrong-asg", clientId: "client-1" } },
      })),
      update: mock.fn(async (_id, data) => data),
    };
    const clickRepo = {
      findById: mock.fn(async (id) =>
        id === "click-strong"
          ? {
              id: "click-strong",
              trackingLinkId: "tl1",
              clientAssignmentId: "asg-correct",
              campaignSourceId: "cs1",
              subId: "tok",
            }
          : null,
      ),
      findBySubId: mock.fn(async () => null),
    };
    const service = new AttributionService({
      conversionRepo,
      clickRepo,
      trackingRepo: {
        findById: mock.fn(async () => ({
          id: "tl1",
          assignmentId: "asg-correct",
          campaignSourceId: "cs1",
        })),
        findPrimaryForAssignment: mock.fn(async () => null),
      },
      commissionRepo: {
        findEffectiveForAssignment: mock.fn(async () => ({
          id: "r1",
          grossCommission: "100",
          clientCommission: "70",
        })),
      },
      assignmentRepo: {
        findById: mock.fn(async (id) =>
          id === "asg-correct" ? { id: "asg-correct", clientId: "client-1" } : null,
        ),
      },
      exceptions: { report: mock.fn(async () => ({})) },
    });
    const result = await service.attributeConversion("cv1");
    assert.equal(result.attributionStatus, "ATTRIBUTED");
    assert.equal(result.clientAssignmentId, "asg-correct");
  });

  it("rejects wrong-client when hint disagrees with assignment", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv1",
        clickId: "click-1",
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "10",
        status: "APPROVED",
        metadata: { attributionHints: { clientId: "client-B" } },
      })),
      update: mock.fn(async (_id, data) => data),
    };
    const exceptions = { report: mock.fn(async () => ({})) };
    const service = new AttributionService({
      conversionRepo,
      clickRepo: {
        findById: mock.fn(async () => ({
          id: "click-1",
          trackingLinkId: "tl1",
          clientAssignmentId: "asg-a",
          campaignSourceId: "cs1",
          subId: "tok",
        })),
        findBySubId: mock.fn(async () => null),
      },
      trackingRepo: {
        findById: mock.fn(async () => ({ id: "tl1", assignmentId: "asg-a", campaignSourceId: "cs1" })),
      },
      commissionRepo: { findEffectiveForAssignment: mock.fn(async () => null) },
      assignmentRepo: {
        findById: mock.fn(async () => ({ id: "asg-a", clientId: "client-A" })),
      },
      exceptions,
    });
    const result = await service.attributeConversion("cv1");
    assert.equal(result.attributionStatus, "ORPHAN");
    assert.equal(result.metadata?.attributionRejection?.reason, "wrong_client");
    assert.equal(exceptions.report.mock.calls.length, 1);
  });

  it("does not attribute from clientId alone", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv1",
        clickId: null,
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "10",
        status: "PENDING",
        metadata: { attributionHints: { clientId: "client-only" } },
      })),
      update: mock.fn(async (_id, data) => data),
    };
    const service = new AttributionService({
      conversionRepo,
      clickRepo: { findById: mock.fn(async () => null), findBySubId: mock.fn(async () => null) },
      trackingRepo: { findById: mock.fn(async () => null), findPrimaryForAssignment: mock.fn(async () => null) },
      assignmentRepo: { findById: mock.fn(async () => null) },
      commissionRepo: { findEffectiveForAssignment: mock.fn(async () => null) },
      exceptions: { report: mock.fn(async () => ({})) },
    });
    const result = await service.attributeConversion("cv1");
    assert.equal(result.attributionStatus, "ORPHAN");
  });

  it("orphans when click and assignment hints missing", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv1",
        clickId: null,
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "1",
        status: "PENDING",
        metadata: {},
      })),
      update: mock.fn(async (_id, data) => data),
    };
    const service = new AttributionService({
      conversionRepo,
      clickRepo: { findById: mock.fn(async () => null), findBySubId: mock.fn(async () => null) },
      trackingRepo: { findById: mock.fn(async () => null) },
      assignmentRepo: { findById: mock.fn(async () => null) },
      commissionRepo: { findEffectiveForAssignment: mock.fn(async () => null) },
      exceptions: { report: mock.fn(async () => ({})) },
    });
    const result = await service.attributeConversion("cv1");
    assert.equal(result.attributionStatus, "ORPHAN");
  });
});

describe("Epic 3 — golden path attribution handoff (fixture)", () => {
  it("MBO redirect params → conversion echo → ATTRIBUTED assignment", async () => {
    const clickId = "click-gold-1";
    const clientId = "client-1";
    const assignmentId = "asg-1";

    // Simulate Trackier URL injection result
    const injected = buildAttributionQueryParams({
      supplier: "TRACKIER",
      clientId,
      assignmentId,
      mboClickId: clickId,
    });
    assert.deepEqual(injected.params, {
      p1: clientId,
      p2: assignmentId,
      p3: clickId,
      click_id: clickId,
    });

    // Simulate Trackier conversion payload echoing those params
    const hints = extractAttributionHints({
      id: "trk-conv-1",
      p1: injected.params.p1,
      p2: injected.params.p2,
      p3: injected.params.p3,
      click_id: injected.params.click_id,
      commission: "25.00",
      currency: "USD",
    });
    assert.equal(hints.clickId, clickId);
    assert.equal(hints.assignmentId, assignmentId);
    assert.equal(hints.clientId, clientId);

    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv-gold",
        clickId: hints.clickId,
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "25.00",
        status: "APPROVED",
        approvedCommission: "25.00",
        metadata: { attributionHints: hints },
      })),
      update: mock.fn(async (_id, data) => ({ id: "cv-gold", ...data })),
    };
    const service = new AttributionService({
      conversionRepo,
      clickRepo: {
        findById: mock.fn(async () => ({
          id: clickId,
          trackingLinkId: "tl-gold",
          clientAssignmentId: assignmentId,
          campaignSourceId: "cs-gold",
          subId: "8V5DAXR6",
        })),
        findBySubId: mock.fn(async () => null),
      },
      trackingRepo: {
        findById: mock.fn(async () => ({
          id: "tl-gold",
          assignmentId,
          campaignSourceId: "cs-gold",
        })),
      },
      assignmentRepo: {
        findById: mock.fn(async () => ({ id: assignmentId, clientId })),
      },
      commissionRepo: {
        findEffectiveForAssignment: mock.fn(async () => ({
          id: "rule-gold",
          grossCommission: "100",
          clientCommission: "70",
        })),
      },
      exceptions: { report: mock.fn(async () => ({})) },
    });

    const attributed = await service.attributeConversion("cv-gold");
    assert.equal(attributed.attributionStatus, "ATTRIBUTED");
    assert.equal(attributed.clientAssignmentId, assignmentId);
    assert.equal(attributed.clientCommission, "17.5000");
    assert.equal(attributed.mboCommission, "7.5000");
  });
});
