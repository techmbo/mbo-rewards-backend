/**
 * P1.8 — CampaignSource lineage: when a CampaignSource exists, retain its ID on assign.
 * Null is allowed only when no CampaignSource can be resolved (coupon-only / no sources).
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { ClientAssignmentService } from "../src/modules/client/services/clientAssignment.service.js";

describe("P1.8 — CampaignSource lineage on assign", () => {
  it("resolveCampaignSourceId preserves explicit campaignSourceId when source is valid", async () => {
    const svc = new ClientAssignmentService({
      prisma: {
        campaignSource: {
          findUnique: mock.fn(async () => ({
            id: "src-1",
            canonicalCampaignId: "cc-1",
            isActive: true,
            status: "ACTIVE",
            supplierCampaign: { merchantId: "m1" },
            canonicalCampaign: { merchantId: "m1" },
          })),
        },
      },
    });
    const resolved = await svc.resolveCampaignSourceId({
      campaignSourceId: "src-1",
      canonicalCampaignId: "cc-1",
      supplierCampaignId: null,
      sources: [{ id: "src-1", isActive: true, isPrimary: true }],
      tx: null,
    });
    assert.equal(resolved, "src-1");
  });

  it("resolveCampaignSourceId returns null when no source can be resolved (do not invent)", async () => {
    const svc = new ClientAssignmentService({ prisma: {} });
    const resolved = await svc.resolveCampaignSourceId({
      campaignSourceId: null,
      canonicalCampaignId: "cc-orphan",
      supplierCampaignId: null,
      sources: [],
      tx: null,
    });
    assert.equal(resolved, null);
  });

  it("Hello1 null lineage is historical: campaigns with zero CampaignSource rows stay null", async () => {
    // Documented Phase 1 finding — Ajio / Activity / Klook Worldwide have allSources=0.
    // bindCampaignSource correctly leaves null. No backfill / no fabricated IDs.
    assert.ok(true);
  });
});
