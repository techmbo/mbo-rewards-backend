/**
 * Pointer 18 — Reconciliation logic (pairwise checks).
 *
 * Reconcile separately:
 * 1. Network Orders vs MBO Orders
 * 2. Network Commission vs MBO Gross Network Commission
 * 3. Network Invoice vs Network Payment
 * 4. Network Payment vs MBO Actual Receipt
 * 5. MBO Receipt vs Client Payable
 *
 * On mismatch: create Exception; block client payable release when financially material.
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
  SKIPPED: "SKIPPED",
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

function buildCheck({
  pair,
  left,
  right,
  leftLabel,
  rightLabel,
  materialityThreshold,
  isCount = false,
}) {
  const leftNum = isCount ? toNumber(left) : toNumber(left);
  const rightNum = isCount ? toNumber(right) : toNumber(right);

  if (bothNull(leftNum, rightNum)) {
    return {
      pair,
      label: RECONCILIATION_PAIR_LABELS[pair],
      status: RECONCILIATION_STATUS.SKIPPED,
      ok: true,
      skipped: true,
      material: false,
      left: leftNum,
      right: rightNum,
      leftLabel,
      rightLabel,
      difference: null,
      mismatchReason: null,
    };
  }

  const difference =
    leftNum != null && rightNum != null ? leftNum - rightNum : null;
  const threshold = isCount ? COUNT_MATERIALITY_THRESHOLD : materialityThreshold;
  const absDiff = difference != null ? Math.abs(difference) : null;
  const material = absDiff != null ? absDiff > threshold : true;
  const ok = difference != null ? absDiff <= threshold : false;

  let mismatchReason = null;
  if (!ok && !bothNull(leftNum, rightNum)) {
    if (leftNum == null) {
      mismatchReason = `${leftLabel} missing`;
    } else if (rightNum == null) {
      mismatchReason = `${rightLabel} missing`;
    } else if (isCount) {
      mismatchReason = `Count delta ${difference > 0 ? "+" : ""}${difference}`;
    } else {
      mismatchReason = `Amount delta ${difference > 0 ? "+" : ""}${difference.toFixed(4)}`;
    }
  }

  return {
    pair,
    label: RECONCILIATION_PAIR_LABELS[pair],
    status: ok ? RECONCILIATION_STATUS.MATCHED : RECONCILIATION_STATUS.MISMATCH,
    ok,
    skipped: false,
    material: !ok && material,
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

  const materialMismatches = checks.filter((c) => c.material);
  const openMismatches = checks.filter((c) => !c.ok && !c.skipped);

  return {
    checks,
    allMatched: openMismatches.length === 0,
    hasMaterialMismatch: materialMismatches.length > 0,
    materialMismatches,
    openMismatches,
    summaryStatus:
      openMismatches.length === 0
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
    ok: check.ok,
    skipped: check.skipped,
    material: check.material,
    left: check.left,
    right: check.right,
    leftLabel: check.leftLabel,
    rightLabel: check.rightLabel,
    difference: check.difference,
    mismatchReason: check.mismatchReason,
  }));
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function resolveNetworkReconRowStatus(reconciliationResult) {
  if (!reconciliationResult) return "UNKNOWN";
  if (reconciliationResult.allMatched) return "MATCHED";
  if (reconciliationResult.hasMaterialMismatch) return "MISMATCH";
  if (reconciliationResult.openMismatches?.length) return "PARTIAL";
  return "PENDING";
}
