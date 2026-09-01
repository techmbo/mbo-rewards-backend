/**
 * Pointer 42 — Expected supplier commission vs network actual commission.
 * Supplier Commission Rule and Network Actual Commission are separate facts — never overwrite actual with expected.
 */

export const CONTRACT_POINTER = 42;

export const EXPECTED_VS_ACTUAL_SUMMARY = Object.freeze({
  separateFacts:
    "Supplier Commission Rule and Network Actual Commission are separate facts.",
  expectedFromRule:
    "A matched rule may imply an expected commission, but the network-reported actual commission remains the financial source fact when supplied.",
  noOverwrite:
    "Store both expected and network actual values. Do not overwrite network actual commission with the expected value.",
  varianceRouting:
    "The difference belongs in reconciliation/exception logic — not silent replacement of the network-reported fact.",
});

export const RECOMMENDED_ORDER_COMMISSION_FIELDS = Object.freeze([
  "matched_supplier_commission_rule_id",
  "matched_commission_sequence",
  "expected_supplier_commission",
  "expected_supplier_commission_currency",
  "network_actual_commission",
  "network_actual_commission_currency",
  "commission_variance",
  "commission_match_status",
]);

export const COMMISSION_MATCH_STATUS = Object.freeze({
  MATCHED: "MATCHED",
  VARIANCE: "VARIANCE",
  EXPECTED_ONLY: "EXPECTED_ONLY",
  ACTUAL_ONLY: "ACTUAL_ONLY",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
});

