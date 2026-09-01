/**
 * Pointer 44 — Payable eligibility is separate from commission calculation.
 * Commission calculation answers "how much does the client earn?";
 * finance/reconciliation answers "is that amount eligible to be paid now?"
 */
import {
  NETWORK_PAYMENT_EVIDENCE,
  hasMboActualReceipt,
  isNetworkPaymentEvidenceOnly,
  resolveClientPayableEligibility,
  shouldNotInferMboReceiptFromNetworkPayment,
} from "../finance/financeSeparation.contract.js";
import { shouldBlockClientPayableRelease } from "../finance/reconciliationLogic.contract.js";

export const CONTRACT_POINTER = 44;

export const SYSTEM_QUESTIONS = Object.freeze({
  earnings: {
    key: "client_earnings",
    question: "How much does the client earn?",
    answeredBy: "commission_calculation",
  },
  payable: {
    key: "payable_eligibility",
    question: "Is that amount eligible to be paid now?",
    answeredBy: "finance_reconciliation",
  },
});

export const PAYABLE_ELIGIBILITY_SUMMARY = Object.freeze({
  separateQuestions:
    "Commission calculation answers how much the client earns. Finance/reconciliation answers whether that amount is eligible to be paid now.",
  notAutomaticPayable:
    "A calculated client commission is not automatically a payable balance.",
  networkStatusBoundary:
    "Network PAID, PAYMENT SENT, AVAILABLE or WITHDRAWN status must not by itself create MBO Actual Receipt or release Client Payable.",
  provisionalNotPayable:
    "Provisional commission calculations remain non-payable until required financial evidence is available.",
});

/** Recommended payable eligibility sequence after commission calculation. */
export const PAYABLE_ELIGIBILITY_SEQUENCE = Object.freeze([
  { rank: 1, key: "calculated_client_commission", label: "Calculated Client Commission" },
  { rank: 2, key: "order_confirmed", label: "Order confirmed under approved MBO order-status logic" },
  {
    rank: 3,
    key: "network_payment_evidence",
    label: "Required network payment/settlement evidence available",
  },
  {
    rank: 4,
    key: "mbo_actual_receipt",
    label: "MBO Actual Receipt confirmed through internal reconciliation",
  },
  { rank: 5, key: "no_blocking_exception", label: "No blocking financial exception" },
  { rank: 6, key: "client_payable_eligible", label: "Client Payable eligible" },
  { rank: 7, key: "withdrawal_payment", label: "Withdrawal/payment process" },
]);

export const PAYABLE_ELIGIBILITY_STATUS = Object.freeze({
  NOT_CALCULATED: "NOT_CALCULATED",
  PROVISIONAL: "PROVISIONAL",
  AWAITING_ORDER_CONFIRMATION: "AWAITING_ORDER_CONFIRMATION",
  AWAITING_NETWORK_EVIDENCE: "AWAITING_NETWORK_EVIDENCE",
  AWAITING_MBO_RECEIPT: "AWAITING_MBO_RECEIPT",
  BLOCKED_BY_EXCEPTION: "BLOCKED_BY_EXCEPTION",
  ELIGIBLE: "ELIGIBLE",
  PAYMENT_IN_PROGRESS: "PAYMENT_IN_PROGRESS",
});

