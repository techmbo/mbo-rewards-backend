/**
 * Pointer 15 — Attribution logic contract.
 * Priority: MBO click/token → unique coupon → single assignment → REVIEW_REQUIRED.
 * Never guess client assignment; shared coupons cannot uniquely attribute alone.
 */

import { MBO_CANONICAL_OBJECT } from "../mapping/mboCanonicalObjects.contract.js";

export const ATTRIBUTION_OBJECT = MBO_CANONICAL_OBJECT.CLIENT_CAMPAIGN_ASSIGNMENT;

export const ATTRIBUTION_PRIORITY = Object.freeze({
  MBO_CLICK_OR_TOKEN: 1,
  UNIQUE_COUPON: 2,
  SINGLE_ASSIGNMENT: 3,
  REVIEW_REQUIRED: 4,
  UNATTRIBUTED: 5,
});

export const ATTRIBUTION_EVIDENCE = Object.freeze({
  MBO_CLICK: "mbo_click",
  NETWORK_SUBID: "network_subid",
  TRACKING_LINK: "tracking_link",
  ASSIGNMENT_HINT: "assignment_hint",
  UNIQUE_COUPON: "unique_coupon",
  SINGLE_ASSIGNMENT: "single_assignment",
});

export const ATTRIBUTION_REVIEW_REASON = Object.freeze({
  SHARED_COUPON: "shared_coupon_ambiguous",
  MULTIPLE_ASSIGNMENTS: "multiple_assignments_for_source",
  AMBIGUOUS: "ambiguous_evidence",
});