export class ExpectedVsActualSupplierCommissionError extends Error {
  constructor(message, { code = "EXPECTED_VS_ACTUAL_COMMISSION_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "ExpectedVsActualSupplierCommissionError";
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

function roundMoney(value) {
  if (value == null) return null;
  return Number(Number(value).toFixed(4));
}

/**
 * Compute expected supplier commission from matched rule rate and order value.
 */
export function computeExpectedSupplierCommission({
  ratePercent = null,
  fixedAmount = null,
  orderValue = null,
} = {}) {
  const rate = asNumber(ratePercent);
  const fixed = asNumber(fixedAmount);
  const value = asNumber(orderValue);

  if (rate != null && value != null) {
    return roundMoney((value * rate) / 100);
  }
  if (fixed != null) return roundMoney(fixed);
  return null;
}

/**
 * Resolve commission match status from expected vs actual facts.
 */
export function resolveCommissionMatchStatus({
  expected = null,
  actual = null,
  variance = null,
  tolerance = 0,
} = {}) {
  const expectedValue = asNumber(expected);
  const actualValue = asNumber(actual);

  if (expectedValue == null && actualValue == null) return COMMISSION_MATCH_STATUS.REVIEW_REQUIRED;
  if (expectedValue != null && actualValue == null) return COMMISSION_MATCH_STATUS.EXPECTED_ONLY;
  if (expectedValue == null && actualValue != null) return COMMISSION_MATCH_STATUS.ACTUAL_ONLY;

  const diff =
    variance != null
      ? asNumber(variance)
      : actualValue != null && expectedValue != null
        ? roundMoney(actualValue - expectedValue)
        : null;

  if (diff == null) return COMMISSION_MATCH_STATUS.REVIEW_REQUIRED;
  if (Math.abs(diff) <= tolerance) return COMMISSION_MATCH_STATUS.MATCHED;
  return COMMISSION_MATCH_STATUS.VARIANCE;
}

/**
 * Build order-level commission fact fields — store expected and actual separately.
 */
export function buildOrderCommissionFacts({
  matchedSupplierCommissionRuleId = null,
  matchedCommissionSequence = null,
  ratePercent = null,
  fixedAmount = null,
  orderValue = null,
  currency = null,
  networkActualCommission = null,
  networkActualCommissionCurrency = null,
  tolerance = 0,
} = {}) {
  const expectedSupplierCommission = computeExpectedSupplierCommission({
    ratePercent,
    fixedAmount,
    orderValue,
  });
  const expectedCurrency = currency ?? networkActualCommissionCurrency ?? null;
  const actualCurrency = networkActualCommissionCurrency ?? currency ?? null;
  const commissionVariance =
    expectedSupplierCommission != null && networkActualCommission != null
      ? roundMoney(asNumber(networkActualCommission) - expectedSupplierCommission)
      : null;
  const commissionMatchStatus = resolveCommissionMatchStatus({
    expected: expectedSupplierCommission,
    actual: networkActualCommission,
    variance: commissionVariance,
    tolerance,
  });

  return {
    matched_supplier_commission_rule_id: matchedSupplierCommissionRuleId,
    matched_commission_sequence: matchedCommissionSequence,
    expected_supplier_commission: expectedSupplierCommission,
    expected_supplier_commission_currency: expectedCurrency,
    network_actual_commission: networkActualCommission != null ? roundMoney(networkActualCommission) : null,
    network_actual_commission_currency: actualCurrency,
    commission_variance: commissionVariance,
    commission_match_status: commissionMatchStatus,
    overwriteNetworkActualWithExpected: false,
  };
}

/**
 * Assert network actual commission was not overwritten by expected value.
 */
export function assertNetworkActualNotOverwritten({
  expected = null,
  networkActual = null,
  storedNetworkActual = null,
} = {}) {
  const expectedValue = asNumber(expected);
  const actualValue = asNumber(networkActual);
  const storedValue = asNumber(storedNetworkActual);

  if (actualValue != null && storedValue != null && storedValue !== actualValue) {
    if (expectedValue != null && storedValue === expectedValue) {
      throw new ExpectedVsActualSupplierCommissionError(
        "Do not overwrite network actual commission with the expected supplier commission.",
        {
          code: "NETWORK_ACTUAL_OVERWRITTEN_BY_EXPECTED",
          details: { expected: expectedValue, networkActual: actualValue, storedNetworkActual: storedValue },
        },
      );
    }
    throw new ExpectedVsActualSupplierCommissionError(
      "Network actual commission must remain the financial source fact when supplied.",
      {
        code: "NETWORK_ACTUAL_ALTERED",
        details: { networkActual: actualValue, storedNetworkActual: storedValue },
      },
    );
  }

  return true;
}

/**
 * Assert expected and actual commission facts are stored separately.
 */
export function assertSeparateCommissionFacts({ record = null } = {}) {
  if (!record || typeof record !== "object") {
    throw new ExpectedVsActualSupplierCommissionError("Order commission fact record is required.", {
      code: "COMMISSION_FACT_RECORD_MISSING",
      details: { record },
    });
  }

  if (record.overwriteNetworkActualWithExpected === true) {
    throw new ExpectedVsActualSupplierCommissionError(
      "Expected and network actual commission must remain separate facts.",
      {
        code: "COMMISSION_FACTS_NOT_SEPARATE",
        details: { record },
      },
    );
  }

  const hasExpected = record.expected_supplier_commission != null;
  const hasActual = record.network_actual_commission != null;

  if (hasExpected && hasActual) {
    if (
      asNumber(record.expected_supplier_commission) === asNumber(record.network_actual_commission) &&
      record.commission_match_status === COMMISSION_MATCH_STATUS.VARIANCE
    ) {
      throw new ExpectedVsActualSupplierCommissionError(
        "commission_match_status must reflect expected vs actual variance when values differ.",
        {
          code: "COMMISSION_STATUS_INCONSISTENT",
          details: { record },
        },
      );
    }
  }

  return true;
}

/** Pointer exemplar — 15% of AED 1,000 expected AED 150, network actual AED 140. */
export const POINTER_42_EXAMPLE = Object.freeze({
  matchedRuleRatePercent: 15,
  orderValue: 1000,
  currency: "AED",
  expectedSupplierCommission: 150,
  networkActualCommission: 140,
  commissionVariance: -10,
  commissionMatchStatus: COMMISSION_MATCH_STATUS.VARIANCE,
});

export function buildExpectedVsActualSupplierCommissionGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...EXPECTED_VS_ACTUAL_SUMMARY },
    recommendedOrderFields: [...RECOMMENDED_ORDER_COMMISSION_FIELDS],
    commissionMatchStatuses: Object.values(COMMISSION_MATCH_STATUS),
    example: Object.freeze({
      ...POINTER_42_EXAMPLE,
      orderFacts: buildOrderCommissionFacts({
        matchedSupplierCommissionRuleId: "scr-uae-shoes",
        matchedCommissionSequence: 3,
        ratePercent: POINTER_42_EXAMPLE.matchedRuleRatePercent,
        orderValue: POINTER_42_EXAMPLE.orderValue,
        currency: POINTER_42_EXAMPLE.currency,
        networkActualCommission: POINTER_42_EXAMPLE.networkActualCommission,
        networkActualCommissionCurrency: POINTER_42_EXAMPLE.currency,
      }),
    }),
    runtimeRefs: Object.freeze({
      supplierCommissionOrderDetection: "networkOps/supplierCommissionOrderDetection.contract.js",
      reconciliationService: "finance/reconciliation.service.js",
      financeSeparation: "finance/financeSeparation.contract.js",
      exceptionCaseService: "order/exceptionCase.service.js",
    }),
    crossRefs: Object.freeze({
      pointer41OrderDetection: "Matched rule selection and expected calculation precede actual comparison.",
      pointer32CommercialSequencing: "Variance routes to reconciliation/exception — not payable overwrite.",
      pointer40CampaignSummary: "Campaign averages remain display-only and must not replace order facts.",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      network: family,
      sourceObject: obj,
      orderIngestion: "order/orderIngestion.service.js",
      financialTransactionService: "finance/financialTransaction.service.js",
    });
  }

  return guide;
}

export function applyExpectedVsActualSupplierCommissionContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    expectedVsActualSupplierCommissionPointer: CONTRACT_POINTER,
    expectedVsActualSupplierCommissionNetwork: network || null,
    expectedVsActualSupplierCommissionSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
