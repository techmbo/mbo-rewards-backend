/**
 * Supplier-specific MBO attribution parameter rules (Wave A + Epic 3).
 *
 * Sources:
 * - v15 catalog "Supplier API Type / Client ID Param / Assignment ID Param / Click ID Param"
 * - Existing Trackier adapter conversion filters (p1–p5, click_id)
 * - Optimise uidEnabled + v15 examples (`uid=…`)
 * - Blueprint / Handoff Impact subId1/2/3
 *
 * UNCONFIRMED / DISABLED params are never injected.
 * NEVER invent a supplier tracking parameter without official docs or live payload proof.
 */

export const TRACKING_PARAM_CONFIRMATION = {
  CONFIRMED: "CONFIRMED",
  UNCONFIRMED: "UNCONFIRMED",
  DISABLED: "DISABLED",
};

/**
 * Epic 3 explicit verification markers (documentation + tests).
 * These are NOT inventable parameter names — they flag missing proof.
 */
export const TRACKING_VERIFICATION = Object.freeze({
  OPTIMISE_CLICK_REFERENCE_UNVERIFIED: "OPTIMISE_CLICK_REFERENCE_UNVERIFIED",
  BOOSTINY_TRACKING_UNVERIFIED: "BOOSTINY_TRACKING_UNVERIFIED",
  /** @deprecated v15 12F confirmed adref/pubref/clickref — kept for test/doc compatibility */
  PARTNERIZE_TRACKING_UNVERIFIED: "PARTNERIZE_TRACKING_UNVERIFIED",
  PARTNERIZE_PRODUCTION_ECHO_UNVERIFIED: "PARTNERIZE_PRODUCTION_ECHO_UNVERIFIED",
  TRACKIER_PRODUCTION_ECHO_UNVERIFIED: "TRACKIER_PRODUCTION_ECHO_UNVERIFIED",
  IMPACT_PRODUCTION_ECHO_UNVERIFIED: "IMPACT_PRODUCTION_ECHO_UNVERIFIED",
});

/**
 * @typedef {object} TrackingParamRule
 * @property {string} supplier
 * @property {string} confirmation
 * @property {string|null} clientIdParam
 * @property {string|null} assignmentIdParam
 * @property {string|null} mboClickIdParam
 * @property {string|null} trackingLinkSubIdParam
 * @property {string|null} couponParam
 * @property {string[]} notes
 * @property {string[]} [verificationFlags]
 */

/** @type {Record<string, TrackingParamRule>} */
export const TRACKING_PARAM_RULES = {
  OPTIMISE: {
    supplier: "OPTIMISE",
    confirmation: TRACKING_PARAM_CONFIRMATION.CONFIRMED,
    // v15: Client ID Param = "UID / account configured sub ID"
    clientIdParam: "UID",
    // v15: Assignment ID Param = "UID2 / custom reference"
    assignmentIdParam: "UID2",
    // v15: "click reference if supported" — exact query name not confirmed in catalog
    mboClickIdParam: null,
    trackingLinkSubIdParam: null,
    couponParam: null,
    verificationFlags: [TRACKING_VERIFICATION.OPTIMISE_CLICK_REFERENCE_UNVERIFIED],
    notes: [
      "v15 table: Optimise link/deeplink/product → UID, UID2, click reference if supported.",
      "Click-id query param name left null (OPTIMISE_CLICK_REFERENCE_UNVERIFIED) — do not invent.",
      "Examples in v15 use uid=cca_* on Optimise base links.",
    ],
  },
  TRACKIER: {
    supplier: "TRACKIER",
    confirmation: TRACKING_PARAM_CONFIRMATION.CONFIRMED,
    // v15: sub1 / aff_sub; Trackier conversion API filters use p1–p5 (adapter)
    clientIdParam: "p1",
    assignmentIdParam: "p2",
    mboClickIdParam: "p3",
    // Also set click_id — confirmed as Trackier conversion filter + v15 click_id
    trackingLinkSubIdParam: null,
    couponParam: null,
    extraParams: {
      // Mirror mbo click id into click_id for Trackier conversion matching
      click_id: "mboClickId",
    },
    verificationFlags: [TRACKING_VERIFICATION.TRACKIER_PRODUCTION_ECHO_UNVERIFIED],
    notes: [
      "v15: Trackier → sub1/aff_sub, sub2, click_id.",
      "Adapter fetchConversions filters p1–p5 and click_id — using p1/p2/p3 on click URLs.",
      "vCommission is the same Trackier network source in this codebase.",
      "TRACKIER_PRODUCTION_ECHO_UNVERIFIED — code+adapter confirmation ≠ production payload proof.",
    ],
  },
  BOOSTINY: {
    supplier: "BOOSTINY",
    confirmation: TRACKING_PARAM_CONFIRMATION.UNCONFIRMED,
    clientIdParam: null,
    assignmentIdParam: null,
    mboClickIdParam: null,
    trackingLinkSubIdParam: null,
    couponParam: null,
    verificationFlags: [TRACKING_VERIFICATION.BOOSTINY_TRACKING_UNVERIFIED],
    notes: [
      "BOOSTINY_TRACKING_UNVERIFIED — v15 params are TBD; do not hard-code until live JSON verified.",
    ],
  },
  PARTNERIZE: {
    supplier: "PARTNERIZE",
    confirmation: TRACKING_PARAM_CONFIRMATION.CONFIRMED,
    // v15 12F_Tracking_Param_Rules (catalog PDF p.140): Client=adref, Assignment=pubref, Click=clickref
    clientIdParam: "adref",
    assignmentIdParam: "pubref",
    mboClickIdParam: "clickref",
    trackingLinkSubIdParam: null,
    couponParam: null,
    verificationFlags: [TRACKING_VERIFICATION.PARTNERIZE_PRODUCTION_ECHO_UNVERIFIED],
    notes: [
      "v15 12F CONFIRMED: adref=client_id, pubref=assignment_id, clickref=click_id.",
      "Partnerize conversion export lists clickref as click reference (CONFIRMED_OFFICIAL_DOCS).",
      "PARTNERIZE_PRODUCTION_ECHO_UNVERIFIED — live sandbox/production echo sample not yet captured in-repo.",
    ],
  },
  IMPACT: {
    supplier: "IMPACT",
    confirmation: TRACKING_PARAM_CONFIRMATION.CONFIRMED,
    // Blueprint §14: subId1=client_id, subId2=assignment_id, subId3=mbo_click_id
    clientIdParam: "subId1",
    assignmentIdParam: "subId2",
    mboClickIdParam: "subId3",
    trackingLinkSubIdParam: null,
    couponParam: null,
    verificationFlags: [TRACKING_VERIFICATION.IMPACT_PRODUCTION_ECHO_UNVERIFIED],
    notes: [
      "MBO Blueprint Impact tracking rule: subId1/subId2/subId3 — CONFIRMED for injection.",
      "IMPACT_PRODUCTION_ECHO_UNVERIFIED — live production Action echo not captured in-repo.",
    ],
  },
  AWIN: {
    supplier: "AWIN",
    confirmation: TRACKING_PARAM_CONFIRMATION.CONFIRMED,
    // Master spec: ClickRef1–6 — place assignment/click tokens in clickRef fields.
    clientIdParam: "clickRef",
    assignmentIdParam: "clickRef2",
    mboClickIdParam: "clickRef3",
    trackingLinkSubIdParam: null,
    couponParam: null,
    verificationFlags: [],
    notes: [
      "Awin ClickRef1–6 are strong attribution inputs (CONFIRMED_OFFICIAL_DOCS).",
      "clickRef=client, clickRef2=assignment, clickRef3=mbo_click — VERIFY LIVE echo before production.",
    ],
  },
  UNKNOWN: {
    supplier: "UNKNOWN",
    confirmation: TRACKING_PARAM_CONFIRMATION.DISABLED,
    clientIdParam: null,
    assignmentIdParam: null,
    mboClickIdParam: null,
    trackingLinkSubIdParam: null,
    couponParam: null,
    verificationFlags: [],
    notes: ["Unknown supplier — no parameter injection."],
  },
};

