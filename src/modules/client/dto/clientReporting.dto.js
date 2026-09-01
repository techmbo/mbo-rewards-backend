/**
 * Client-safe order / payment-status DTOs (v15 09C / 05A).
 * Never expose supplier internals, MBO margin, or supplier receivable.
 */

function money(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(4)) : null;
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Map Order validation + client payment states → v15 client-facing vocabulary.
 * @returns {"Pending"|"Confirmed"|"Rejected"|"Payable"|"Paid"|"On Hold"}
 */
export function mapClientFacingOrderStatus(order) {
  const validation = String(order?.validationStatus || "").toUpperCase();
  const clientPay = String(order?.clientPaymentStatus || "").toUpperCase();

  if (validation === "VALIDATION_REJECTED") return "Rejected";
  if (validation === "VALIDATION_NEEDS_REVIEW" || clientPay === "CLIENT_PAYMENT_ON_HOLD") {
    return "On Hold";
  }
  if (clientPay === "CLIENT_PAYMENT_PAID") return "Paid";
  if (
    clientPay === "CLIENT_PAYMENT_PAYABLE" ||
    clientPay === "CLIENT_PAYMENT_INVOICED" ||
    clientPay === "CLIENT_PAYMENT_PROCESSING"
  ) {
    return "Payable";
  }
  if (validation === "VALIDATION_APPROVED") return "Confirmed";
  return "Pending";
}

/**
 * Client-facing payment_status on an order row (09C).
 */
export function mapClientFacingPaymentStatus(order) {
  const clientPay = String(order?.clientPaymentStatus || "").toUpperCase();
  if (clientPay === "CLIENT_PAYMENT_PAID") return "Paid";
  if (clientPay === "CLIENT_PAYMENT_ON_HOLD") return "On Hold";
  if (
    clientPay === "CLIENT_PAYMENT_PAYABLE" ||
    clientPay === "CLIENT_PAYMENT_INVOICED" ||
    clientPay === "CLIENT_PAYMENT_PROCESSING"
  ) {
    return "Payable";
  }
  if (String(order?.validationStatus || "").toUpperCase() === "VALIDATION_REJECTED") {
    return "Rejected";
  }
  if (String(order?.validationStatus || "").toUpperCase() === "VALIDATION_APPROVED") {
    return "Confirmed";
  }
  return "Pending";
}

export function toClientOrderItemDto(item) {
  if (!item) return null;
  const rawStatus = item.validationStatus;
  const itemValidationStatus =
    rawStatus == null || rawStatus === ""
      ? "UNKNOWN"
      : String(rawStatus).replace(/^VALIDATION_/, "");
  return {
    lineKey: item.lineKey ?? null,
    sku: item.sku ?? null,
    quantity: item.quantity != null ? Number(item.quantity) : null,
    unitPrice: money(item.unitPrice),
    itemValue: money(item.itemValue),
    // item.commission may be supplier-side; only expose if clearly client commission in metadata — omit supplier commission
    clientCommission: null,
    currency: item.currency ?? null,
    // Epic 9 — client-safe item validation (no supplier/finance internals)
    itemValidationStatus,
  };
}

/**
 * @param {object} order — prisma Order with merchant, canonicalCampaign, items, financialTransactions, conversions
 * @param {{ clientCommission: number|null, commissionSource: string }} commission
 */
export function toClientOrderDto(order, commission) {
  const brandName =
    order?.merchant?.displayName ||
    order?.canonicalCampaign?.merchant?.displayName ||
    order?.canonicalCampaign?.displayName ||
    null;

  return {
    orderId: order.id,
    brandName,
    campaignId: order.canonicalCampaignId ?? null,
    campaignName: order.canonicalCampaign?.displayName ?? null,
    orderValue: money(order.orderValue),
    orderStatus: mapClientFacingOrderStatus(order),
    paymentStatus: mapClientFacingPaymentStatus(order),
    clientCommission: commission.clientCommission,
    commissionSource: commission.commissionSource,
    currency: order.currency ?? null,
    orderDate: toIso(order.orderDate),
    orderConfirmedDate: toIso(
      order.validationStatus === "VALIDATION_APPROVED" || order.validationStatus === "VALIDATION_REJECTED"
        ? order.validationChangedAt
        : null,
    ),
    orderPaymentConfirmedDate: toIso(
      order.clientPaymentStatus === "CLIENT_PAYMENT_PAID" ? order.clientPaymentChangedAt : null,
    ),
    items: Array.isArray(order.items) ? order.items.map(toClientOrderItemDto).filter(Boolean) : [],
  };
}