const EVIDENCE_PRIORITY = Object.freeze({
  [ATTRIBUTION_EVIDENCE.MBO_CLICK]: ATTRIBUTION_PRIORITY.MBO_CLICK_OR_TOKEN,
  [ATTRIBUTION_EVIDENCE.NETWORK_SUBID]: ATTRIBUTION_PRIORITY.MBO_CLICK_OR_TOKEN,
  [ATTRIBUTION_EVIDENCE.TRACKING_LINK]: ATTRIBUTION_PRIORITY.MBO_CLICK_OR_TOKEN,
  [ATTRIBUTION_EVIDENCE.ASSIGNMENT_HINT]: ATTRIBUTION_PRIORITY.MBO_CLICK_OR_TOKEN,
  [ATTRIBUTION_EVIDENCE.UNIQUE_COUPON]: ATTRIBUTION_PRIORITY.UNIQUE_COUPON,
  [ATTRIBUTION_EVIDENCE.SINGLE_ASSIGNMENT]: ATTRIBUTION_PRIORITY.SINGLE_ASSIGNMENT,
});

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function first(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/**
 * Network SubID / ClickRef / UID / u1 and explicit assignment tokens from raw conversion payload.
 */
export function extractAttributionHints(rawData = {}) {
  const raw = asObject(rawData);
  const extended = asObject(raw.extendedData);

  const clickId = first(
    raw.click_id,
    raw.clickId,
    raw.ClickId,
    raw.SubId3,
    raw.subId3,
    raw.p3,
    raw.clickref,
    extended.ex3,
  );
  const assignmentId = first(
    raw.p2,
    raw.UID2,
    raw.uid2,
    raw.SubId2,
    raw.subId2,
    raw.pubref,
    raw.assignment_id,
    raw.assignmentId,
    extended.ex2,
  );
  const clientId = first(
    raw.p1,
    raw.UID,
    raw.uid,
    raw.SubId1,
    raw.subId1,
    raw.sub1,
    raw.aff_sub,
    raw.adref,
    raw.client_id,
    raw.clientId,
    extended.ex1,
  );
  const subId = first(
    raw.sub_id,
    raw.subId,
    raw.aff_sub,
    raw.sub1,
    raw.p3 && String(raw.p3) !== String(clickId) ? raw.p3 : null,
  );
  const couponCode = first(raw.voucher, raw.coupon, raw.coupon_code, raw.couponCode);

  return {
    clickId: clickId != null ? String(clickId) : null,
    assignmentId: assignmentId != null ? String(assignmentId) : null,
    clientId: clientId != null ? String(clientId) : null,
    subId: subId != null ? String(subId) : null,
    couponCode: couponCode != null ? String(couponCode) : null,
  };
}

export function extractCouponCodeHint(conversion = {}) {
  const hints = asObject(conversion.metadata?.attributionHints);
  const meta = asObject(conversion.metadata);
  const raw = hints.couponCode ?? meta.couponCode ?? meta.voucher ?? meta.coupon ?? null;
  const code = raw != null ? String(raw).trim() : "";
  return code || null;
}

/** Client id alone is never sufficient to pick an assignment. */
export function isClientIdOnlyAttributionHints(hints = {}) {
  const h = asObject(hints);
  const hasClient = Boolean(h.clientId);
  const hasStronger = Boolean(h.clickId || h.subId || h.assignmentId);
  return hasClient && !hasStronger;
}

export function classifyAttributionPriority({ evidence = null, reviewRequired = false } = {}) {
  if (reviewRequired) return ATTRIBUTION_PRIORITY.REVIEW_REQUIRED;
  if (evidence && EVIDENCE_PRIORITY[evidence] != null) return EVIDENCE_PRIORITY[evidence];
  return ATTRIBUTION_PRIORITY.UNATTRIBUTED;
}

export function attributionEvidenceLabel(evidence) {
  if (!evidence) return null;
  const map = {
    [ATTRIBUTION_EVIDENCE.MBO_CLICK]: "MBO Click",
    [ATTRIBUTION_EVIDENCE.NETWORK_SUBID]: "Network SubID",
    [ATTRIBUTION_EVIDENCE.TRACKING_LINK]: "Tracking Link",
    [ATTRIBUTION_EVIDENCE.ASSIGNMENT_HINT]: "Assignment Token",
    [ATTRIBUTION_EVIDENCE.UNIQUE_COUPON]: "Unique Coupon",
    [ATTRIBUTION_EVIDENCE.SINGLE_ASSIGNMENT]: "Single Assignment",
  };
  return map[evidence] || String(evidence);
}

export function attributionReviewReasonLabel(reason) {
  if (!reason) return null;
  if (reason === ATTRIBUTION_REVIEW_REASON.SHARED_COUPON) {
    return "Shared coupon — multiple clients";
  }
  if (reason === ATTRIBUTION_REVIEW_REASON.MULTIPLE_ASSIGNMENTS) {
    return "Multiple assignments for campaign";
  }
  return String(reason).replaceAll("_", " ");
}

export function buildAttributionReviewMetadata({
  reason,
  evidence = null,
  candidateAssignmentIds = [],
  couponCode = null,
} = {}) {
  return {
    reason: reason || ATTRIBUTION_REVIEW_REASON.AMBIGUOUS,
    evidence,
    candidateAssignmentIds,
    couponCode,
    priority: ATTRIBUTION_PRIORITY.REVIEW_REQUIRED,
  };
}

export function buildAttributedMetadata(existing = {}, { evidence = null } = {}) {
  return {
    ...asObject(existing),
    attributionEvidence: evidence,
    attributionPriority: classifyAttributionPriority({ evidence }),
    mboCanonicalObject: MBO_CANONICAL_OBJECT.ORDER_CONVERSION,
  };
}

export function shouldExposeClientFromConversion(conversion = {}) {
  const status = String(conversion.attributionStatus || "").toUpperCase();
  return status === "ATTRIBUTED" || status === "REATTRIBUTED";
}

export function resolveDisplayClientFromConversion(conversion = null, order = null) {
  if (order?.clientId && order?.client?.name) {
    return { clientId: order.clientId, clientName: order.client.name };
  }
  if (!shouldExposeClientFromConversion(conversion)) {
    return { clientId: null, clientName: null };
  }
  const client = conversion?.clientAssignment?.client;
  if (client?.id) {
    return { clientId: client.id, clientName: client.name ?? null };
  }
  return { clientId: conversion?.clientAssignment?.clientId ?? null, clientName: null };
}
