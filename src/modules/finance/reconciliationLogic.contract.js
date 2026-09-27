/**
 * Pointer 18 / PR4 — Reconciliation logic (pairwise checks).
 *
 * Reconcile separately:
 * 1. Network Orders vs MBO Orders
 * 2. Network Commission vs MBO Gross Network Commission
 * 3. Network Invoice vs Network Payment
 * 4. Network Payment vs MBO Actual Receipt
 * 5. MBO Actual Receipt vs MBO Gross Network Commission
 * 6. MBO Gross vs Client Payable + MBO Margin (the financial split)
 *
 * The bank receipt is gross money received by MBO; it reconciles to the gross ledger
 * (FinancialTransaction.supplierReceivable net), never to client payable. Client payable is
 * reconciled independently through the split gross = clientPayable + mboMargin, using the
 * signed/net FinancialTransaction amounts, so any client share from 0% to 100% can pass.
 *
 * Missing source evidence is not a numeric mismatch and must never be filled from
 * an internal MBO amount. It is CANNOT_RECONCILE / SOURCE_DATA_MISSING. In particular the
 * margin is never derived as gross − clientPayable: that would make the split check a tautology.
 */

export const RECONCILIATION_PAIR = {
  NETWORK_ORDERS_VS_MBO_ORDERS: "NETWORK_ORDERS_VS_MBO_ORDERS",
  NETWORK_COMMISSION_VS_MBO_GROSS: "NETWORK_COMMISSION_VS_MBO_GROSS",
  NETWORK_INVOICE_VS_NETWORK_PAYMENT: "NETWORK_INVOICE_VS_NETWORK_PAYMENT",
  NETWORK_PAYMENT_VS_MBO_RECEIPT: "NETWORK_PAYMENT_VS_MBO_RECEIPT",
  MBO_RECEIPT_VS_MBO_GROSS: "MBO_RECEIPT_VS_MBO_GROSS",
  MBO_GROSS_VS_CLIENT_PAYABLE_PLUS_MARGIN: "MBO_GROSS_VS_CLIENT_PAYABLE_PLUS_MARGIN",
};

export const RECONCILIATION_PAIR_LABELS = {
  [RECONCILIATION_PAIR.NETWORK_ORDERS_VS_MBO_ORDERS]: "Network Orders vs MBO Orders",
  [RECONCILIATION_PAIR.NETWORK_COMMISSION_VS_MBO_GROSS]: "Network Commission vs MBO Gross",
  [RECONCILIATION_PAIR.NETWORK_INVOICE_VS_NETWORK_PAYMENT]: "Network Invoice vs Network Payment",
  [RECONCILIATION_PAIR.NETWORK_PAYMENT_VS_MBO_RECEIPT]: "Network Payment vs MBO Receipt",
  [RECONCILIATION_PAIR.MBO_RECEIPT_VS_MBO_GROSS]: "MBO Receipt vs MBO Gross",
  [RECONCILIATION_PAIR.MBO_GROSS_VS_CLIENT_PAYABLE_PLUS_MARGIN]: "MBO Gross vs Client Payable + MBO Margin",
};

/** Currency amount pairs below this absolute difference are immaterial. */
export const DEFAULT_MATERIALITY_THRESHOLD = 0.01;

/** Count pairs: any non-zero difference is material. */
export const COUNT_MATERIALITY_THRESHOLD = 0;

export const RECONCILIATION_STATUS = {
  MATCHED: "MATCHED",
  MISMATCH: "MISMATCH",
  CANNOT_RECONCILE: "CANNOT_RECONCILE",
  SKIPPED: "SKIPPED",
};

export const RECONCILIATION_REASON_CODE = {
  SOURCE_DATA_MISSING: "SOURCE_DATA_MISSING",
};

/**
 * Pairs that must each be MATCHED before client payable can be released:
 *   network payment ≈ MBO receipt, MBO receipt ≈ MBO gross, network commission ≈ MBO gross,
 *   MBO gross ≈ client payable + MBO margin.
 */