export function resolveSupplierKey(value) {
  if (!value) return "UNKNOWN";
  const normalized = String(value).trim().toUpperCase();
  if (normalized === "VCOMMISSION") return "TRACKIER";
  if (TRACKING_PARAM_RULES[normalized]) return normalized;
  return "UNKNOWN";
}

export function getTrackingParamRule(supplier) {
  const key = resolveSupplierKey(supplier);
  return TRACKING_PARAM_RULES[key] ?? TRACKING_PARAM_RULES.UNKNOWN;
}

/**
 * Build query param map for a redirect.
 * @returns {{ params: Record<string, string>, rule: TrackingParamRule, injected: boolean, skippedReason: string|null }}
 */
export function buildAttributionQueryParams({
  supplier,
  clientId,
  assignmentId,
  mboClickId,
  trackingLinkSubId,
  couponCode,
} = {}) {
  const rule = getTrackingParamRule(supplier);

  if (
    rule.confirmation === TRACKING_PARAM_CONFIRMATION.UNCONFIRMED ||
    rule.confirmation === TRACKING_PARAM_CONFIRMATION.DISABLED
  ) {
    return {
      params: {},
      rule,
      injected: false,
      skippedReason:
        rule.confirmation === TRACKING_PARAM_CONFIRMATION.UNCONFIRMED
          ? `Tracking params for ${rule.supplier} are UNCONFIRMED — skipping injection.`
          : `Tracking params for ${rule.supplier} are DISABLED — skipping injection.`,
    };
  }

  /** @type {Record<string, string>} */
  const params = {};
  const values = {
    clientId: clientId != null ? String(clientId) : null,
    assignmentId: assignmentId != null ? String(assignmentId) : null,
    mboClickId: mboClickId != null ? String(mboClickId) : null,
    trackingLinkSubId: trackingLinkSubId != null ? String(trackingLinkSubId) : null,
    couponCode: couponCode != null ? String(couponCode) : null,
  };

  if (rule.clientIdParam && values.clientId) params[rule.clientIdParam] = values.clientId;
  if (rule.assignmentIdParam && values.assignmentId) params[rule.assignmentIdParam] = values.assignmentId;
  if (rule.mboClickIdParam && values.mboClickId) params[rule.mboClickIdParam] = values.mboClickId;
  if (rule.trackingLinkSubIdParam && values.trackingLinkSubId) {
    params[rule.trackingLinkSubIdParam] = values.trackingLinkSubId;
  }
  if (rule.couponParam && values.couponCode) params[rule.couponParam] = values.couponCode;

  if (rule.extraParams && typeof rule.extraParams === "object") {
    for (const [paramName, valueKey] of Object.entries(rule.extraParams)) {
      const value = values[valueKey];
      if (value) params[paramName] = value;
    }
  }

  return {
    params,
    rule,
    injected: Object.keys(params).length > 0,
    skippedReason: Object.keys(params).length ? null : "No confirmed param values available to inject.",
  };
}
