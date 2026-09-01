/**
 * Pointer 19 — Reprocessing contract.
 * Fix mapping → new mapping version → preserved raw records → reprocess →
 * idempotent canonical upsert → before/after compare → reconciliation → validated exception close.
 * Never mutate immutable raw payload body/hash/bodyRef.
 */

export const REPROCESS_STAGE = Object.freeze({
  LOAD_RAW: "LOAD_RAW",
  SNAPSHOT_BEFORE: "SNAPSHOT_BEFORE",
  APPLY_MAPPING: "APPLY_MAPPING",
  CANONICAL_UPSERT: "CANONICAL_UPSERT",
  SNAPSHOT_AFTER: "SNAPSHOT_AFTER",
  COMPARE: "COMPARE",
  RECONCILE: "RECONCILE",
  CLOSE_EXCEPTION: "CLOSE_EXCEPTION",
});

export const REPROCESS_MODES = Object.freeze({
  MAP_ONLY: "MAP_ONLY",
  FULL: "FULL",
});

/** Fields compared per entity type for before/after diff. */
export const CANONICAL_DIFF_FIELDS = Object.freeze({
  conversion: [
    "validationStatus",
    "mboOrderStatus",
    "supplierPaymentStatus",
    "clientPaymentStatus",
    "orderValue",
    "currency",
    "supplierOrderId",
    "supplierConversionId",
  ],
  campaign: [
    "campaignName",
    "campaignStatus",
    "defaultCommissionValue",
    "commissionUnit",
    "trackingUrl",
    "supplierCampaignId",
  ],
  coupon: ["couponCode", "couponStatus", "discountValue", "couponType", "supplierCouponId"],
});

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeEntityType(value) {
  return String(value || "").toLowerCase();
}

export function pickCanonicalSnapshot(record, entityType) {
  if (!record || typeof record !== "object") return null;
  const type = normalizeEntityType(entityType);
  const fields = CANONICAL_DIFF_FIELDS[type] || Object.keys(record).slice(0, 12);
  const snapshot = { id: record.id ?? null, entityType: type };
  for (const key of fields) {
    if (record[key] !== undefined) snapshot[key] = record[key];
  }
  if (type === "conversion" && record.metadata) {
    const meta = asObject(record.metadata);
    if (meta.networkRawStatus != null) snapshot.networkRawStatus = meta.networkRawStatus;
    if (meta.mboOrderStatus != null && snapshot.mboOrderStatus == null) {
      snapshot.mboOrderStatus = meta.mboOrderStatus;
    }
  }
  return snapshot;
}

export function buildCanonicalDiff(before, after, entityType) {
  const type = normalizeEntityType(entityType);
  const fields = CANONICAL_DIFF_FIELDS[type] || [];
  const changes = [];
  const allKeys = new Set([
    ...fields,
    ...Object.keys(asObject(before)),
    ...Object.keys(asObject(after)),
  ]);

  for (const key of allKeys) {
    if (key === "id" || key === "entityType") continue;
    const left = before?.[key] ?? null;
    const right = after?.[key] ?? null;
    const same =
      left === right ||
      (left != null && right != null && String(left) === String(right));
    if (!same) {
      changes.push({ field: key, before: left, after: right });
    }
  }

  return {
    entityType: type,
    changed: changes.length > 0,
    changes,
    before: before ?? null,
    after: after ?? null,
  };
}

export function validateReprocessClose({
  mappingOk = false,
  upsertOk = false,
  upsertResult = null,
  reconciliation = null,
  diff = null,
  requireDiffChange = false,
} = {}) {
  const reasons = [];
  if (!mappingOk) reasons.push("mapping_failed");
  if (!upsertOk) reasons.push("upsert_failed");
  if (requireDiffChange && diff && !diff.changed) reasons.push("no_canonical_change");
  if (reconciliation?.blocked === true) reasons.push("reconciliation_blocked");
  if (reconciliation?.ok === false && reconciliation?.material === true) {
    reasons.push("reconciliation_material_mismatch");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    upsertResult,
  };
}

export function canCloseReprocessException(validation) {
  return validateReprocessClose(validation).ok;
}

export function summarizeReprocessResult(result) {
  return {
    rawPayloadId: result.rawPayloadId,
    ok: result.ok,
    mode: result.mode,
    mappingVersion: result.mappingVersion,
    entityType: result.entityType,
    upsert: result.upsert ?? null,
    diff: result.diff ?? null,
    reconciliation: result.reconciliation ?? null,
    closedExceptions: result.closedExceptions ?? [],
    payloadImmutable: result.payloadImmutable !== false,
    error: result.error ?? null,
  };
}
