import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { resolveCommercialPreset } from "../src/modules/client/constants/commercialModels.js";
import { applyCommissionRuleToGross } from "../src/modules/reporting/attributionMath.js";
import { buildMboTrackingUrl } from "../src/modules/commercial/trackingUrl.js";
import { ClientOnboardingService } from "../src/modules/client/services/clientOnboarding.service.js";

describe("Commercial model presets", () => {
  it("maps Offers Only to 0/100 ratio bases", () => {
    const preset = resolveCommercialPreset("OFFERS_ONLY");
    assert.equal(preset.clientCommission, "0.0000");
    assert.equal(preset.grossCommission, "100.0000");
    const split = applyCommissionRuleToGross("50", preset);
    assert.equal(split.ok, true);
    assert.equal(split.clientCommission, "0.0000");
    assert.equal(split.mboCommission, "50.0000");
  });

  it("maps Offers + Commission to 70/30 ratio bases", () => {
    const preset = resolveCommercialPreset("OFFERS_PLUS_COMMISSION");
    assert.equal(preset.clientCommission, "70.0000");
    const split = applyCommissionRuleToGross("100", preset);
    assert.equal(split.ok, true);
    assert.equal(split.clientCommission, "70.0000");
    assert.equal(split.mboCommission, "30.0000");
  });

  it("allows custom Offers + Commission share", () => {
    const preset = resolveCommercialPreset("OFFERS_PLUS_COMMISSION", 55);
    assert.equal(preset.clientSharePercent, 55);
    assert.equal(preset.mboSharePercent, 45);
    assert.equal(preset.clientCommission, "55.0000");
    const split = applyCommissionRuleToGross("100", preset);
    assert.equal(split.ok, true);
    assert.equal(split.clientCommission, "55.0000");
    assert.equal(split.mboCommission, "45.0000");
  });
});

describe("Tracking URL generation", () => {
  it("builds MBO tracking URLs from slug and token", () => {
    const original = process.env.TRACKING_BASE_URL;
    process.env.TRACKING_BASE_URL = "https://go.mbo.international";
    const built = buildMboTrackingUrl({ slug: "nova-benefits-ajio-india", token: "7HF82KLM" });
    assert.equal(built.slug, "nova-benefits-ajio-india");
    assert.equal(built.subId, "7HF82KLM");
    assert.equal(
      built.mboTrackingUrl,
      "https://go.mbo.international/r/nova-benefits-ajio-india/7HF82KLM",
    );
    process.env.TRACKING_BASE_URL = original;
  });

  it("builds readable slugs from client and merchant parts", async () => {
    const { buildTrackingSlug } = await import("../src/modules/commercial/trackingUrl.js");
    assert.equal(
      buildTrackingSlug({
        clientSlug: "Nova Benefits",
        merchantSlug: "Ajio India",
      }),
      "nova-benefits-ajio-india",
    );
    assert.equal(
      buildTrackingSlug({
        clientSlug: "perksphere",
        merchantSlug: "airasia",
      }),
      "perksphere-airasia",
    );
  });
});