export class PayableEligibilitySeparationError extends Error {
  constructor(message, { code = "PAYABLE_ELIGIBILITY_SEPARATION_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "PayableEligibilitySeparationError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Assert calculated commission alone does not create payable balance.
 */
export function assertCalculatedCommissionNotAutomaticallyPayable({
  calculatedClientCommission = null,
  clientPayableReleased = false,
  mboActualReceiptConfirmed = false,
  provisional = false,
} = {}) {
  const amount = asNumber(calculatedClientCommission);
  if (
    amount != null &&
    clientPayableReleased &&
    !mboActualReceiptConfirmed &&
    !provisional
  ) {
    throw new PayableEligibilitySeparationError(
      "A calculated client commission is not automatically a payable balance.",
      {
        code: "COMMISSION_AUTO_PAYABLE",
        details: { calculatedClientCommission: amount, clientPayableReleased, mboActualReceiptConfirmed },
      },
    );
  }

  if (provisional && clientPayableReleased) {
    throw new PayableEligibilitySeparationError(
      "Provisional commission calculations must not be released as Client Payable.",
      {
        code: "PROVISIONAL_COMMISSION_PAYABLE",
        details: { calculatedClientCommission: amount, provisional, clientPayableReleased },
      },
    );
  }

  return true;
}

/**
 * Assert network payment status alone does not create MBO Actual Receipt.
 */
export function assertNetworkPaymentDoesNotCreateMboReceipt({
  networkPaymentStatus = null,
  mboActualReceiptInferredFromNetwork = false,
} = {}) {
  if (
    isNetworkPaymentEvidenceOnly(networkPaymentStatus) &&
    mboActualReceiptInferredFromNetwork
  ) {
    throw new PayableEligibilitySeparationError(
      "Network payment status must not by itself create MBO Actual Receipt.",
      {
        code: "NETWORK_STATUS_CREATES_MBO_RECEIPT",
        details: { networkPaymentStatus },
      },
    );
  }
  return true;
}

/**
 * Assert network payment status alone does not release Client Payable.
 */
export function assertNetworkPaymentDoesNotReleasePayable({
  networkPaymentStatus = null,
  clientPayableReleased = false,
  mboActualReceiptConfirmed = false,
} = {}) {
  if (
    isNetworkPaymentEvidenceOnly(networkPaymentStatus) &&
    clientPayableReleased &&
    !mboActualReceiptConfirmed
  ) {
    throw new PayableEligibilitySeparationError(
      "Network PAID, PAYMENT SENT, AVAILABLE or WITHDRAWN status must not by itself release Client Payable.",
      {
        code: "NETWORK_STATUS_RELEASES_PAYABLE",
        details: { networkPaymentStatus, clientPayableReleased, mboActualReceiptConfirmed },
      },
    );
  }
  return true;
}

function resolveOrderConfirmed(order = null, orderConfirmed = null) {
  if (orderConfirmed != null) return Boolean(orderConfirmed);
  return String(order?.validationStatus || "").toUpperCase() === "VALIDATION_APPROVED";
}

function resolveNetworkPaymentEvidence({
  order = null,
  networkPaymentEvidenceAvailable = null,
  networkPaymentStatus = null,
} = {}) {
  if (networkPaymentEvidenceAvailable != null) return Boolean(networkPaymentEvidenceAvailable);
  const meta = order?.metadata && typeof order.metadata === "object" ? order.metadata : {};
  const raw =
    networkPaymentStatus ??
    meta.networkPaymentEvidence ??
    meta.networkPaymentStatus ??
    order?.supplierPaymentStatus ??
    null;
  return raw != null && String(raw).trim() !== "";
}

/**
 * Evaluate payable eligibility through the recommended sequence.
 */
export function evaluatePayableEligibility({
  calculatedClientCommission = null,
  provisional = false,
  orderConfirmed = null,
  networkPaymentEvidenceAvailable = null,
  networkPaymentStatus = null,
  mboActualReceiptConfirmed = null,
  blockingFinancialException = false,
  clientPaymentInProgress = false,
  order = null,
  financialTransactions = [],
  reconciliationChecks = null,
} = {}) {
  const amount = asNumber(calculatedClientCommission);
  const receiptConfirmed =
    mboActualReceiptConfirmed != null
      ? Boolean(mboActualReceiptConfirmed)
      : hasMboActualReceipt({ order, financialTransactions });
  const confirmed = resolveOrderConfirmed(order, orderConfirmed);
  const networkEvidence = resolveNetworkPaymentEvidence({
    order,
    networkPaymentEvidenceAvailable,
    networkPaymentStatus,
  });
  const networkStatus =
    networkPaymentStatus ??
    order?.metadata?.networkPaymentEvidence ??
    order?.metadata?.networkPaymentStatus ??
    null;

  assertNetworkPaymentDoesNotCreateMboReceipt({
    networkPaymentStatus: networkStatus,
    mboActualReceiptInferredFromNetwork:
      receiptConfirmed && shouldNotInferMboReceiptFromNetworkPayment({ networkPaymentStatus: networkStatus }) && !hasMboActualReceipt({ order, financialTransactions }),
  });

  if (amount == null) {
    return {
      status: PAYABLE_ELIGIBILITY_STATUS.NOT_CALCULATED,
      eligible: false,
      reason: "Client commission not calculated",
      completedThroughRank: 0,
    };
  }

  if (provisional) {
    return {
      status: PAYABLE_ELIGIBILITY_STATUS.PROVISIONAL,
      eligible: false,
      reason: "Provisional commission is not payable until financial evidence is available",
      completedThroughRank: 1,
    };
  }

  if (!confirmed) {
    return {
      status: PAYABLE_ELIGIBILITY_STATUS.AWAITING_ORDER_CONFIRMATION,
      eligible: false,
      reason: "Order not confirmed under approved MBO order-status logic",
      completedThroughRank: 1,
    };
  }

  if (!networkEvidence) {
    return {
      status: PAYABLE_ELIGIBILITY_STATUS.AWAITING_NETWORK_EVIDENCE,
      eligible: false,
      reason: "Required network payment/settlement evidence not available",
      completedThroughRank: 2,
    };
  }

  if (!receiptConfirmed) {
    assertNetworkPaymentDoesNotReleasePayable({
      networkPaymentStatus: networkStatus,
      clientPayableReleased: false,
      mboActualReceiptConfirmed: false,
    });
    return {
      status: PAYABLE_ELIGIBILITY_STATUS.AWAITING_MBO_RECEIPT,
      eligible: false,
      reason: "MBO Actual Receipt required before Client Payable eligibility",
      completedThroughRank: 3,
    };
  }

  if (
    blockingFinancialException ||
    (reconciliationChecks?.length && shouldBlockClientPayableRelease(reconciliationChecks))
  ) {
    return {
      status: PAYABLE_ELIGIBILITY_STATUS.BLOCKED_BY_EXCEPTION,
      eligible: false,
      reason: "Blocking financial exception prevents Client Payable release",
      completedThroughRank: 4,
    };
  }

  const financeEligibility = resolveClientPayableEligibility({
    order,
    financialTransactions,
    reconciliationChecks,
  });

  assertCalculatedCommissionNotAutomaticallyPayable({
    calculatedClientCommission: amount,
    clientPayableReleased: financeEligibility.eligible,
    mboActualReceiptConfirmed: receiptConfirmed,
    provisional,
  });

  if (!financeEligibility.eligible) {
    return {
      status: PAYABLE_ELIGIBILITY_STATUS.BLOCKED_BY_EXCEPTION,
      eligible: false,
      reason: financeEligibility.reason || "Client Payable not eligible",
      completedThroughRank: 4,
    };
  }

  if (clientPaymentInProgress) {
    return {
      status: PAYABLE_ELIGIBILITY_STATUS.PAYMENT_IN_PROGRESS,
      eligible: true,
      reason: null,
      completedThroughRank: 7,
    };
  }

  return {
    status: PAYABLE_ELIGIBILITY_STATUS.ELIGIBLE,
    eligible: true,
    reason: null,
    completedThroughRank: 6,
  };
}

export function buildPayableEligibilitySeparationGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...PAYABLE_ELIGIBILITY_SUMMARY },
    systemQuestions: Object.freeze({
      earnings: { ...SYSTEM_QUESTIONS.earnings },
      payable: { ...SYSTEM_QUESTIONS.payable },
    }),
    payableSequence: PAYABLE_ELIGIBILITY_SEQUENCE.map((step) => ({ ...step })),
    networkPaymentEvidenceOnly: [...NETWORK_PAYMENT_EVIDENCE],
    eligibilityStatuses: Object.freeze({ ...PAYABLE_ELIGIBILITY_STATUS }),
    example: Object.freeze({
      calculatedCommissionOnly: evaluatePayableEligibility({
        calculatedClientCommission: 805,
        orderConfirmed: false,
      }),
      networkPaidWithoutReceipt: evaluatePayableEligibility({
        calculatedClientCommission: 805,
        orderConfirmed: true,
        networkPaymentEvidenceAvailable: true,
        networkPaymentStatus: "PAID",
        mboActualReceiptConfirmed: false,
      }),
      fullyEligible: evaluatePayableEligibility({
        calculatedClientCommission: 805,
        order: {
          validationStatus: "VALIDATION_APPROVED",
          metadata: {
            networkPaymentEvidence: "PAID",
            mboReceivedDateTime: "2026-08-15T10:00:00.000Z",
            mboReceiptSource: "BANK_RECONCILIATION",
          },
        },
      }),
    }),
    runtimeRefs: Object.freeze({
      financeSeparation: "finance/financeSeparation.contract.js",
      reconciliationLogic: "finance/reconciliationLogic.contract.js",
      reconciliationService: "finance/reconciliation.service.js",
      financialTransactionService: "finance/financialTransaction.service.js",
      clientCommissionDetection: "networkOps/clientCommissionDetection.contract.js",
    }),
    crossRefs: Object.freeze({
      pointer17FinanceSeparation: "Network payment tokens are evidence only — never MBO bank receipt.",
      pointer32CommercialSequencing: "Commission calculation completes before payable eligibility evaluation.",
      pointer43ClientCommission: "Calculated client commission is input to payable sequence — not automatic payable balance.",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      network: family,
      sourceObject: obj,
      financeSeparation: "finance/financeSeparation.contract.js",
      reconciliationService: "finance/reconciliation.service.js",
    });
  }

  return guide;
}

export function applyPayableEligibilitySeparationContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    payableEligibilitySeparationPointer: CONTRACT_POINTER,
    payableEligibilitySeparationNetwork: network || null,
    payableEligibilitySeparationSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
