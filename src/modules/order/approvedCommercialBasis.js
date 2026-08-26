/**
 * Epic 9 — resolve approved commercial basis from OrderItem validation (VAL-006).
 *
 * FULL_ORDER_LEGACY: no item has validationStatus set → preserve pre–Epic 9 behavior.
 * ITEM_LEVEL: at least one item has a non-null validationStatus → only APPROVED items contribute.
 *
 * Never uses Product.price. Never fabricates supplier commission.
 */

const ROUND = (n) => Number(Number(n).toFixed(4));

function numOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} order — Order with optional `items[]`
 * @param {object|null} conversion
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   basisMode: 'FULL_ORDER_LEGACY'|'ITEM_LEVEL',
 *   approvedItemCount: number,
 *   rejectedItemCount: number,
 *   pendingItemCount: number,
 *   needsReviewItemCount: number,
 *   unknownItemCount: number,
 *   totalItemCount: number,
 *   allItemsApproved: boolean,
 *   approvedOrderValue: number|null,
 *   approvedSupplierCommission: number|null,
 *   approvedOrderValueOk: boolean,
 *   approvedSupplierCommissionOk: boolean,
 *   currency: string|null,
 *   source: object,
 *   approvedLineKeys: string[],
 * }}
 */
export function resolveApprovedCommercialBasis(order, conversion = null) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const currency =
    (order?.currency && String(order.currency).toUpperCase()) ||
    (conversion?.currency && String(conversion.currency).toUpperCase()) ||
    null;

  const hasItemLevel = items.some((i) => i.validationStatus != null && i.validationStatus !== "");

  if (!hasItemLevel) {
    const fullOrderValue = numOrNull(order?.orderValue);
    const supplierRaw =
      conversion?.approvedCommission != null && conversion.approvedCommission !== ""
        ? conversion.approvedCommission
        : conversion?.supplierCommission;
    const fullSupplier = numOrNull(supplierRaw);

    return {
      ok: true,
      basisMode: "FULL_ORDER_LEGACY",
      approvedItemCount: 0,
      rejectedItemCount: 0,
      pendingItemCount: 0,
      needsReviewItemCount: 0,
      unknownItemCount: items.length,
      totalItemCount: items.length,
      allItemsApproved: true,
      approvedOrderValue: fullOrderValue,
      approvedSupplierCommission: fullSupplier,
      approvedOrderValueOk: fullOrderValue != null && fullOrderValue >= 0,
      approvedSupplierCommissionOk: fullSupplier != null && fullSupplier >= 0,
      currency,
      source: {
        orderValue: "order.orderValue_or_conversion_metadata_via_engine",
        supplierCommission: "conversion.approvedCommission|supplierCommission",
      },
      approvedLineKeys: [],
    };
  }

  let approvedItemCount = 0;
  let rejectedItemCount = 0;
  let pendingItemCount = 0;
  let needsReviewItemCount = 0;
  let unknownItemCount = 0;
  const approved = [];
  const approvedLineKeys = [];

  for (const item of items) {
    const st = item.validationStatus == null || item.validationStatus === "" ? null : String(item.validationStatus);
    if (st === "VALIDATION_APPROVED") {
      approvedItemCount += 1;
      approved.push(item);
      approvedLineKeys.push(item.lineKey ?? item.id);
    } else if (st === "VALIDATION_REJECTED") {
      rejectedItemCount += 1;
    } else if (st === "VALIDATION_PENDING") {
      pendingItemCount += 1;
    } else if (st === "VALIDATION_NEEDS_REVIEW") {
      needsReviewItemCount += 1;
    } else {
      unknownItemCount += 1;
    }
  }

  const allItemsApproved =
    items.length > 0 &&
    approvedItemCount === items.length &&
    rejectedItemCount === 0 &&
    pendingItemCount === 0 &&
    needsReviewItemCount === 0 &&
    unknownItemCount === 0;

  // Approved order value = sum of approved itemValues only (never Product.price).
  let approvedOrderValue = 0;
  let missingItemValue = false;
  for (const item of approved) {
    const v = numOrNull(item.itemValue);
    if (v == null || v < 0) {
      missingItemValue = true;
      break;
    }
    approvedOrderValue += v;
  }
  if (approved.length === 0) {
    approvedOrderValue = 0;
    missingItemValue = false;
  }

  // Approved supplier commission = sum of approved item.commission when every approved line has it.
  let approvedSupplierCommission = 0;
  let missingItemCommission = false;
  for (const item of approved) {
    const c = numOrNull(item.commission);
    if (c == null || c < 0) {
      missingItemCommission = true;
      break;
    }
    approvedSupplierCommission += c;
  }
  if (approved.length === 0) {
    approvedSupplierCommission = 0;
    missingItemCommission = false;
  }

  return {
    ok: true,
    basisMode: "ITEM_LEVEL",
    approvedItemCount,
    rejectedItemCount,
    pendingItemCount,
    needsReviewItemCount,
    unknownItemCount,
    totalItemCount: items.length,
    allItemsApproved,
    approvedOrderValue: missingItemValue ? null : ROUND(approvedOrderValue),
    approvedSupplierCommission: missingItemCommission ? null : ROUND(approvedSupplierCommission),
    approvedOrderValueOk: !missingItemValue && approvedOrderValue >= 0,
    approvedSupplierCommissionOk: !missingItemCommission && approvedSupplierCommission >= 0,
    currency,
    source: {
      orderValue: "sum(orderItem.itemValue where VALIDATION_APPROVED)",
      supplierCommission: "sum(orderItem.commission where VALIDATION_APPROVED)",
      neverUsedProductPrice: true,
    },
    approvedLineKeys,
  };
}

/**
 * Deterministic fingerprint of approved basis for adjustment keys (not a recognition key change).
 */
export function approvedBasisFingerprint(basis) {
  if (!basis) return "none";
  if (basis.basisMode === "FULL_ORDER_LEGACY") return "legacy:full";
  const keys = [...(basis.approvedLineKeys || [])].map(String).sort().join(",");
  return `items:${keys}|ov:${basis.approvedOrderValue ?? "x"}|sc:${basis.approvedSupplierCommission ?? "x"}`;
}