export function toClientPaymentStatusDto(row) {
  const payable =
    row.payableCommission == null || row.payableCommission === ""
      ? null
      : money(row.payableCommission);
  return {
    id:
      row.id ||
      `${row.billingYear}-${row.billingMonth}|${row.brandName || ""}|${row.campaignSourceId || ""}|${row.commercialModel || ""}|${row.currency || ""}|${row.paymentStatus || ""}`,
    billingMonth: row.billingMonth ?? null,
    billingYear: row.billingYear ?? null,
    month: row.billingMonth ?? null,
    year: row.billingYear ?? null,
    date: row.date ?? null,
    brandName: row.brandName ?? null,
    campaignName: row.campaignName ?? null,
    /** Commercial model (CPS/CPA/…) — never LINK/COUPON channel. */
    commercialModel: row.commercialModel ?? row.campaignTypeCommercial ?? null,
    /** @deprecated alias of commercialModel for older clients — still commercial, not channel */
    campaignType: row.commercialModel ?? row.campaignTypeCommercial ?? null,
    linkClicks: null,
    payableOrders: row.payableOrders != null ? Number(row.payableOrders) : null,
    /** Client payable commission only — never supplierReceivable. */
    payableCommission: payable,
    paymentStatus: row.paymentStatus ?? null,
    currency: row.currency ?? null,
    paymentConfirmedDate: toIso(row.paymentConfirmedDate),
    orderDate: toIso(row.orderDate),
    orderConfirmDate: toIso(row.orderConfirmDate),
    orderPaymentConfirmDate: toIso(row.orderPaymentConfirmDate ?? row.paymentConfirmedDate),
    commissionSource: row.commissionSource ?? null,
    statementId: row.statementId ?? null,
    invoiceReference: row.invoiceReference ?? null,
    settlementStatus: row.settlementStatus ?? null,
    ...(row.taxAmount != null ? { taxAmount: money(row.taxAmount) } : {}),
  };
}

export const CLIENT_PAYMENT_UNAVAILABLE_FIELDS = Object.freeze([
  "linkClicks",
  "channelType",
  "taxAmount",
  "gst",
  "orderDate_when_aggregated",
  "orderConfirmDate_when_aggregated",
  "04E_persisted_grain",
]);

export const FORBIDDEN_CLIENT_PAYMENT_KEYS = [
  "supplierReceivable",
  "mboMargin",
  "mboCommission",
  "supplierCommission",
  "grossCommission",
  "rawPayload",
  "rawData",
  "supplierTrackingUrl",
  "apiKey",
  "keyHash",
  "supplierCampaignId",
];

/** Assert DTO has no forbidden keys (for tests). */
export const FORBIDDEN_CLIENT_ORDER_KEYS = [
  "supplier",
  "supplierOrderId",
  "supplierId",
  "supplierCampaignId",
  "supplierUrl",
  "supplierTrackingUrl",
  "sourceAccountLabel",
  "rawPayload",
  "rawPayloadId",
  "mappingConfig",
  "mappingVersion",
  "financeInternal",
  "commissionRuleSnapshot",
  "internalExceptionDetails",
  "mboMargin",
  "supplierReceivable",
  "supplierCommission",
  "grossCommission",
  "mboCommission",
  "lastApprovedMboCommission",
  "lastApprovedSupplierCommission",
  "metadata",
];

export const FORBIDDEN_CLIENT_PERFORMANCE_KEYS = [
  ...FORBIDDEN_CLIENT_ORDER_KEYS,
  "supplierReceivable",
  "mboMargin",
  "grossCommission",
];
