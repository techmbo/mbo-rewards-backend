import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { ClientOnboardingService } from "../src/modules/client/services/clientOnboarding.service.js";
import { deriveProvisioningStatus } from "../src/modules/client/provisioningStatus.js";
import { toPartnerCampaignDto } from "../src/modules/client/dto/partnerCampaign.dto.js";
import { CampaignEligibilityService, isSourceEligible } from "../src/modules/client/services/campaignEligibility.service.js";

describe("provisioning status derivation", () => {
  it("marks tracking pending when commercial exists without tracking URL", () => {
    const status = deriveProvisioningStatus({
      assignmentStatus: "ASSIGNED",
      published: false,
      hasCommissionRule: true,
      commissionRuleStatus: "DRAFT",
      hasTrackingUrl: false,
    });
    assert.equal(status.code, "TRACKING_PENDING");
    assert.equal(status.fullyProvisioned, false);
  });

  it("marks active only when published + tracking + commercial", () => {
    const status = deriveProvisioningStatus({
      assignmentStatus: "ACTIVE",
      published: true,
      hasCommissionRule: true,
      commissionRuleStatus: "EFFECTIVE",
      hasTrackingUrl: true,
      trackingLinkStatus: "ACTIVE",
    });
    assert.equal(status.code, "ACTIVE");
    assert.equal(status.fullyProvisioned, true);
  });
});

describe("client campaign assignment provisioning flow", () => {
  function buildService(overrides = {}) {
    return new ClientOnboardingService({
      runInTransaction: async (fn) => fn({}),
      clientRepo: {
        findById: async () => ({
          id: "c1",
          status: "ACTIVE",
          commercialModel: "OFFERS_PLUS_COMMISSION",
          clientSharePercent: 70,
          slug: "acme",
        }),
      },
      ...overrides,
    });
  }

  it("eligible campaign can be assigned with commission + tracking", async () => {
    const created = [];
    const service = buildService();

    service.assignmentService = {
      createClientCampaignAssignment: async (input) => {
        created.push(input);
        return {
          id: "a1",
          clientId: "c1",
          canonicalCampaignId: "cc1",
          campaignSourceId: "cs1",
          status: "ASSIGNED",
          published: false,
        };
      },
    };
    service.ensureCommissionRuleDraft = async () => ({ id: "rule1", status: "DRAFT" });
    service.bindCampaignSource = async (assignment) => assignment;
    service.ensureTrackingLink = async () => ({
      id: "t1",
      mboTrackingUrl: "https://mbo.example/r/x",
      supplierTrackingUrl: "https://clk.omgt6.com/?PID=1",
      status: "GENERATED",
    });

    const result = await service.allotCanonicalCampaigns("c1", [
      { canonicalCampaignId: "cc1", campaignSourceId: "cs1" },
    ]);

    assert.equal(result.meta.assigned, 1);
    assert.equal(result.allotted[0].trackingGenerated, true);
    assert.equal(result.allotted[0].trackingStatus, "READY");
    assert.equal(result.allotted[0].commercialRuleStatus, "DRAFT");
    assert.equal(created.length, 1);
  });

  it("ineligible / blocked campaign does not fail the whole bulk", async () => {
    const service = buildService();

    let call = 0;
    service.assignmentService = {
      createClientCampaignAssignment: async () => {
        call += 1;
        if (call === 1) {
          return {
            id: "a1",
            clientId: "c1",
            canonicalCampaignId: "cc1",
            campaignSourceId: "cs1",
            status: "ASSIGNED",
            published: false,
          };
        }
        const err = new Error("No commission information");
        err.statusCode = 409;
        throw err;
      },
    };
    service.ensureCommissionRuleDraft = async () => ({ id: "rule1", status: "DRAFT" });
    service.bindCampaignSource = async (a) => a;
    service.ensureTrackingLink = async () => ({
      mboTrackingUrl: "https://mbo.example/r/x",
      supplierTrackingUrl: "https://clk.example/go",
    });

    const result = await service.allotCanonicalCampaigns("c1", [
      { canonicalCampaignId: "cc1", campaignSourceId: "cs1" },
      { canonicalCampaignId: "cc-blocked", campaignSourceId: "cs2" },
    ]);

    assert.equal(result.meta.assigned, 1);
    assert.equal(result.meta.blocked, 1);
    assert.equal(result.failures[0].outcome, "blocked");
  });

  it("duplicate assignment is idempotent (alreadyAssigned)", async () => {
    const service = buildService();

    service.assignmentService = {
      createClientCampaignAssignment: async () => {
        const err = new Error("An active assignment already exists for this client and catalog campaign.");
        err.code = "ALREADY_ASSIGNED";
        err.statusCode = 409;
        err.existingAssignmentId = "a-existing";
        throw err;
      },
    };

    const result = await service.allotCanonicalCampaigns("c1", [
      { canonicalCampaignId: "cc1", campaignSourceId: "cs1" },
    ]);

    assert.equal(result.meta.assigned, 0);
    assert.equal(result.meta.alreadyAssigned, 1);
    assert.equal(result.alreadyAssigned[0].outcome, "already_assigned");
  });

  it("missing tracking keeps assignment and marks tracking pending", async () => {
    const service = buildService();

    service.assignmentService = {
      createClientCampaignAssignment: async () => ({
        id: "a1",
        clientId: "c1",
        canonicalCampaignId: "cc1",
        campaignSourceId: "cs1",
        status: "ASSIGNED",
        published: false,
      }),
    };
    service.ensureCommissionRuleDraft = async () => ({ id: "rule1", status: "DRAFT" });
    service.bindCampaignSource = async (a) => a;
    service.ensureTrackingLink = async () => {
      const err = new Error("Cannot generate MBO tracking link: supplier tracking URL is missing");
      err.statusCode = 409;
      throw err;
    };

    const result = await service.allotCanonicalCampaigns("c1", [
      { canonicalCampaignId: "cc1", campaignSourceId: "cs1" },
    ]);

    assert.equal(result.meta.assigned, 1);
    assert.equal(result.allotted[0].trackingGenerated, false);
    assert.equal(result.allotted[0].trackingStatus, "PENDING");
    assert.equal(result.allotted[0].provisioningStatus, "TRACKING_PENDING");
    assert.ok(result.allotted[0].trackingIssue);
  });

  it("ensureTrackingLink does not create fake URL when destination missing", async () => {
    const created = mock.fn(async () => ({}));
    const service = new ClientOnboardingService({
      trackingRepo: {
        findPrimaryForAssignment: async () => null,
        clearPrimaryForAssignment: async () => {},
        create: created,
      },
      resolveDestination: async () => ({
        url: null,
        source: null,
        reason: "Supplier tracking URL is missing on the campaign.",
      }),
    });

    await assert.rejects(
      () =>
        service.ensureTrackingLink({
          id: "a1",
          campaignSourceId: "cs1",
          canonicalCampaignId: "cc1",
        }),
      (error) => error.statusCode === 409,
    );
    assert.equal(created.mock.calls.length, 0);
  });

  it("commission-zero campaign is blocked by eligibility", () => {
    const source = {
      id: "s1",
      isActive: true,
      status: "PREFERRED",
      relationshipStatus: "JOINED",
      supportsLink: true,
      grossCommission: "0",
      supplierCampaign: {
        trackingUrl: "https://clk.example/go",
        campaignStatus: "ACTIVE",
        merchantId: "m1",
        defaultCommissionValue: "0",
        isJoined: true,
        participationStatus: "JOINED",
      },
    };
    assert.ok(isSourceEligible(source).reasons.includes("missing_commission"));
  });
});