describe("ClientOnboardingService.ensureTrackingLink", () => {
  it("auto-creates a primary TrackingLink with supplier destination and does not duplicate", async () => {
    const created = [];
    const trackingRepo = {
      findPrimaryForAssignment: mock.fn(async () => created[0] || null),
      clearPrimaryForAssignment: mock.fn(async () => ({})),
      create: mock.fn(async (data) => {
        const row = { id: `tl-${created.length + 1}`, ...data };
        created.push(row);
        return row;
      }),
      update: mock.fn(async (id, data) => ({ id, ...data })),
    };

    const service = new ClientOnboardingService({
      trackingRepo,
      resolveDestination: mock.fn(async () => ({
        url: "https://track.vcommission.com/click?campaign_id=10364&pub_id=130062",
        source: "couponCms.trackingUrl",
        reason: null,
      })),
    });
    service.resolveTrackingSlug = mock.fn(async () => "nova-benefits-ajio-india");

    const assignment = { id: "a1", campaignSourceId: "cs1" };
    const first = await service.ensureTrackingLink(assignment, null, { couponEntityId: "entity-1" });
    const second = await service.ensureTrackingLink(assignment, null, { couponEntityId: "entity-1" });

    assert.equal(created.length, 1);
    assert.equal(first.id, second.id);
    assert.equal(first.slug, "nova-benefits-ajio-india");
    assert.equal(first.isPrimary, true);
    assert.equal(first.status, "GENERATED");
    assert.equal(
      first.supplierTrackingUrl,
      "https://track.vcommission.com/click?campaign_id=10364&pub_id=130062",
    );
    assert.match(first.mboTrackingUrl, /\/r\/nova-benefits-ajio-india\//);
  });

  it("backfills supplierTrackingUrl when an existing link is missing it", async () => {
    const existing = {
      id: "tl-old",
      assignmentId: "a1",
      supplierTrackingUrl: null,
      campaignSourceId: null,
      status: "GENERATED",
    };
    const trackingRepo = {
      findPrimaryForAssignment: mock.fn(async () => existing),
      update: mock.fn(async (id, data) => ({ ...existing, ...data })),
    };

    const service = new ClientOnboardingService({
      trackingRepo,
      resolveDestination: mock.fn(async () => ({
        url: "https://track.vcommission.com/click?campaign_id=1",
        source: "couponCms.trackingUrl",
        reason: null,
      })),
    });

    const updated = await service.ensureTrackingLink({ id: "a1" }, null, {
      couponEntityId: "entity-1",
    });
    assert.equal(updated.supplierTrackingUrl, "https://track.vcommission.com/click?campaign_id=1");
    assert.equal(trackingRepo.update.mock.calls.length, 1);
  });

  it("fails generation when Coupon CMS has no supplier tracking URL", async () => {
    const service = new ClientOnboardingService({
      trackingRepo: {
        findPrimaryForAssignment: mock.fn(async () => null),
      },
      resolveDestination: mock.fn(async () => ({
        url: null,
        source: null,
        reason: "Supplier tracking URL is missing for this campaign.",
      })),
    });

    await assert.rejects(
      () => service.ensureTrackingLink({ id: "a1" }),
      (error) => error.statusCode === 409 && /supplier tracking URL/i.test(error.message),
    );
  });
});

describe("ClientOnboardingService lifecycle guards", () => {
  it("refuses allotment without commercial model and keeps client inactive", async () => {
    const service = new ClientOnboardingService({
      clientRepo: {
        findById: mock.fn(async () => ({ id: "c1", status: "PROSPECT", commercialModel: null })),
      },
    });

    await assert.rejects(
      () => service.allotCouponCmsCampaigns("c1", ["coupon-1"]),
      (error) => error.statusCode === 409,
    );
  });

  it("refuses activation before provisioning", async () => {
    const service = new ClientOnboardingService({
      clientRepo: {
        findById: mock.fn(async () => ({
          id: "c1",
          status: "PROSPECT",
          commercialModel: "OFFERS_ONLY",
          name: "Acme",
          slug: "acme",
        })),
      },
      credentialService: {
        listPortalUsers: mock.fn(async () => [{ id: "u1", isActive: true }]),
        listApiCredentials: mock.fn(async () => []),
      },
      assignmentRepo: {
        findMany: mock.fn(async () => ({
          rows: [{ id: "a1", status: "ASSIGNED", published: false }],
        })),
      },
      trackingRepo: { findMany: mock.fn(async () => ({ rows: [] })) },
      couponRepo: { findMany: mock.fn(async () => ({ rows: [] })) },
      commissionRepo: { findMany: mock.fn(async () => ({ rows: [] })) },
    });

    // Patch loadAssignmentsWithCommercial via assignmentRepo path used in getState
    service.loadAssignmentsWithCommercial = mock.fn(async () => [
      { id: "a1", status: "ASSIGNED", published: false, couponAssignments: [], commissionRules: [], trackingLinks: [] },
    ]);

    await assert.rejects(() => service.activate("c1"), (error) => error.statusCode === 409);
  });
});
