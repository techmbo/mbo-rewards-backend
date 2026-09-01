/**
 * Pointer 18 / PR4 — Reconciliation logic (pairwise checks).
 *
 * Reconcile separately:
 * 1. Network Orders vs MBO Orders
 * 2. Network Commission vs MBO Gross Network Commission
 * 3. Network Invoice vs Network Payment
 * 4. Network Payment vs MBO Actual Receipt
 * 5. MBO Receipt vs Client Payable
 *
 * Missing source evidence is not a numeric mismatch and must never be filled from
 * an internal MBO amount. It is CANNOT_RECONCILE / SOURCE_DATA_MISSING.
 */

export const RECONCILIATION_PAIR = {
  NETWORK_ORDERS_VS_MBO_ORDERS: "NETWORK_ORDERS_VS_MBO_ORDERS",
  NETWORK_COMMISSION_VS_MBO_GROSS: "NETWORK_COMMISSION_VS_MBO_GROSS",
  NETWORK_INVOICE_VS_NETWORK_PAYMENT: "NETWORK_INVOICE_VS_NETWORK_PAYMENT",
  NETWORK_PAYMENT_VS_MBO_RECEIPT: "NETWORK_PAYMENT_VS_MBO_RECEIPT",
  MBO_RECEIPT_VS_CLIENT_PAYABLE: "MBO_RECEIPT_VS_CLIENT_PAYABLE",
};

export const RECONCILIATION_PAIR_LABELS = {
  [RECONCILIATION_PAIR.NETWORK_ORDERS_VS_MBO_ORDERS]: "Network Orders vs MBO Orders",
  [RECONCILIATION_PAIR.NETWORK_COMMISSION_VS_MBO_GROSS]: "Network Commission vs MBO Gross",
  [RECONCILIATION_PAIR.NETWORK_INVOICE_VS_NETWORK_PAYMENT]: "Network Invoice vs Network Payment",
  [RECONCILIATION_PAIR.NETWORK_PAYMENT_VS_MBO_RECEIPT]: "Network Payment vs MBO Receipt",
  [RECONCILIATION_PAIR.MBO_RECEIPT_VS_CLIENT_PAYABLE]: "MBO Receipt vs Client Payable",
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

export const CLIENT_PAYABLE_BLOCKING_PAIRS = new Set([
  RECONCILIATION_PAIR.NETWORK_PAYMENT_VS_MBO_RECEIPT,
  RECONCILIATION_PAIR.MBO_RECEIPT_VS_CLIENT_PAYABLE,
  RECONCILIATION_PAIR.NETWORK_COMMISSION_VS_MBO_GROSS,
]);

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
 * Run all five pairwise reconciliation checks.
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
      pair: RECONCILIATION_PAIR.MBO_RECEIPT_VS_CLIENT_PAYABLE,
      left: mboActualReceiptAmount,
      right: clientPayableAmount,
      leftLabel: "MBO actual receipt",
      rightLabel: "Client payable",
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

export function shouldBlockClientPayableRelease(checks = []) {
  return checks.some(
    (check) =>
      !check.ok &&
      !check.skipped &&
      check.material &&
      CLIENT_PAYABLE_BLOCKING_PAIRS.has(check.pair),
  );
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
