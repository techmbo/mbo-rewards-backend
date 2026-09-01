/**
 * Pointer 32 — Commercial calculation sequencing.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  COMMERCIAL_CALCULATION_SEQUENCE,
  COMMERCIAL_SEQUENCING_SUMMARY,
  CONTRACT_POINTER,
  CommercialCalculationSequencingError,
  applyCommercialCalculationSequencingContract,
  assertAmbiguousAttributionReviewRequired,
  assertAttributionBeforeCommission,
  assertCommercialSequenceOrder,
  assertPerRecordFailureIsolation,
  buildCommercialCalculationSequencingGuide,
} from "../src/modules/networkOps/commercialCalculationSequencing.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 32 — commercialCalculationSequencing.contract", () => {
  it("declares contract pointer 32 and seven-step commercial sequence", () => {
    assert.equal(CONTRACT_POINTER, 32);
    assert.equal(COMMERCIAL_CALCULATION_SEQUENCE.length, 7);
    assert.equal(COMMERCIAL_CALCULATION_SEQUENCE[0].key, "conversion_order");
    assert.equal(COMMERCIAL_CALCULATION_SEQUENCE.at(-1).key, "mbo_commission_margin");
    assert.match(COMMERCIAL_SEQUENCING_SUMMARY.adapterBoundary, /Client commercial logic must not live inside adapters/);
    assert.match(COMMERCIAL_SEQUENCING_SUMMARY.attributionGate, /REVIEW_REQUIRED/);
  });

  it("assertCommercialSequenceOrder rejects out-of-order steps", () => {
    assert.doesNotThrow(() =>
      assertCommercialSequenceOrder({
        completedSteps: [
          "conversion_order",
          "mbo_campaign",
          "attribution",
          "client_campaign_assignment",
          "client_commercial_rule",
          "client_commission",
          "mbo_commission_margin",
        ],
      }),
    );
    assert.throws(
      () =>
        assertCommercialSequenceOrder({
          completedSteps: ["client_commission", "attribution"],
        }),
      (err) => {
        assert.equal(err.code, "COMMERCIAL_SEQUENCE_OUT_OF_ORDER");
        return true;
      },
    );
  });

  it("assertAttributionBeforeCommission blocks commission before attribution and adapter logic", () => {
    assert.throws(
      () =>
        assertAttributionBeforeCommission({
          attributionStatus: "REVIEW_REQUIRED",
          commissionCalculated: true,
        }),
      (err) => {
        assert.equal(err.code, "COMMISSION_BEFORE_ATTRIBUTION");
        return true;
      },
    );
    assert.throws(
      () =>
        assertAttributionBeforeCommission({
          inAdapter: true,
        }),
      (err) => {
        assert.equal(err.code, "COMMERCIAL_LOGIC_IN_ADAPTER");
        return true;
      },
    );
    assert.doesNotThrow(() =>
      assertAttributionBeforeCommission({
        attributionStatus: "ATTRIBUTED",
        attributionResolved: true,
        commissionCalculated: true,
      }),
    );
  });

  it("assertAmbiguousAttributionReviewRequired enforces REVIEW_REQUIRED", () => {
    assert.throws(
      () =>
        assertAmbiguousAttributionReviewRequired({
          ambiguous: true,
          attributionStatus: "PENDING",
        }),
      (err) => {
        assert.equal(err.code, "AMBIGUOUS_ATTRIBUTION_NOT_REVIEW_REQUIRED");
        return true;
      },
    );
    assert.doesNotThrow(() =>
      assertAmbiguousAttributionReviewRequired({
        ambiguous: true,
        attributionStatus: "REVIEW_REQUIRED",
      }),
    );
  });

  it("assertPerRecordFailureIsolation preserves record and continues sync", () => {
    assert.throws(
      () =>
        assertPerRecordFailureIsolation({
          recordFailed: true,
          syncAborted: true,
        }),
      (err) => {
        assert.equal(err.code, "SYNC_ABORTED_ON_SINGLE_RECORD");
        return true;
      },
    );
    assert.doesNotThrow(() =>
      assertPerRecordFailureIsolation({
        recordFailed: true,
        syncAborted: false,
        recordPreserved: true,
        exceptionCreated: true,
        validRecordsContinued: true,
        quarantinedScope: "affected_record_only",
      }),
    );
  });

  it("buildCommercialCalculationSequencingGuide includes scoped object refs", () => {
    const globalGuide = buildCommercialCalculationSequencingGuide();
    assert.equal(globalGuide.contractPointer, 32);
    assert.equal(globalGuide.sequence.length, 7);

    const objectGuide = buildCommercialCalculationSequencingGuide({
      network: "optimise",
      sourceObject: "conversions",
    });
    assert.equal(objectGuide.objectRefs.network, "optimise");
    assert.equal(objectGuide.objectRefs.sourceObject, "conversions");
  });

  it("applyCommercialCalculationSequencingContract stamps response meta", () => {
    const wrapped = applyCommercialCalculationSequencingContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "conversions" },
    );
    assert.equal(wrapped.meta.commercialSequencingPointer, 32);
    assert.equal(wrapped.meta.commercialSequencingNetwork, "optimise");
  });
});

describe("Pointer 32 — AI integration guide includes commercial sequencing", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes commercialCalculationSequencing", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.commercialSequencingPointer, 32);
    assert.equal(payload.commercialCalculationSequencing.contractPointer, 32);
    assert.equal(payload.commercialCalculationSequencing.sequence.length, 7);
  });

  it("object guide includes scoped commercial sequencing refs", () => {
    const payload = guide.getObjectGuide("optimise", "conversions");
    assert.equal(payload.commercialCalculationSequencing.contractPointer, 32);
    assert.equal(payload.commercialCalculationSequencing.objectRefs.sourceObject, "conversions");
  });
});

describe("Pointer 32 — GET /ops/network/ai-integration-guide", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("returns 401 without auth for global guide", async () => {
    const { status } = await apiRequest(server.baseUrl, {
      path: "/ops/network/ai-integration-guide",
    });
    assert.equal(status, 401);
  });
});