export const CLIENT_PAYABLE_BLOCKING_PAIRS = new Set([
  RECONCILIATION_PAIR.NETWORK_PAYMENT_VS_MBO_RECEIPT,
  RECONCILIATION_PAIR.MBO_RECEIPT_VS_MBO_GROSS,
  RECONCILIATION_PAIR.NETWORK_COMMISSION_VS_MBO_GROSS,
  RECONCILIATION_PAIR.MBO_GROSS_VS_CLIENT_PAYABLE_PLUS_MARGIN,
]);

/** clientPayable + mboMargin, or null when either side of the split is unknown (never guessed). */
function sumOfSplit(clientPayableAmount, mboMarginAmount) {
  const client = toNumber(clientPayableAmount);
  const margin = toNumber(mboMarginAmount);
  if (client == null || margin == null) return null;
  return Number((client + margin).toFixed(4));
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bothNull(left, right) {
  return left == null && right == null;
}

function missingSideReason({ leftNum, rightNum, leftLabel, rightLabel }) {
  if (leftNum == null && rightNum != null) return `${leftLabel} missing`;
  if (rightNum == null && leftNum != null) return `${rightLabel} missing`;
  return null;
}

function buildCheck({
  pair,
  left,
  right,
  leftLabel,
  rightLabel,
  materialityThreshold,
  isCount = false,
}) {
  const leftNum = toNumber(left);
  const rightNum = toNumber(right);

  if (bothNull(leftNum, rightNum)) {
    return {
      pair,
      label: RECONCILIATION_PAIR_LABELS[pair],
      status: RECONCILIATION_STATUS.SKIPPED,
      reasonCode: null,
      ok: true,
      skipped: true,
      sourceDataMissing: false,
      material: false,
      left: leftNum,
      right: rightNum,
      leftLabel,
      rightLabel,
      difference: null,
      mismatchReason: null,
    };
  }

  // One side exists and the other does not: no reconciliation can be performed.
  if (leftNum == null || rightNum == null) {
    return {
      pair,
      label: RECONCILIATION_PAIR_LABELS[pair],
      status: RECONCILIATION_STATUS.CANNOT_RECONCILE,
      reasonCode: RECONCILIATION_REASON_CODE.SOURCE_DATA_MISSING,
      ok: false,
      skipped: false,
      sourceDataMissing: true,
      // Fail closed for financial release. Count-source gaps are also material because
      // the dataset is incomplete rather than numerically reconciled.
      material: true,
      left: leftNum,
      right: rightNum,
      leftLabel,
      rightLabel,
      difference: null,
      mismatchReason: missingSideReason({ leftNum, rightNum, leftLabel, rightLabel }),
    };
  }

  const difference = leftNum - rightNum;
  const threshold = isCount ? COUNT_MATERIALITY_THRESHOLD : materialityThreshold;
  const absDiff = Math.abs(difference);
  const ok = absDiff <= threshold;

  let mismatchReason = null;
  if (!ok) {
    mismatchReason = isCount
      ? `Count delta ${difference > 0 ? "+" : ""}${difference}`
      : `Amount delta ${difference > 0 ? "+" : ""}${difference.toFixed(4)}`;
  }

  return {
    pair,
    label: RECONCILIATION_PAIR_LABELS[pair],
    status: ok ? RECONCILIATION_STATUS.MATCHED : RECONCILIATION_STATUS.MISMATCH,
    reasonCode: null,
    ok,
    skipped: false,
    sourceDataMissing: false,
    material: !ok && absDiff > threshold,
    left: leftNum,
    right: rightNum,
    leftLabel,
    rightLabel,
    difference,
    mismatchReason,
  };
}

/**
 * Run all six pairwise reconciliation checks.
 */
export function runReconciliationChecks({
  networkOrderCount = null,
  mboOrderCount = null,
  networkCommission = null,
  mboGrossNetworkCommission = null,
  networkInvoiceAmount = null,
  networkPaymentAmount = null,
  mboActualReceiptAmount = null,
  clientPayableAmount = null,
  mboMarginAmount = null,
  materialityThreshold = DEFAULT_MATERIALITY_THRESHOLD,
} = {}) {
  const checks = [
    buildCheck({
      pair: RECONCILIATION_PAIR.NETWORK_ORDERS_VS_MBO_ORDERS,
      left: networkOrderCount,
      right: mboOrderCount,
      leftLabel: "Network orders",
      rightLabel: "MBO orders",
      materialityThreshold,
      isCount: true,
    }),
    buildCheck({
      pair: RECONCILIATION_PAIR.NETWORK_COMMISSION_VS_MBO_GROSS,
      left: networkCommission,
      right: mboGrossNetworkCommission,
      leftLabel: "Network commission",
      rightLabel: "MBO gross network commission",
      materialityThreshold,
    }),
    buildCheck({
      pair: RECONCILIATION_PAIR.NETWORK_INVOICE_VS_NETWORK_PAYMENT,
      left: networkInvoiceAmount,
      right: networkPaymentAmount,
      leftLabel: "Network invoice",
      rightLabel: "Network payment",
      materialityThreshold,
    }),
    buildCheck({
      pair: RECONCILIATION_PAIR.NETWORK_PAYMENT_VS_MBO_RECEIPT,
      left: networkPaymentAmount,
      right: mboActualReceiptAmount,
      leftLabel: "Network payment",
      rightLabel: "MBO actual receipt",
      materialityThreshold,
    }),
    buildCheck({
      pair: RECONCILIATION_PAIR.MBO_RECEIPT_VS_MBO_GROSS,
      left: mboActualReceiptAmount,
      right: mboGrossNetworkCommission,
      leftLabel: "MBO actual receipt",
      rightLabel: "MBO gross network commission",
      materialityThreshold,
    }),
    buildCheck({
      pair: RECONCILIATION_PAIR.MBO_GROSS_VS_CLIENT_PAYABLE_PLUS_MARGIN,
      left: mboGrossNetworkCommission,
      right: sumOfSplit(clientPayableAmount, mboMarginAmount),
      leftLabel: "MBO gross network commission",
      rightLabel: "Client payable + MBO margin",
      materialityThreshold,
    }),
  ];

  const cannotReconcile = checks.filter(
    (check) => check.status === RECONCILIATION_STATUS.CANNOT_RECONCILE,
  );
  const materialMismatches = checks.filter((check) => check.material);
  const openMismatches = checks.filter((check) => !check.ok && !check.skipped);

  return {
    checks,
    allMatched: openMismatches.length === 0,
    hasMaterialMismatch: materialMismatches.length > 0,
    hasSourceDataMissing: cannotReconcile.length > 0,
    cannotReconcile,
    materialMismatches,
    openMismatches,
    summaryStatus:
      cannotReconcile.length > 0
        ? RECONCILIATION_STATUS.CANNOT_RECONCILE
        : openMismatches.length === 0
          ? RECONCILIATION_STATUS.MATCHED
          : RECONCILIATION_STATUS.MISMATCH,
  };
}

/**
 * Client payable release is blocked unless EVERY blocking pair is present and MATCHED.
 * A check list that omits a required pair fails closed: absence of a check is not evidence.
 */
export function shouldBlockClientPayableRelease(checks = []) {
  const list = Array.isArray(checks) ? checks : [];
  for (const pair of CLIENT_PAYABLE_BLOCKING_PAIRS) {
    const check = list.find((c) => c?.pair === pair);
    if (!check || check.status !== RECONCILIATION_STATUS.MATCHED) return true;
  }
  return false;
}

export function summarizeChecksForUi(checks = []) {
  return checks.map((check) => ({
    pair: check.pair,
    label: check.label,
    status: check.status,
    reasonCode: check.reasonCode ?? null,
    ok: check.ok,
    skipped: check.skipped,
    sourceDataMissing: Boolean(check.sourceDataMissing),
    material: check.material,
    left: check.left,
    right: check.right,
    leftLabel: check.leftLabel,
    rightLabel: check.rightLabel,
    difference: check.difference,
    mismatchReason: check.mismatchReason,
  }));
}

export function resolveNetworkReconRowStatus(reconciliationResult) {
  if (!reconciliationResult) return "UNKNOWN";
  if (reconciliationResult.hasSourceDataMissing) return RECONCILIATION_STATUS.CANNOT_RECONCILE;
  if (reconciliationResult.allMatched) return RECONCILIATION_STATUS.MATCHED;
  if (reconciliationResult.hasMaterialMismatch) return RECONCILIATION_STATUS.MISMATCH;
  if (reconciliationResult.openMismatches?.length) return "PARTIAL";
  return "PENDING";
}