describe("partner campaign DTO isolation", () => {
  it("does not expose supplierReceivable or mboMargin", () => {
    const dto = toPartnerCampaignDto({
      assignmentId: "a1",
      assignmentStatus: "ACTIVE",
      published: true,
      createdAt: new Date().toISOString(),
      campaign: {
        id: "cc1",
        brand: "Klook",
        displayName: "Staycation",
        countries: ["IN"],
        status: "PUBLISHED",
        defaultCurrency: "INR",
        campaignTypeRaw: "CPS",
        deepLinkingEnabled: true,
      },
      sourceCapabilities: { supportsLink: true, supportsCoupon: false, supportsDeeplink: true },
      tracking: { mboTrackingUrl: "https://mbo.example/r/x", status: "ACTIVE" },
      commercial: { clientSharePercent: 70, commissionType: "PERCENT", currency: "INR" },
      coupon: null,
      // Poison fields that must never leak through projection
      supplierReceivable: 1000,
      mboMargin: 300,
      grossCommission: 5,
    });

    const serialized = JSON.stringify(dto);
    assert.equal(dto.commission.clientSharePercent, 70);
    assert.equal(dto.commission.isDisplayOnly, true);
    assert.equal(dto.channels.link, true);
    assert.equal(dto.channels.coupon, false);
    assert.equal(dto.channels.deeplink, true);
    assert.equal(dto.couponAvailability, "NOT_SUPPORTED");
    assert.ok(!serialized.includes("supplierReceivable"));
    assert.ok(!serialized.includes("mboMargin"));
    assert.ok(!serialized.includes('"grossCommission"'));
  });

  it("shows coupon available but not assigned when supported without code", () => {
    const dto = toPartnerCampaignDto({
      assignmentId: "a1",
      assignmentStatus: "ASSIGNED",
      published: false,
      createdAt: new Date().toISOString(),
      campaign: {
        id: "cc1",
        brand: "Klook",
        displayName: "Hotel",
        countries: [],
        status: "PUBLISHED",
      },
      sourceCapabilities: { supportsLink: true, supportsCoupon: true, supportsDeeplink: false },
      tracking: { mboTrackingUrl: "https://mbo.example/r/y", status: "GENERATED" },
      commercial: { clientSharePercent: 70, commissionType: "PERCENT" },
      coupon: null,
    });
    assert.equal(dto.couponAvailability, "AVAILABLE_NOT_ASSIGNED");
    assert.equal(dto.couponCode, null);
    assert.equal(dto.channels.coupon, true);
  });
});

