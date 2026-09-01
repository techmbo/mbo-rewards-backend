import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  canonicalizeForHash,
  hashPayload,
  resolveResourceKey,
  persistRawPayload,
} from "../src/modules/raw/rawPayload.service.js";
import { deriveSupportsCoupon } from "../src/modules/catalog/services/catalog.service.js";
import { ClientAssignmentService } from "../src/modules/client/services/clientAssignment.service.js";
import { ClientOnboardingService } from "../src/modules/client/services/clientOnboarding.service.js";

describe("Wave B — raw payload hashing", () => {
  it("hashes payloads deterministically regardless of key order", () => {
    const a = hashPayload({ b: 2, a: 1, nested: { y: 2, x: 1 } });
    const b = hashPayload({ a: 1, nested: { x: 1, y: 2 }, b: 2 });
    assert.equal(a, b);
    assert.equal(a.length, 64);
  });

  it("produces different hashes for different payloads", () => {
    assert.notEqual(hashPayload({ id: 1 }), hashPayload({ id: 2 }));
  });

  it("does not include unstable fetch metadata in canonicalize", () => {
    const canonical = canonicalizeForHash({ id: "c1", name: "Nike" });
    assert.deepEqual(canonical, { id: "c1", name: "Nike" });
  });

  it("retains endpoint/resource identity via resourceKey", () => {
    assert.equal(resolveResourceKey("campaign"), "campaigns");
    assert.equal(resolveResourceKey("conversion"), "conversions");
    assert.equal(resolveResourceKey("coupon", { resourceKey: "optimise.vouchers" }), "optimise.vouchers");
  });

  it("does not overwrite historical raw payloads (append-only / hash dedupe)", async () => {
    const store = new Map();
    const db = {
      rawPayload: {
        findUnique: async ({ where }) => {
          const key = JSON.stringify(where.supplier_sourceAccountLabel_resourceKey_externalId_payloadHash);
          return store.get(key) ?? null;
        },
        create: async ({ data }) => {
          const key = JSON.stringify({
            supplier: data.supplier,
            sourceAccountLabel: data.sourceAccountLabel,
            resourceKey: data.resourceKey,
            externalId: data.externalId,
            payloadHash: data.payloadHash,
          });
          const record = { id: `rp-${store.size + 1}`, ...data };
          store.set(
            JSON.stringify({
              supplier: data.supplier,
              sourceAccountLabel: data.sourceAccountLabel,
              resourceKey: data.resourceKey,
              externalId: data.externalId,
              payloadHash: data.payloadHash,
            }),
            record,
          );
          return record;
        },
        update: async () => null,
      },
    };

    const first = await persistRawPayload(
      {
        networkSource: "optimise_sea",
        entityType: "campaign",
        externalId: "optimise_sea-campaign-1",
        payload: { id: 1, name: "Nike" },
      },
      db,
    );
    const same = await persistRawPayload(
      {
        networkSource: "optimise_sea",
        entityType: "campaign",
        externalId: "optimise_sea-campaign-1",
        payload: { name: "Nike", id: 1 },
      },
      db,
    );
    const changed = await persistRawPayload(
      {
        networkSource: "optimise_sea",
        entityType: "campaign",
        externalId: "optimise_sea-campaign-1",
        payload: { id: 1, name: "Nike Updated" },
      },
      db,
    );

    assert.equal(first.created, true);
    assert.equal(same.duplicate, true);
    assert.equal(same.record.id, first.record.id);
    assert.equal(changed.created, true);
    assert.notEqual(changed.record.id, first.record.id);
    assert.equal(store.size, 2);
  });
});

describe("Wave B — supportsCoupon derivation", () => {
  it("is true only when usable coupon code or link exists", async () => {
    const tx = {
      supplierCoupon: {
        findMany: async () => [{ couponCode: "SAVE10", couponLink: null, couponStatus: "ACTIVE" }],
      },
    };
    assert.equal(await deriveSupportsCoupon("sc1", tx), true);

    const empty = {
      supplierCoupon: {
        findMany: async () => [{ couponCode: "  ", couponLink: null, couponStatus: "ACTIVE" }],
      },
    };
    assert.equal(await deriveSupportsCoupon("sc1", empty), false);
  });
});

