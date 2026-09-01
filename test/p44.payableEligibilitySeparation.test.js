/**
 * Pointer 44 — Payable eligibility is separate from commission calculation.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  PAYABLE_ELIGIBILITY_SEQUENCE,
  PAYABLE_ELIGIBILITY_STATUS,
  PAYABLE_ELIGIBILITY_SUMMARY,
  SYSTEM_QUESTIONS,
  applyPayableEligibilitySeparationContract,
  assertCalculatedCommissionNotAutomaticallyPayable,
  assertNetworkPaymentDoesNotCreateMboReceipt,
  assertNetworkPaymentDoesNotReleasePayable,
  buildPayableEligibilitySeparationGuide,
  evaluatePayableEligibility,
} from "../src/modules/networkOps/payableEligibilitySeparation.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 44 — payableEligibilitySeparation.contract", () => {
  it("declares contract pointer 44 and two distinct system questions", () => {
    assert.equal(CONTRACT_POINTER, 44);
    assert.equal(SYSTEM_QUESTIONS.earnings.answeredBy, "commission_calculation");
    assert.equal(SYSTEM_QUESTIONS.payable.answeredBy, "finance_reconciliation");
    assert.equal(PAYABLE_ELIGIBILITY_SEQUENCE.length, 7);
    assert.match(PAYABLE_ELIGIBILITY_SUMMARY.notAutomaticPayable, /not automatically a payable balance/i);
  });

  it("assertCalculatedCommissionNotAutomaticallyPayable blocks release without receipt", () => {
    assert.doesNotThrow(() =>
      assertCalculatedCommissionNotAutomaticallyPayable({
        calculatedClientCommission: 805,
        clientPayableReleased: false,
      }),
    );
    assert.throws(
      () =>
        assertCalculatedCommissionNotAutomaticallyPayable({
          calculatedClientCommission: 805,
          clientPayableReleased: true,
          mboActualReceiptConfirmed: false,
        }),
      (err) => {
        assert.equal(err.code, "COMMISSION_AUTO_PAYABLE");
        return true;
      },
    );
    assert.throws(
      () =>
        assertCalculatedCommissionNotAutomaticallyPayable({
          calculatedClientCommission: 805,
          provisional: true,
          clientPayableReleased: true,
        }),
      (err) => {
        assert.equal(err.code, "PROVISIONAL_COMMISSION_PAYABLE");
        return true;
      },
    );
  });

  it("assertNetworkPaymentDoesNotCreateMboReceipt rejects network-status inference", () => {
    assert.throws(
      () =>
        assertNetworkPaymentDoesNotCreateMboReceipt({
          networkPaymentStatus: "PAID",
          mboActualReceiptInferredFromNetwork: true,
        }),
      (err) => {
        assert.equal(err.code, "NETWORK_STATUS_CREATES_MBO_RECEIPT");
        return true;
      },
    );
  });

  it("assertNetworkPaymentDoesNotReleasePayable rejects network-status-only release", () => {
    assert.throws(
      () =>
        assertNetworkPaymentDoesNotReleasePayable({
          networkPaymentStatus: "AVAILABLE",
          clientPayableReleased: true,
          mboActualReceiptConfirmed: false,
        }),
      (err) => {
        assert.equal(err.code, "NETWORK_STATUS_RELEASES_PAYABLE");
        return true;
      },
    );
  });

  it("evaluatePayableEligibility stops at commission-only stage", () => {
    const result = evaluatePayableEligibility({
      calculatedClientCommission: 805,
      orderConfirmed: false,
    });
    assert.equal(result.status, PAYABLE_ELIGIBILITY_STATUS.AWAITING_ORDER_CONFIRMATION);
    assert.equal(result.eligible, false);
    assert.equal(result.completedThroughRank, 1);
  });

  it("evaluatePayableEligibility does not treat network PAID as payable without MBO receipt", () => {
    const result = evaluatePayableEligibility({
      calculatedClientCommission: 805,
      orderConfirmed: true,
      networkPaymentEvidenceAvailable: true,
      networkPaymentStatus: "PAID",
      mboActualReceiptConfirmed: false,
    });
    assert.equal(result.status, PAYABLE_ELIGIBILITY_STATUS.AWAITING_MBO_RECEIPT);
    assert.equal(result.eligible, false);
  });

  it("evaluatePayableEligibility reaches ELIGIBLE when finance chain is complete", () => {
    const result = evaluatePayableEligibility({
      calculatedClientCommission: 805,
      order: {
        validationStatus: "VALIDATION_APPROVED",
        metadata: {
          networkPaymentEvidence: "PAID",
          mboReceivedDateTime: "2026-08-15T10:00:00.000Z",
          mboReceiptSource: "BANK_RECONCILIATION",
        },
      },
    });
    assert.equal(result.status, PAYABLE_ELIGIBILITY_STATUS.ELIGIBLE);
    assert.equal(result.eligible, true);
    assert.equal(result.completedThroughRank, 6);
  });

  it("buildPayableEligibilitySeparationGuide includes scoped object refs and examples", () => {
    const globalGuide = buildPayableEligibilitySeparationGuide();
    assert.equal(globalGuide.contractPointer, 44);
    assert.equal(globalGuide.example.networkPaidWithoutReceipt.eligible, false);

    const objectGuide = buildPayableEligibilitySeparationGuide({
      network: "optimise",
      sourceObject: "conversions_orders",
    });
    assert.equal(objectGuide.objectRefs.network, "optimise");
    assert.match(objectGuide.crossRefs.pointer43ClientCommission, /not automatic payable balance/i);
  });

  it("applyPayableEligibilitySeparationContract stamps response meta", () => {
    const wrapped = applyPayableEligibilitySeparationContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "conversions_orders" },
    );
    assert.equal(wrapped.meta.payableEligibilitySeparationPointer, 44);
    assert.equal(wrapped.meta.payableEligibilitySeparationNetwork, "optimise");
  });
});

describe("Pointer 44 — AI integration guide includes payable eligibility separation", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes payableEligibilitySeparation", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.payableEligibilitySeparationPointer, 44);
    assert.equal(payload.payableEligibilitySeparation.contractPointer, 44);
    assert.equal(payload.payableEligibilitySeparation.payableSequence.length, 7);
  });

  it("object guide includes scoped payable eligibility refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.payableEligibilitySeparation.contractPointer, 44);
    assert.match(payload.payableEligibilitySeparation.crossRefs.pointer17FinanceSeparation, /evidence only/i);
  });
});

describe("Pointer 44 — GET /ops/network/ai-integration-guide", () => {
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