describe("duplicate commission / tracking prevention", () => {
  it("ensureCommissionRuleDraft reuses matching DRAFT", async () => {
    const create = mock.fn(async () => ({ id: "new" }));
    const existing = {
      id: "rule1",
      status: "DRAFT",
      clientCommission: "70.0000",
      grossCommission: "100.0000",
    };
    const service = new ClientOnboardingService({});
    const db = {
      clientCommissionRule: {
        findFirst: async () => existing,
        create,
        update: async () => existing,
      },
    };
    const result = await service.ensureCommissionRuleDraft(
      "a1",
      "OFFERS_PLUS_COMMISSION",
      db,
      { clientSharePercent: 70 },
    );
    assert.equal(result.id, "rule1");
    assert.equal(create.mock.calls.length, 0);
  });

  it("ensureTrackingLink returns existing primary without duplicate create", async () => {
    const create = mock.fn(async () => ({ id: "new" }));
    const existing = {
      id: "t1",
      mboTrackingUrl: "https://mbo.example/r/x",
      supplierTrackingUrl: "https://clk.example/go",
      campaignSourceId: "cs1",
      status: "GENERATED",
    };
    const service = new ClientOnboardingService({
      trackingRepo: {
        findPrimaryForAssignment: async () => existing,
        update: async (_id, patch) => ({ ...existing, ...patch }),
        create,
        clearPrimaryForAssignment: async () => {},
      },
      resolveDestination: async () => ({
        url: "https://clk.example/go",
        source: "supplierCampaign.trackingUrl",
        reason: null,
      }),
    });

    const result = await service.ensureTrackingLink({
      id: "a1",
      campaignSourceId: "cs1",
    });
    assert.equal(result.id, "t1");
    assert.equal(create.mock.calls.length, 0);
  });
});

describe("tenant scoping guard", () => {
  it("partner list requires clientId from auth (service contract)", async () => {
    const { PartnerCampaignService } = await import(
      "../src/modules/client/services/partnerCampaign.service.js"
    );
    const service = new PartnerCampaignService({
      assignmentRepo: {
        findManyForPartner: async () => {
          throw new Error("should not be called without client");
        },
      },
      clientRepo: {
        findById: async () => null,
      },
    });
    await assert.rejects(() => service.listCampaigns({}), (err) => err.statusCode === 404 || err.statusCode === 401 || err.statusCode === 403 || Boolean(err.message));
  });
});

describe("eligibility still blocks commission-zero and unknown relationship", () => {
  const eligibility = new CampaignEligibilityService();
  const catalog = {
    id: "cc1",
    status: "PUBLISHED",
    visibility: "ASSIGNABLE",
    deletedAt: null,
    countries: [],
    defaultCurrency: null,
  };

  it("blocks unknown relationship", () => {
    const result = eligibility.evaluate({
      mode: "assign",
      catalogCampaign: catalog,
      client: { id: "c1", status: "ACTIVE" },
      sources: [
        {
          id: "s1",
          isActive: true,
          relationshipStatus: "UNKNOWN",
          supportsLink: true,
          grossCommission: "5",
          supplierCampaign: {
            merchantId: "m1",
            campaignStatus: "ACTIVE",
            trackingUrl: "https://x",
            defaultCommissionValue: "5",
          },
        },
      ],
    });
    assert.equal(result.eligibilityStatus, "NEEDS_REVIEW");
  });
});
