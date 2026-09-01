import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapOptimiseCampaign,
  mapOptimiseCampaignLifecycle,
  mapOptimisePublisherRelationship,
} from "../src/modules/supplier/mappers/optimise.mapper.js";
import {
  resolveRelationshipStatus,
  mapRelationshipStatus,
} from "../src/modules/ops/v15FieldContract.js";
import {
  CampaignEligibilityService,
  isSourceEligible,
} from "../src/modules/client/services/campaignEligibility.service.js";

function optimiseEntity(rawOverrides = {}, entityOverrides = {}) {
  return {
    id: "ent1",
    networkSource: "optimise_sea",
    externalId: "clienta:12345",
    campaignName: "Staycation",
    advertiserName: "Klook",
    entityStatus: null,
    rawData: {
      status: "live",
      campaignName: "Staycation",
      advertiserName: "Klook",
      appliedDate: "2025-10-23T13:50:13.693Z",
      baseTrackingUrl: "https://track.optimise.com/x",
      commission: { value: "5", type: "percentage" },
      deepLinkEnabled: true,
      ...rawOverrides,
    },
    normalizedData: {},
    ...entityOverrides,
  };
}

describe("Optimise publisher relationship mapping", () => {
  it("maps status=live → JOINED (exact source field)", () => {
    const rel = mapOptimisePublisherRelationship({ status: "live" });
    assert.equal(rel.participationStatus, "JOINED");
    assert.equal(rel.isJoined, true);
    assert.equal(rel.evidenceSource, "optimise.status");
    assert.equal(rel.evidenceValue, "live");

    const mapped = mapOptimiseCampaign(optimiseEntity({ status: "live" }));
    assert.equal(mapped.participationStatus, "JOINED");
    assert.equal(mapped.isJoined, true);
    assert.equal(mapped.campaignStatus, "ACTIVE");
  });

  it("prefers publishers[].campaignSubStatus over top-level status (Master Field Mapping)", () => {
    const rel = mapOptimisePublisherRelationship({
      status: "notapplied",
      publishers: [{ id: "1", campaignSubStatus: "live" }],
    });
    assert.equal(rel.participationStatus, "JOINED");
    assert.equal(rel.isJoined, true);
    assert.equal(rel.evidenceSource, "optimise.publishers[].campaignSubStatus");

    const mapped = mapOptimiseCampaign(
      optimiseEntity({
        status: "notapplied",
        publishers: [{ campaignSubStatus: "live" }],
      }),
    );
    assert.equal(mapped.participationStatus, "JOINED");
    // notapplied alone is not campaign lifecycle
    assert.equal(mapped.campaignStatus, "UNKNOWN");
  });

  it("maps publisherEligibility when publishers[] absent", () => {
    const rel = mapOptimisePublisherRelationship({
      status: "notapplied",
      publisherEligibility: "eligible",
    });
    assert.equal(rel.participationStatus, "JOINED");
    assert.equal(rel.evidenceSource, "optimise.publisherEligibility");
  });

  it("maps advertiserCampaignStatus into campaign lifecycle", () => {
    assert.equal(
      mapOptimiseCampaignLifecycle({ status: "notapplied", advertiserCampaignStatus: "live" }),
      "ACTIVE",
    );
    assert.equal(
      mapOptimiseCampaignLifecycle({ status: "notapplied", advertiserCampaignStatus: "paused" }),
      "PAUSED",
    );
  });

  it("maps status=notapplied → NOT_JOINED (v15 03C)", () => {
    const rel = mapOptimisePublisherRelationship({ status: "notapplied" });
    assert.equal(rel.participationStatus, "NOT_JOINED");
    assert.equal(rel.isJoined, false);

    const mapped = mapOptimiseCampaign(
      optimiseEntity({ status: "notapplied", appliedDate: null, baseTrackingUrl: null }),
    );
    assert.equal(mapped.participationStatus, "NOT_JOINED");
    assert.equal(mapped.isJoined, false);
    assert.equal(mapped.campaignStatus, "UNKNOWN");
  });

  it("absent status → UNKNOWN (not invented JOINED)", () => {
    const rel = mapOptimisePublisherRelationship({});
    assert.equal(rel.participationStatus, "UNKNOWN");
    assert.equal(rel.isJoined, false);
  });

  it("ACTIVE campaign lifecycle ≠ automatic JOINED without Optimise status", () => {
    assert.equal(mapOptimiseCampaignLifecycle({ status: "notapplied" }), "UNKNOWN");
    const mapped = mapOptimiseCampaign(
      optimiseEntity({
        status: "notapplied",
        // Misleading lifecycle-ish signals must not force JOINED
        isEligible: true,
        acceptingApplications: true,
      }),
    );
    assert.equal(mapped.isJoined, false);
    assert.notEqual(mapped.participationStatus, "JOINED");
  });

  it("rejectedDate → NOT_JOINED", () => {
    const rel = mapOptimisePublisherRelationship({
      status: "live",
      rejectedDate: "2025-11-01T00:00:00.000Z",
    });
    assert.equal(rel.participationStatus, "NOT_JOINED");
    assert.equal(rel.isJoined, false);
  });

  it("paused + cancelledDate → NOT_JOINED; paused alone → UNKNOWN", () => {
    assert.equal(
      mapOptimisePublisherRelationship({
        status: "paused",
        cancelledDate: "2026-04-16T08:08:46.797Z",
      }).participationStatus,
      "NOT_JOINED",
    );
    assert.equal(
      mapOptimisePublisherRelationship({ status: "paused", appliedDate: "2025-10-01T00:00:00.000Z" })
        .participationStatus,
      "UNKNOWN",
    );
  });
});