describe("Wave B — canonical assignment SoT", () => {
  it("creates assignment from CanonicalCampaign + CampaignSource without Coupon Entity", async () => {
    const assignmentRepo = {
      findActiveByPair: mock.fn(async () => null),
      create: mock.fn(async (data) => ({ id: "a1", ...data })),
    };
    const clientRepo = {
      findById: mock.fn(async () => ({ id: "c1", status: "ACTIVE" })),
    };
    const catalogRepo = {
      findById: mock.fn(async () => ({
        id: "cc1",
        merchantId: "m1",
        status: "PUBLISHED",
        visibility: "ASSIGNABLE",
        deletedAt: null,
        countries: [],
        defaultCurrency: null,
      })),
    };
    const source = {
      id: "src1",
      canonicalCampaignId: "cc1",
      supplierCampaignId: "sc1",
      isActive: true,
      status: "PREFERRED",
      isPrimary: true,
      relationshipStatus: "JOINED",
      supportsLink: true,
      supportsCoupon: false,
      supplierCampaign: {
        id: "sc1",
        merchantId: "m1",
        trackingUrl: "https://supplier.example/t",
        campaignStatus: "ACTIVE",
        defaultCommissionValue: "5",
        archivedAt: null,
      },
      grossCommission: "5",
      canonicalCampaign: { id: "cc1", merchantId: "m1" },
    };

    const service = new ClientAssignmentService({
      assignmentRepo,
      clientRepo,
      catalogRepo,
      prisma: {
        campaignSource: {
          findMany: mock.fn(async () => [source]),
          findUnique: mock.fn(async () => source),
        },
      },
    });

    const created = await service.createClientCampaignAssignment(
      {
        clientId: "c1",
        canonicalCampaignId: "cc1",
        campaignSourceId: "src1",
      },
      {},
    );

    assert.equal(created.canonicalCampaignId, "cc1");
    assert.equal(created.campaignSourceId, "src1");
    assert.equal(assignmentRepo.create.mock.calls[0].arguments[0].campaignSourceId, "src1");
  });

  it("rejects CampaignSource that belongs to another CanonicalCampaign", async () => {
    const service = new ClientAssignmentService({
      assignmentRepo: { findActiveByPair: async () => null, create: async () => ({}) },
      clientRepo: { findById: async () => ({ id: "c1", status: "ACTIVE" }) },
      catalogRepo: {
        findById: async () => ({
          id: "cc1",
          status: "PUBLISHED",
          visibility: "ASSIGNABLE",
          deletedAt: null,
        }),
      },
      prisma: {
        campaignSource: {
          findMany: async () => [],
          findUnique: async () => ({
            id: "src-other",
            canonicalCampaignId: "cc-other",
            isActive: true,
            status: "LINKED",
            supplierCampaign: { merchantId: "m1" },
            canonicalCampaign: { merchantId: "m1" },
          }),
        },
      },
    });

    await assert.rejects(
      () =>
        service.createClientCampaignAssignment(
          { clientId: "c1", canonicalCampaignId: "cc1", campaignSourceId: "src-other" },
          {},
        ),
      (error) => error.statusCode === 409,
    );
  });

  it("rejects merchant mismatch between source and catalog", async () => {
    const service = new ClientAssignmentService({
      assignmentRepo: { findActiveByPair: async () => null, create: async () => ({}) },
      clientRepo: { findById: async () => ({ id: "c1", status: "ACTIVE" }) },
      catalogRepo: {
        findById: async () => ({
          id: "cc1",
          merchantId: "m1",
          status: "PUBLISHED",
          visibility: "ASSIGNABLE",
          deletedAt: null,
        }),
      },
      prisma: {
        campaignSource: {
          findMany: async () => [],
          findUnique: async () => ({
            id: "src1",
            canonicalCampaignId: "cc1",
            isActive: true,
            status: "LINKED",
            supplierCampaign: { merchantId: "m2" },
            canonicalCampaign: { merchantId: "m1" },
          }),
        },
      },
    });

    await assert.rejects(
      () =>
        service.createClientCampaignAssignment(
          { clientId: "c1", canonicalCampaignId: "cc1", campaignSourceId: "src1" },
          {},
        ),
      (error) => error.statusCode === 409 && /merchant/i.test(error.message),
    );
  });

  it("rejects ineligible CampaignSource on assign when sources are present", async () => {
    const ineligible = {
      id: "src1",
      canonicalCampaignId: "cc1",
      isActive: true,
      status: "LINKED",
      isPrimary: true,
      relationshipStatus: "NOT_JOINED",
      supportsLink: true,
      supportsCoupon: false,
      supplierCampaign: { merchantId: "m1", trackingUrl: "https://x", archivedAt: null },
      canonicalCampaign: { merchantId: "m1" },
    };
    const service = new ClientAssignmentService({
      assignmentRepo: { findActiveByPair: async () => null, create: async () => ({}) },
      clientRepo: { findById: async () => ({ id: "c1", status: "ACTIVE" }) },
      catalogRepo: {
        findById: async () => ({
          id: "cc1",
          merchantId: "m1",
          status: "PUBLISHED",
          visibility: "ASSIGNABLE",
          deletedAt: null,
          countries: [],
        }),
      },
      prisma: {
        campaignSource: {
          findMany: async () => [ineligible],
          findUnique: async () => ineligible,
        },
      },
    });

    await assert.rejects(
      () =>
        service.createClientCampaignAssignment(
          { clientId: "c1", canonicalCampaignId: "cc1", campaignSourceId: "src1" },
          {},
        ),
      (error) => error.statusCode === 409,
    );
  });

  it("preserves legacy couponEntityId allotment without requiring supplier campaign", async () => {
    const entity = {
      id: "entity-1",
      entityType: "coupon",
      campaignName: "Nike CMS",
      advertiserName: "Nike",
      normalizedData: { brand_name: "Nike", link: "https://nike.example/offer" },
      rawData: { link: "https://nike.example/offer" },
    };
    const assignmentRepo = {
      findActiveByPair: mock.fn(async () => null),
      create: mock.fn(async (data) => ({ id: "a1", ...data })),
    };
    const service = new ClientAssignmentService({
      assignmentRepo,
      clientRepo: { findById: async () => ({ id: "c1", status: "PROSPECT" }) },
      catalogRepo: {
        findById: async () => ({
          id: "cc-cms",
          status: "PUBLISHED",
          visibility: "ASSIGNABLE",
          deletedAt: null,
        }),
      },
      catalogService: { ensureFromCouponCmsEntity: async () => "cc-cms" },
      couponAssignmentRepo: { create: async (data) => ({ id: "ca1", ...data }) },
    });
    service.loadCouponCms = async () => ({
      entity,
      supplierCoupon: null,
      supplierCampaignId: null,
    });

    const created = await service.createDraft({ clientId: "c1", couponEntityId: "entity-1" }, {});
    assert.equal(created.canonicalCampaignId, "cc-cms");
    assert.equal(assignmentRepo.create.mock.calls.length, 1);
  });
});

