import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { ClientAssignmentService } from "../src/modules/client/services/clientAssignment.service.js";

describe("ClientAssignmentService", () => {
  it("prevents duplicate active assignments", async () => {
    const assignmentRepo = {
      findActiveByPair: mock.fn(async () => ({ id: "existing" })),
      create: mock.fn(async () => ({})),
    };
    const clientRepo = {
      findById: mock.fn(async () => ({ id: "c1", status: "ACTIVE" })),
    };
    const catalogRepo = {
      findById: mock.fn(async () => ({
        id: "cc1",
        status: "PUBLISHED",
        visibility: "ASSIGNABLE",
        deletedAt: null,
      })),
    };

    const service = new ClientAssignmentService({ assignmentRepo, clientRepo, catalogRepo });

    await assert.rejects(
      () => service.createDraft({ clientId: "c1", canonicalCampaignId: "cc1" }),
      (error) => error.statusCode === 409,
    );
  });

  it("prevents assigning hidden catalog campaigns", async () => {
    const assignmentRepo = {
      findActiveByPair: mock.fn(async () => null),
      create: mock.fn(async () => ({})),
    };
    const clientRepo = {
      findById: mock.fn(async () => ({ id: "c1", status: "ACTIVE" })),
    };
    const catalogRepo = {
      findById: mock.fn(async () => ({
        id: "cc1",
        status: "PUBLISHED",
        visibility: "HIDDEN",
        deletedAt: null,
      })),
    };

    const service = new ClientAssignmentService({ assignmentRepo, clientRepo, catalogRepo });

    await assert.rejects(
      () => service.createDraft({ clientId: "c1", canonicalCampaignId: "cc1" }),
      (error) => error.statusCode === 409,
    );
  });

  it("allots Coupon CMS entities without requiring a supplier campaign", async () => {
    const entity = {
      id: "entity-1",
      entityType: "coupon",
      campaignName: "Ajio.com Ecommerce CPS - India",
      advertiserName: "Ajio.com",
      normalizedData: { brand_name: "Ajio.com", link: "https://ajio.example/offer" },
      rawData: { link: "https://ajio.example/offer" },
    };

    const assignmentRepo = {
      findActiveByPair: mock.fn(async () => null),
      create: mock.fn(async (data) => ({ id: "a1", ...data })),
    };
    const clientRepo = {
      findById: mock.fn(async () => ({ id: "c1", status: "PROSPECT" })),
    };
    const catalogRepo = {
      findById: mock.fn(async () => ({
        id: "cc-cms",
        status: "PUBLISHED",
        visibility: "ASSIGNABLE",
        deletedAt: null,
      })),
    };
    const catalogService = {
      ensureFromCouponCmsEntity: mock.fn(async () => "cc-cms"),
    };
    const couponAssignmentRepo = {
      create: mock.fn(async (data) => ({ id: "ca1", ...data })),
    };

    const service = new ClientAssignmentService({
      assignmentRepo,
      clientRepo,
      catalogRepo,
      catalogService,
      couponAssignmentRepo,
    });

    service.loadCouponCms = mock.fn(async () => ({
      entity,
      supplierCoupon: null,
      supplierCampaignId: null,
    }));

    // Pass a tx stub so createDraft does not open a real Prisma transaction.
    const created = await service.createDraft(
      {
        clientId: "c1",
        couponEntityId: "entity-1",
      },
      {},
    );

    assert.equal(created.canonicalCampaignId, "cc-cms");
    assert.equal(catalogService.ensureFromCouponCmsEntity.mock.calls.length, 1);
    assert.equal(couponAssignmentRepo.create.mock.calls.length, 1);
  });

  it("publishes draft assignments when catalog is publishable", async () => {
    const assignment = {
      id: "a1",
      status: "ASSIGNED",
      published: false,
      canonicalCampaignId: "cc1",
      client: { id: "c1", status: "ACTIVE", deletedAt: null, country: null, currency: null },
      canonicalCampaign: {
        id: "cc1",
        status: "PUBLISHED",
        visibility: "ASSIGNABLE",
        deletedAt: null,
        countries: [],
        defaultCurrency: null,
      },
    };

    const assignmentRepo = {
      findById: mock.fn(async () => assignment),
      update: mock.fn(async (_id, data) => ({ ...assignment, ...data })),
    };

    const service = new ClientAssignmentService({
      assignmentRepo,
      commissionRepo: {
        findEffectiveForAssignment: mock.fn(async () => ({
          id: "rule1",
          status: "EFFECTIVE",
          grossCommission: "100",
          clientCommission: "70",
        })),
      },
      prisma: {
        campaignSource: { findMany: mock.fn(async () => []) },
        clientCouponAssignment: { count: mock.fn(async () => 1) },
        trackingLink: {
          findFirst: mock.fn(async () => ({
            id: "tl1",
            supplierTrackingUrl: "https://supplier.example/go",
            mboTrackingUrl: "https://go.mbo/r/x/y",
          })),
        },
      },
    });
    const result = await service.publish("a1");

    assert.equal(result.published, true);
    assert.equal(result.status, "ACTIVE");
    assert.ok(result.publishedAt);
  });
});