describe("resolveRelationshipStatus + eligibility gates", () => {
  const eligibility = new CampaignEligibilityService();
  const catalog = {
    id: "cc1",
    status: "PUBLISHED",
    visibility: "ASSIGNABLE",
    deletedAt: null,
    countries: ["IN"],
    defaultCurrency: "INR",
  };
  const client = { id: "c1", status: "ACTIVE", country: "IN", currency: "INR" };

  function source(overrides = {}) {
    return {
      id: "s1",
      isActive: true,
      status: "PREFERRED",
      relationshipStatus: "UNKNOWN",
      supportsLink: true,
      supportsCoupon: false,
      grossCommission: "5",
      supplierCampaign: {
        trackingUrl: "https://clk.example/go",
        campaignStatus: "ACTIVE",
        merchantId: "m1",
        defaultCommissionValue: "5",
        isJoined: false,
        participationStatus: null,
        ...(overrides.supplierCampaign || {}),
      },
      ...overrides,
      supplierCampaign: {
        trackingUrl: "https://clk.example/go",
        campaignStatus: "ACTIVE",
        merchantId: "m1",
        defaultCommissionValue: "5",
        isJoined: false,
        participationStatus: null,
        ...(overrides.supplierCampaign || {}),
      },
    };
  }

  it("preserves known CampaignSource relationship over supplier fallback", () => {
    const resolved = resolveRelationshipStatus(
      { relationshipStatus: "PENDING" },
      { isJoined: true, participationStatus: "JOINED" },
    );
    assert.equal(resolved, "PENDING");
  });

  it("falls back to SupplierCampaign isJoined / participation", () => {
    assert.equal(
      resolveRelationshipStatus({ relationshipStatus: "UNKNOWN" }, { isJoined: true }),
      "JOINED",
    );
    assert.equal(
      resolveRelationshipStatus(
        { relationshipStatus: "UNKNOWN" },
        { isJoined: false, participationStatus: "NOT_JOINED" },
      ),
      "NOT_JOINED",
    );
  });

  it("UNKNOWN relationship blocks eligibility (Needs review)", () => {
    const result = eligibility.evaluate({
      mode: "assign",
      catalogCampaign: catalog,
      client,
      sources: [source()],
    });
    assert.equal(result.ok, false);
    assert.equal(result.eligibilityStatus, "NEEDS_REVIEW");
    assert.ok(result.reasons.includes("relationship_unknown"));
  });

  it("JOINED relationship can satisfy the relationship gate", () => {
    const src = source({
      relationshipStatus: "JOINED",
      supplierCampaign: { isJoined: true, participationStatus: "JOINED" },
    });
    assert.equal(isSourceEligible(src).ok, true);
  });

  it("APPROVED relationship can satisfy the relationship gate", () => {
    const src = source({ relationshipStatus: "JOINED" });
    // Workbook APPROVED maps via mapRelationshipStatus; store path uses JOINED in DB.
    assert.equal(mapRelationshipStatus("APPROVED"), "APPROVED");
    const withApprovedApi = {
      ...src,
      relationshipStatus: "UNKNOWN",
      supplierCampaign: { ...src.supplierCampaign, isJoined: true },
    };
    assert.equal(isSourceEligible(withApprovedApi).relationshipStatus, "JOINED");
    assert.equal(isSourceEligible(withApprovedApi).ok, true);
  });

  it("NOT_JOINED / rejected blocks eligibility", () => {
    const src = source({
      relationshipStatus: "NOT_JOINED",
      supplierCampaign: { participationStatus: "NOT_JOINED", isJoined: false },
    });
    assert.ok(isSourceEligible(src).reasons.includes("relationship_not_joined"));
  });

  it("PENDING relationship blocks eligibility", () => {
    const src = source({
      relationshipStatus: "PENDING",
      supplierCampaign: { participationStatus: "PENDING", isJoined: false },
    });
    assert.ok(isSourceEligible(src).reasons.includes("relationship_pending"));
  });

  it("missing merchant blocks eligibility", () => {
    const src = source({
      relationshipStatus: "JOINED",
      supplierCampaign: { merchantId: null, isJoined: true, participationStatus: "JOINED" },
    });
    assert.ok(isSourceEligible(src).reasons.includes("missing_merchant"));
  });

  it("missing commission blocks eligibility", () => {
    const src = source({
      relationshipStatus: "JOINED",
      grossCommission: null,
      supplierCampaign: {
        isJoined: true,
        participationStatus: "JOINED",
        defaultCommissionValue: null,
      },
    });
    assert.ok(isSourceEligible(src).reasons.includes("missing_commission"));
  });

  it("missing channel blocks eligibility", () => {
    const src = source({
      relationshipStatus: "JOINED",
      supportsLink: false,
      supportsCoupon: false,
      supplierCampaign: {
        isJoined: true,
        participationStatus: "JOINED",
        trackingUrl: null,
        destinationUrl: null,
        deepLinkingEnabled: false,
      },
    });
    assert.ok(isSourceEligible(src).reasons.includes("missing_tracking_or_coupon_capability"));
  });

  it("missing CampaignSource → UNAVAILABLE", () => {
    const result = eligibility.evaluate({
      mode: "assign",
      catalogCampaign: catalog,
      client,
      sources: [],
    });
    assert.equal(result.eligibilityStatus, "UNAVAILABLE");
  });
});
