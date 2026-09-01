/**
 * Pointer 16 / PR4 — source-scoped status normalization contract.
 *
 * Non-negotiable rules:
 * - preserve network_raw_status exactly as received;
 * - network order status and supplier payment status are separate domains;
 * - mappings are exact and scoped by supplier + source object/report;
 * - unknown or contextless network values require review — never guess a nearest canonical status;
 * - payment words such as PAID / INVOICED / PAYABLE do not confirm an order unless a
 *   verified source-scoped ORDER mapping explicitly says they do.
 */

export const MBO_ORDER_STATUS = Object.freeze({
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
});

export const STATUS_MAPPING_STATUS = Object.freeze({
  MAPPED: "MAPPED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  SOURCE_NULL: "SOURCE_NULL",
});

/**
 * Verified mappings belong here only after a sanitized live fixture, approved MBO mapping,
 * or verified supplier documentation proves the exact source semantics.
 *
 * Shape:
 * {
 *   supplier: "IMPACT",
 *   sourceObject: "ACTION",
 *   sourceReport: null,
 *   rawStatus: "REVERSED",
 *   mboOrderStatus: MBO_ORDER_STATUS.REJECTED,
 *   supplierPaymentStatus: null,
 *   evidence: "verified-doc-or-fixture-reference"
 * }
 *
 * PR4 intentionally starts empty rather than carrying the previous universal guesses.
 */
export const VERIFIED_NETWORK_STATUS_REGISTRY = Object.freeze([]);

/**
 * Store network status exactly as received (string casing/spacing preserved;
 * numbers/booleans stringified).
 */
export function preserveNetworkRawStatus(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw === "" ? null : raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return null;
}

function normalizeScope(value) {
  if (value == null || value === "") return null;
  return String(value).trim().toUpperCase();
}

function sourceScope({ supplier = null, sourceObject = null, sourceReport = null } = {}) {
  return {
    supplier: normalizeScope(supplier),
    sourceObject: normalizeScope(sourceObject),
    sourceReport: normalizeScope(sourceReport),
  };
}

function hasSourceScope(scope) {
  return Boolean(scope.supplier && (scope.sourceObject || scope.sourceReport));
}

function exactScopedEntries(registry, scope, networkRawStatus) {
  const rows = Array.isArray(registry) ? registry : [];
  return rows.filter((row) => {
    const rowScope = sourceScope(row);
    if (rowScope.supplier !== scope.supplier) return false;

    // When a report is supplied by the caller, a registry row that specifies a report
    // must match it exactly. A source-object-only row may still apply to all reports for
    // that proven object. When only sourceObject is known, report-specific rows do not match.
    if (scope.sourceReport) {
      if (rowScope.sourceReport && rowScope.sourceReport !== scope.sourceReport) return false;
    } else if (rowScope.sourceReport) {
      return false;
    }

    if (scope.sourceObject) {
      if (!rowScope.sourceObject || rowScope.sourceObject !== scope.sourceObject) return false;
    } else if (rowScope.sourceObject) {
      return false;
    }

    // Exact raw token comparison by design. No trim/case/fuzzy normalization here.
    return preserveNetworkRawStatus(row?.rawStatus) === networkRawStatus;
  });
}

function uniqueMappedValue(entries, field) {
  const values = [...new Set(entries.map((row) => row?.[field]).filter(Boolean))];
  return values.length === 1 ? values[0] : null;
}

function mappingReason({ networkRawStatus, scope, entries, field }) {
  if (networkRawStatus == null) return "source_status_missing";
  if (!hasSourceScope(scope)) return "source_context_missing";
  if (!entries.length) return "source_status_mapping_not_verified";
  const values = [...new Set(entries.map((row) => row?.[field]).filter(Boolean))];
  if (values.length > 1) return "conflicting_verified_mappings";
  if (!values.length) return `verified_scope_has_no_${field}_mapping`;
  return null;
}

/**
 * Resolve supplier/network order state from exact, verified source context.
 */
