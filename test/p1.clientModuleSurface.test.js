/**
 * P1 — Admin Client Module surface: opsSummary, activation blockers, no fake data paths.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  toClientSummaryDto,
} from "../src/modules/client/dto/client.dto.js";
import {
  isClientCampaignVisible,
  explainClientVisibilityBlock,
} from "../src/modules/client/assignmentVisibilityTruth.js";
import { COMMERCIAL_MODELS } from "../src/modules/client/constants/commercialModels.js";

describe("P1 client summary opsSummary provenance", () => {
  it("summary DTO carries opsSummary when attached by query service", () => {
    const dto = toClientSummaryDto({
      id: "c1",
      name: "Acme",
      slug: "acme",
      status: "PROSPECT",
      country: "IN",
      currency: "INR",
      commercialModel: "OFFERS_PLUS_COMMISSION",
      clientSharePercent: 70,
      opsSummary: {
        assignedCount: 2,
        publishedCount: 1,
        apiAccess: "CONFIGURED",
        portalAccess: "NOT_CREATED",
        commercialConfigured: true,
        readyForActivation: false,
        activated: false,
      },
    });
    assert.equal(dto.currency, "INR");
    assert.equal(dto.opsSummary.assignedCount, 2);
    assert.equal(dto.opsSummary.publishedCount, 1);
    assert.equal(dto.opsSummary.apiAccess, "CONFIGURED");
    assert.equal(dto.opsSummary.portalAccess, "NOT_CREATED");
  });

  it("summary does not invent opsSummary when absent", () => {
    const dto = toClientSummaryDto({
      id: "c2",
      name: "Beta",
      slug: "beta",
      status: "PROSPECT",
    });
    assert.equal(dto.opsSummary, undefined);
  });
});

describe("P1 commercial models — workbook-backed only", () => {
  it("exposes OFFERS_ONLY and OFFERS_PLUS_COMMISSION only", () => {
    assert.equal(COMMERCIAL_MODELS.OFFERS_ONLY, "OFFERS_ONLY");
    assert.equal(COMMERCIAL_MODELS.OFFERS_PLUS_COMMISSION, "OFFERS_PLUS_COMMISSION");
    assert.equal(Object.keys(COMMERCIAL_MODELS).includes("TIERED"), false);
  });
});

describe("P1 publication visibility truth (P0 seam preserved)", () => {
  it("assigned unpublished is not client-visible", () => {
    const assignment = {
      status: "ASSIGNED",
      published: false,
      trackingLinks: [],
      couponAssignments: [],
      commissionRules: [],
    };
    assert.equal(
      isClientCampaignVisible({ assignment, client: { status: "ACTIVE" } }),
      false,
    );
    const block = explainClientVisibilityBlock({
      assignment,
      client: { status: "ACTIVE" },
    });
    assert.equal(block, "not_published");
  });

  it("published ACTIVE is client-visible when client ACTIVE", () => {
    const assignment = {
      status: "ACTIVE",
      published: true,
      trackingLinks: [{ mboTrackingUrl: "https://go.example/r/x", status: "ACTIVE", deletedAt: null }],
      couponAssignments: [],
      commissionRules: [{ status: "EFFECTIVE" }],
    };
    assert.equal(
      isClientCampaignVisible({ assignment, client: { status: "ACTIVE" } }),
      true,
    );
  });
});
