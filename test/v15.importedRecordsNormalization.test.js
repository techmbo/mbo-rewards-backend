import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  buildPipelineStages,
  deriveImportedRecordStatuses,
  stripSensitivePayload,
  MAPPING_STATUS,
  SOURCE_STATUS,
} from "../src/modules/ops/importedRecords.contract.js";
import { asOptionalString } from "../src/modules/supplier/mappers/shared.js";
import { buildEventId } from "../src/modules/supplier/events/types.js";
import { CampaignNormalizationService } from "../src/modules/ops/campaignNormalization.service.js";
import { MATCH_OUTCOMES } from "../src/modules/merchant/constants.js";

describe("imported records contract", () => {
  it("does not mark MAPPED without CampaignSource evidence", () => {
    const status = deriveImportedRecordStatuses({
      entityType: "campaign",
      supplierCampaign: { id: "sc1", merchantId: "m1", merchantNameRaw: "Brand" },
      campaignSource: null,
    });
    assert.equal(status.mappingStatus, MAPPING_STATUS.NEEDS_REVIEW);
    assert.equal(status.issueCode, "CAMPAIGN_SOURCE_MISSING");
  });

  it("marks MAPPED only when supplier campaign and campaign source exist", () => {
    const status = deriveImportedRecordStatuses({
      entityType: "campaign",
      supplierCampaign: { id: "sc1", merchantId: "m1", merchantNameRaw: "Brand" },
      campaignSource: { id: "cs1" },
    });
    assert.equal(status.mappingStatus, MAPPING_STATUS.MAPPED);
    assert.equal(status.sourceStatus, SOURCE_STATUS.PROCESSED);
  });

  it("marks missing merchant identifier as needs review after promotion", () => {
    const status = deriveImportedRecordStatuses({
      entityType: "campaign",
      supplierCampaign: { id: "sc1", merchantId: null, merchantNameRaw: null },
    });
    assert.equal(status.mappingStatus, MAPPING_STATUS.NEEDS_REVIEW);
    assert.equal(status.issueCode, "MISSING_MERCHANT_IDENTIFIER");
  });

  it("surfaces open mapper errors as ERROR", () => {
    const status = deriveImportedRecordStatuses({
      entityType: "coupon",
      openMapperError: { errorCode: "MISSING_PARENT_CAMPAIGN", message: "parent missing" },
    });
    assert.equal(status.mappingStatus, MAPPING_STATUS.ERROR);
    assert.equal(status.sourceStatus, SOURCE_STATUS.FAILED);
    assert.equal(status.issue, "Missing parent campaign");
  });

  it("ignores resolved mapper errors when supplier campaign exists", () => {
    const status = deriveImportedRecordStatuses({
      entityType: "campaign",
      supplierCampaign: { id: "sc1", merchantNameRaw: "Tesco Bank", merchantId: "m1" },
      campaignSource: { id: "cs1" },
      openMapperError: null,
    });
    assert.equal(status.sourceStatus, SOURCE_STATUS.PROCESSED);
    assert.equal(status.mappingStatus, MAPPING_STATUS.MAPPED);
    assert.equal(status.issue, null);
  });

  it("marks performance as NOT_AVAILABLE for mapping", () => {
    const status = deriveImportedRecordStatuses({ entityType: "performance" });
    assert.equal(status.mappingStatus, MAPPING_STATUS.NOT_AVAILABLE);
  });

  it("builds pipeline stages from real join state", () => {
    const stages = buildPipelineStages({
      entityType: "campaign",
      supplierCampaign: { id: "sc1", merchantNameRaw: "Klook" },
      campaignSource: null,
      merchant: null,
      statuses: { issue: "Merchant match needs operator review" },
    });
    assert.equal(stages[0].state, "COMPLETED");
    assert.equal(stages.find((s) => s.key === "normalized").state, "COMPLETED");
    assert.equal(stages.find((s) => s.key === "available").state, "PENDING");
  });

  it("strips credentials from raw payload views", () => {
    const cleaned = stripSensitivePayload({
      name: "Campaign",
      api_key: "secret",
      token: "t",
      nested: { access_token: "x", ok: true },
    });
    assert.equal(cleaned.name, "Campaign");
    assert.equal(cleaned.api_key, undefined);
    assert.equal(cleaned.token, undefined);
    assert.equal(cleaned.nested.access_token, undefined);
    assert.equal(cleaned.nested.ok, true);
  });
});

describe("mapper field coercion", () => {
  it("coerces Optimise vertical objects to strings", () => {
    assert.equal(
      asOptionalString({ primary: "Retail - Grocery", secondary: "Food & Drink", additional: [] }),
      "Retail - Grocery",
    );
  });

  it("coerces Boostiny description objects to text", () => {
    assert.equal(
      asOptionalString({ description: "Hello brand", creatives: [], promotion: "<p>x</p>" }),
      "Hello brand",
    );
  });
});

describe("buildEventId", () => {
  it("accepts variadic parts used by OutboxWriter", () => {
    assert.equal(buildEventId("MapperFailed", "id-1", "uuid"), "MapperFailed:id-1:uuid");
  });
});

describe("CampaignNormalizationService", () => {
  it("does not catalog-link when merchant needs review", async () => {
    const catalogService = {
      ensureFromSupplierCampaign: mock.fn(async () => "canon-1"),
    };
    const merchantMatching = {
      matchCampaign: mock.fn(async () => ({
        outcome: MATCH_OUTCOMES.NEEDS_REVIEW,
        merchantId: null,
        matchMethod: "none",
        reviewStatus: "PENDING_REVIEW",
      })),
    };
    const service = new CampaignNormalizationService({ catalogService, merchantMatching });
    const result = await service.normalizeSupplierCampaign({
      id: "sc1",
      merchantId: null,
      merchantNameRaw: "Tops TH",
    });
    assert.equal(result.catalogLinked, false);
    assert.equal(result.blockedReason, "merchant_needs_review");
    assert.equal(catalogService.ensureFromSupplierCampaign.mock.calls.length, 0);
  });

  it("catalog-links when merchant already matched", async () => {
    const catalogService = {
      ensureFromSupplierCampaign: mock.fn(async () => "canon-1"),
    };
    const merchantMatching = {
      matchCampaign: mock.fn(async () => {
        throw new Error("should not match again");
      }),
    };
    const service = new CampaignNormalizationService({ catalogService, merchantMatching });
    const result = await service.normalizeSupplierCampaign({
      id: "sc1",
      merchantId: "m1",
      merchantNameRaw: "Klook",
    });
    assert.equal(result.catalogLinked, true);
    assert.equal(result.canonicalCampaignId, "canon-1");
    assert.equal(catalogService.ensureFromSupplierCampaign.mock.calls.length, 1);
  });
});