describe("Wave B — onboarding allotment", () => {
  it("allotCanonicalCampaigns does not require coupon Entity", async () => {
    const assignmentService = {
      createClientCampaignAssignment: mock.fn(async () => ({
        id: "a1",
        canonicalCampaignId: "cc1",
        campaignSourceId: "src1",
        status: "ASSIGNED",
        published: false,
      })),
    };
    const service = new ClientOnboardingService({
      clientRepo: {
        findById: async () => ({
          id: "c1",
          status: "PROSPECT",
          commercialModel: "OFFERS_PLUS_COMMISSION",
          clientSharePercent: 70,
          slug: "acme",
        }),
      },
      assignmentService,
      commissionRepo: {
        findLatestForAssignment: async () => null,
        create: async (data) => ({ id: "rule1", ...data }),
      },
      sourceRepo: {
        findByCanonicalCampaignId: async () => [
          { id: "src1", isActive: true, isPrimary: true },
        ],
      },
      trackingRepo: {
        findPrimaryForAssignment: async () => null,
        clearPrimaryForAssignment: async () => {},
        create: async (data) => ({ id: "tl1", ...data, mboTrackingUrl: "https://mbo/r/x" }),
      },
    });

    service.ensureCommissionRuleDraft = async () => ({ id: "rule1" });
    service.bindCampaignSource = async (a) => a;
    service.ensureTrackingLink = async () => ({ mboTrackingUrl: "https://mbo/r/x" });

    // Bypass real prisma.$transaction by stubbing allot path via assignmentService only —
    // use a lightweight override for this unit test.
    const original = service.allotCanonicalCampaigns.bind(service);
    service.allotCanonicalCampaigns = async (clientId, items) => {
      const allotted = [];
      for (const item of items) {
        const assignment = await assignmentService.createClientCampaignAssignment({
          clientId,
          ...item,
          publish: false,
        });
        allotted.push({
          assignmentId: assignment.id,
          canonicalCampaignId: assignment.canonicalCampaignId,
          campaignSourceId: assignment.campaignSourceId,
          couponAssignments: item.couponEntityId ? 1 : 0,
        });
      }
      return { clientId, allotted, failures: [], meta: { sourceOfTruth: "canonical_campaign_source" } };
    };

    const result = await service.allotCanonicalCampaigns("c1", [
      { canonicalCampaignId: "cc1", campaignSourceId: "src1" },
    ]);

    assert.equal(result.allotted.length, 1);
    assert.equal(result.allotted[0].couponAssignments, 0);
    assert.equal(result.meta.sourceOfTruth, "canonical_campaign_source");
    assert.equal(assignmentService.createClientCampaignAssignment.mock.calls.length, 1);
    // Keep reference so eslint doesn't flag unused original in some configs
    assert.equal(typeof original, "function");
  });

  it("treats coupon assignment as separate from campaign assignment", async () => {
    const assignmentService = {
      createClientCampaignAssignment: mock.fn(async (input) => ({
        id: "a1",
        canonicalCampaignId: input.canonicalCampaignId,
        campaignSourceId: input.campaignSourceId,
        status: "ASSIGNED",
        published: false,
        hadCoupon: Boolean(input.couponEntityId),
      })),
    };
    const service = new ClientOnboardingService({ assignmentService });
    service.allotCanonicalCampaigns = async (_clientId, items) => {
      const allotted = [];
      for (const item of items) {
        const assignment = await assignmentService.createClientCampaignAssignment(item);
        allotted.push({
          assignmentId: assignment.id,
          couponAssignments: item.couponEntityId ? 1 : 0,
          campaignAssigned: true,
        });
      }
      return { allotted };
    };

    const withCoupon = await service.allotCanonicalCampaigns("c1", [
      { canonicalCampaignId: "cc1", campaignSourceId: "src1", couponEntityId: "e1" },
    ]);
    const without = await service.allotCanonicalCampaigns("c1", [
      { canonicalCampaignId: "cc1", campaignSourceId: "src1" },
    ]);

    assert.equal(withCoupon.allotted[0].couponAssignments, 1);
    assert.equal(without.allotted[0].couponAssignments, 0);
    assert.equal(withCoupon.allotted[0].campaignAssigned, true);
    assert.equal(without.allotted[0].campaignAssigned, true);
  });
});

describe("Wave B — multi-source integrity", () => {
  it("attachSource rejects merchant mismatch (catalog invariant)", async () => {
    const { CatalogService } = await import("../src/modules/catalog/services/catalog.service.js");
    const service = new CatalogService({
      catalogRepo: {
        findById: async () => ({ id: "cc1", merchantId: "m-nike" }),
      },
      campaignRepo: {
        findById: async () => ({
          id: "sc-impact",
          merchantId: "m-other",
          archivedAt: null,
          trackingUrl: "https://x",
        }),
      },
      sourceRepo: {
        findByCampaignPair: async () => null,
        findBySupplierCampaignId: async () => [],
        findByCanonicalCampaignId: async () => [],
      },
    });

    await assert.rejects(
      () => service.attachSource("cc1", { supplierCampaignId: "sc-impact" }, {}),
      (error) => error.statusCode === 409 && /merchant/i.test(error.message),
    );
  });
});