export function resolveOrderStatusFromNetworkRaw(
  raw,
  {
    supplier = null,
    sourceObject = null,
    sourceReport = null,
    registry = VERIFIED_NETWORK_STATUS_REGISTRY,
  } = {},
) {
  const networkRawStatus = preserveNetworkRawStatus(raw);
  const scope = sourceScope({ supplier, sourceObject, sourceReport });

  if (networkRawStatus == null) {
    return {
      networkRawStatus: null,
      mboOrderStatus: null,
      mapped: false,
      mappingExceptionRequired: false,
      mappingStatus: STATUS_MAPPING_STATUS.SOURCE_NULL,
      mappingReason: "source_status_missing",
      ...scope,
    };
  }

  const entries = hasSourceScope(scope)
    ? exactScopedEntries(registry, scope, networkRawStatus)
    : [];
  const mboOrderStatus = uniqueMappedValue(entries, "mboOrderStatus");
  const mapped = Boolean(mboOrderStatus);

  return {
    networkRawStatus,
    mboOrderStatus,
    mapped,
    mappingExceptionRequired: !mapped,
    mappingStatus: mapped
      ? STATUS_MAPPING_STATUS.MAPPED
      : STATUS_MAPPING_STATUS.REVIEW_REQUIRED,
    mappingReason: mapped
      ? null
      : mappingReason({ networkRawStatus, scope, entries, field: "mboOrderStatus" }),
    ...scope,
  };
}

/**
 * Resolve supplier payment lifecycle independently from order validation.
 */
export function resolveSupplierPaymentStatusFromNetworkRaw(
  raw,
  {
    supplier = null,
    sourceObject = null,
    sourceReport = null,
    registry = VERIFIED_NETWORK_STATUS_REGISTRY,
  } = {},
) {
  const networkRawStatus = preserveNetworkRawStatus(raw);
  const scope = sourceScope({ supplier, sourceObject, sourceReport });

  if (networkRawStatus == null) {
    return {
      networkRawStatus: null,
      supplierPaymentStatus: null,
      mapped: false,
      mappingExceptionRequired: false,
      mappingStatus: STATUS_MAPPING_STATUS.SOURCE_NULL,
      mappingReason: "source_status_missing",
      ...scope,
    };
  }

  const entries = hasSourceScope(scope)
    ? exactScopedEntries(registry, scope, networkRawStatus)
    : [];
  const supplierPaymentStatus = uniqueMappedValue(entries, "supplierPaymentStatus");
  const mapped = Boolean(supplierPaymentStatus);

  return {
    networkRawStatus,
    supplierPaymentStatus,
    mapped,
    mappingExceptionRequired: !mapped,
    mappingStatus: mapped
      ? STATUS_MAPPING_STATUS.MAPPED
      : STATUS_MAPPING_STATUS.REVIEW_REQUIRED,
    mappingReason: mapped
      ? null
      : mappingReason({ networkRawStatus, scope, entries, field: "supplierPaymentStatus" }),
    ...scope,
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

/** Backward-compatible convenience wrapper. Contextless network tokens now resolve to null. */
export function mapNetworkRawToSupplierPayment(raw, options = {}) {
  return resolveSupplierPaymentStatusFromNetworkRaw(raw, options).supplierPaymentStatus;
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
    statusMappingExceptionRequired:
      resolution.mappingExceptionRequired ?? base.statusMappingExceptionRequired ?? false,
    statusMappingStatus: resolution.mappingStatus ?? base.statusMappingStatus ?? null,
    statusMappingReason: resolution.mappingReason ?? base.statusMappingReason ?? null,
    statusMappingSupplier: resolution.supplier ?? base.statusMappingSupplier ?? null,
    statusMappingSourceObject: resolution.sourceObject ?? base.statusMappingSourceObject ?? null,
    statusMappingSourceReport: resolution.sourceReport ?? base.statusMappingSourceReport ?? null,
  };
}
