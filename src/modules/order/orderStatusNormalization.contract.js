/**
 * Pointer 16 — Status normalization contract.
 * Preserve network_raw_status exactly; map separately to MBO canonical order status.
 * Unknown source values → mapping exception — never guess nearest canonical status.
 */

export const MBO_ORDER_STATUS = Object.freeze({
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
});

/** Exact lookup only — no fuzzy / substring matching. */
const NETWORK_TO_MBO_ORDER = Object.freeze({
  PENDING: MBO_ORDER_STATUS.PENDING,
  OPEN: MBO_ORDER_STATUS.PENDING,
  HELD: MBO_ORDER_STATUS.PENDING,
  ONHOLD: MBO_ORDER_STATUS.PENDING,
  ON_HOLD: MBO_ORDER_STATUS.PENDING,
  WAITING: MBO_ORDER_STATUS.PENDING,
  APPROVED: MBO_ORDER_STATUS.CONFIRMED,
  VALIDATED: MBO_ORDER_STATUS.CONFIRMED,
  CONFIRMED: MBO_ORDER_STATUS.CONFIRMED,
  ACCEPTED: MBO_ORDER_STATUS.CONFIRMED,
  COMPLETE: MBO_ORDER_STATUS.CONFIRMED,
  COMPLETED: MBO_ORDER_STATUS.CONFIRMED,
  PAID: MBO_ORDER_STATUS.CONFIRMED,
  INVOICED: MBO_ORDER_STATUS.CONFIRMED,
  PAYABLE: MBO_ORDER_STATUS.CONFIRMED,
  REJECTED: MBO_ORDER_STATUS.REJECTED,
  DECLINED: MBO_ORDER_STATUS.REJECTED,
  DENIED: MBO_ORDER_STATUS.REJECTED,
  INVALID: MBO_ORDER_STATUS.REJECTED,
  REVERSED: MBO_ORDER_STATUS.REJECTED,
  CANCELLED: MBO_ORDER_STATUS.CANCELLED,
  CANCELED: MBO_ORDER_STATUS.CANCELLED,
  VOID: MBO_ORDER_STATUS.CANCELLED,
  VOIDED: MBO_ORDER_STATUS.CANCELLED,
});

/** Payment lifecycle is separate from order status — exact payment tokens only. */
const NETWORK_TO_SUPPLIER_PAYMENT = Object.freeze({
  PAID: "PAYMENT_RECEIVED",
  INVOICED: "PAYMENT_INVOICED",
  PAYABLE: "PAYMENT_PAYABLE",
  RECEIVED: "PAYMENT_RECEIVED",
});

/**
 * Store network status exactly as received (string casing preserved; numbers/booleans stringified).
 */
export function preserveNetworkRawStatus(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw === "" ? null : raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return null;
}

function lookupKey(raw) {
  const preserved = preserveNetworkRawStatus(raw);
  if (preserved == null) return null;
  return preserved.trim().toUpperCase().replace(/\s+/g, "_");
}

/**
 * @returns {{
 *   networkRawStatus: string|null,
 *   mboOrderStatus: string|null,
 *   mapped: boolean,
 *   mappingExceptionRequired: boolean,
 * }}
 */
export function resolveOrderStatusFromNetworkRaw(raw, { supplier = null } = {}) {
  const networkRawStatus = preserveNetworkRawStatus(raw);
  if (networkRawStatus == null) {
    return {
      networkRawStatus: null,
      mboOrderStatus: null,
      mapped: false,
      mappingExceptionRequired: false,
      supplier,
    };
  }

  const key = lookupKey(raw);
  const mboOrderStatus = key ? NETWORK_TO_MBO_ORDER[key] ?? null : null;
  const mapped = mboOrderStatus != null;

  return {
    networkRawStatus,
    mboOrderStatus,
    mapped,
    mappingExceptionRequired: !mapped,
    supplier,
  };
}

export function mapMboOrderStatusToValidation(mboOrderStatus) {
  switch (String(mboOrderStatus || "").toUpperCase()) {
    case MBO_ORDER_STATUS.CONFIRMED:
      return "VALIDATION_APPROVED";
    case MBO_ORDER_STATUS.REJECTED:
    case MBO_ORDER_STATUS.CANCELLED:
      return "VALIDATION_REJECTED";
    case MBO_ORDER_STATUS.PENDING:
      return "VALIDATION_PENDING";
    default:
      return null;
  }
}

/** Legacy ConversionStatus enum bridge (Prisma). */
export function mapMboOrderStatusToConversionStatus(mboOrderStatus) {
  switch (String(mboOrderStatus || "").toUpperCase()) {
    case MBO_ORDER_STATUS.CONFIRMED:
      return "APPROVED";
    case MBO_ORDER_STATUS.REJECTED:
    case MBO_ORDER_STATUS.CANCELLED:
      return "REJECTED";
    case MBO_ORDER_STATUS.PENDING:
      return "PENDING";
    default:
      return null;
  }
}

export function mapNetworkRawToSupplierPayment(raw) {
  const key = lookupKey(raw);
  if (!key) return null;
  return NETWORK_TO_SUPPLIER_PAYMENT[key] ?? null;
}

export function mboOrderStatusLabel(status) {
  if (!status) return null;
  const labels = {
    [MBO_ORDER_STATUS.PENDING]: "Pending",
    [MBO_ORDER_STATUS.CONFIRMED]: "Confirmed",
    [MBO_ORDER_STATUS.REJECTED]: "Rejected",
    [MBO_ORDER_STATUS.CANCELLED]: "Cancelled",
  };
  return labels[String(status).toUpperCase()] || String(status);
}

export function buildOrderStatusMetadata(existing = {}, resolution = {}) {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  return {
    ...base,
    network_raw_status: resolution.networkRawStatus ?? base.network_raw_status ?? null,
    networkRawStatus: resolution.networkRawStatus ?? base.networkRawStatus ?? null,
    mboOrderStatus: resolution.mboOrderStatus ?? base.mboOrderStatus ?? null,
    statusMappingExceptionRequired: resolution.mappingExceptionRequired ?? false,
  };
}
