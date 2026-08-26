import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { CommercialService } from "../src/modules/commercial/services/commercial.service.js";

describe("CommercialService", () => {
  it("rejects client commission greater than gross commission", () => {
    const service = new CommercialService();
    assert.throws(
      () => service.validateCommissionSplit("5.0000", "6.0000"),
      (error) => error.statusCode === 400,
    );
  });

  it("creates tracking link for published active assignment", async () => {
    const assignmentRepo = {
      findById: mock.fn(async () => ({
        id: "a1",
        status: "ACTIVE",
        published: true,
        canonicalCampaignId: "cc1",
      })),
    };
    const trackingRepo = {
      clearPrimaryForAssignment: mock.fn(async () => ({})),
      create: mock.fn(async (data) => ({ id: "tl1", ...data })),
    };
    const sourceRepo = { findById: mock.fn(async () => null) };

    const service = new CommercialService({ assignmentRepo, trackingRepo, sourceRepo });
    service.resolveSupplierTrackingDefaults = mock.fn(async () => ({
      supplierTrackingUrl: "https://supplier.example/track",
    }));

    const link = await service.createTrackingLink(
      {
        assignmentId: "a1",
        slug: "acme-ubuy",
        isPrimary: true,
      },
      {},
    );

    assert.equal(link.assignmentId, "a1");
    assert.equal(link.isPrimary, true);
    assert.equal(link.slug, "acme-ubuy");
    assert.ok(link.subId);
    assert.match(link.mboTrackingUrl, /\/r\/acme-ubuy\//);
  });

  it("regenerates token in place while preserving slug", async () => {
    const trackingRepo = {
      findById: mock.fn(async () => ({
        id: "tl1",
        assignmentId: "a1",
        slug: "acme-ubuy",
        subId: "OLDTOKEN1",
        mboTrackingUrl: "https://go.example/r/acme-ubuy/OLDTOKEN1",
        status: "ACTIVE",
        deletedAt: null,
      })),
      update: mock.fn(async (id, data) => ({ id, ...data })),
    };
    const service = new CommercialService({ trackingRepo });
    const updated = await service.regenerateTrackingToken("tl1");
    assert.equal(updated.slug, "acme-ubuy");
    assert.notEqual(updated.subId, "OLDTOKEN1");
    assert.match(updated.mboTrackingUrl, /\/r\/acme-ubuy\//);
  });

  it("rejects commercial operations on draft assignments", async () => {
    const assignmentRepo = {
      findById: mock.fn(async () => ({
        id: "a1",
        status: "ASSIGNED",
        published: false,
      })),
    };
    const service = new CommercialService({ assignmentRepo });

    await assert.rejects(
      () =>
        service.createCommissionRule({
          assignmentId: "a1",
          grossCommission: "10",
          clientCommission: "5",
        }),
      (error) => error.statusCode === 409,
    );
  });

  it("creates tracking link for unpublished review drafts", async () => {
    const assignmentRepo = {
      findById: mock.fn(async () => ({
        id: "a1",
        status: "ASSIGNED",
        published: false,
        canonicalCampaignId: "cc1",
        client: { slug: "thecosmicstack" },
        campaignSource: {
          supplierCampaign: {
            campaignName: "CPS",
            mboTrackingSlug: "mothercare",
            mboTrackingToken: "ABC23456",
            merchant: { displayName: "Mothercare" },
          },
        },
        canonicalCampaign: { displayName: "CPS", merchant: { displayName: "Mothercare" } },
      })),
    };
    const trackingRepo = {
      clearPrimaryForAssignment: mock.fn(async () => ({})),
      create: mock.fn(async (data) => ({ id: "tl1", ...data })),
    };
    const sourceRepo = { findById: mock.fn(async () => null) };

    const service = new CommercialService({ assignmentRepo, trackingRepo, sourceRepo });
    service.resolveSupplierTrackingDefaults = mock.fn(async () => ({
      supplierTrackingUrl: "https://prf.hn/click/?camref=1100",
    }));

    const link = await service.createTrackingLink(
      {
        assignmentId: "a1",
        isPrimary: true,
      },
      {},
    );

    assert.equal(link.slug, "mothercare-thecosmicstack");
    assert.match(link.mboTrackingUrl, /\/r\/mothercare-thecosmicstack\/ABC23456$/);
  });
});
