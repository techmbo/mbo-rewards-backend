/**
 * Supplier tracking-link lifecycle (manual-first).
 *
 * Model separation that this module exists to defend:
 *   A. destinationUrl        — advertiser/merchant landing page. NOT attribution-safe.
 *   B. supplierTrackingUrl   — publisher-attributed supplier tracking URL. Lives in
 *                              SupplierCampaign.trackingUrl (the canonical column).
 *   C. MBO/client tracking   — TrackingLink.mboTrackingUrl, a separate downstream layer.
 *
 * A is never substituted for B.
 *
 * Partnerize specifics: a joined/approved campaign does NOT emit a publisher tracking link
 * in its campaign payload. The publisher generates one in the portal
 * (Tracking -> Create Tracking Link -> select campaign). There is currently
 * NO_EVIDENCE_IN_CURRENT_INTEGRATION of a Partnerize API endpoint that creates or reads
 * tracking links, so acquisition is manual and provenance is MANUAL_ADMIN.
 */

export const SUPPLIER_TRACKING_LINK_STATE = Object.freeze({
  NOT_GENERATED: "TRACKING_LINK_NOT_GENERATED",
  AVAILABLE: "TRACKING_LINK_AVAILABLE",
  NEEDS_REVIEW: "TRACKING_LINK_NEEDS_REVIEW",
  REVOKED: "TRACKING_LINK_REVOKED",
});

export const SUPPLIER_TRACKING_LINK_STATES = Object.freeze(
  Object.values(SUPPLIER_TRACKING_LINK_STATE),
);

export const SUPPLIER_TRACKING_LINK_PROVENANCE = Object.freeze({
  MANUAL_ADMIN: "MANUAL_ADMIN",
  SUPPLIER_API: "SUPPLIER_API",
});

/** Only MANUAL_ADMIN is actively written today. SUPPLIER_API is declared, never produced. */
export const ACTIVE_SUPPLIER_TRACKING_LINK_PROVENANCE = Object.freeze([
  SUPPLIER_TRACKING_LINK_PROVENANCE.MANUAL_ADMIN,
]);

/** Operational code returned when a downstream monetized action has no supplier tracking link. */
export const SUPPLIER_TRACKING_LINK_REQUIRED = "SUPPLIER_TRACKING_LINK_REQUIRED";

/** Reported when a host cannot be validated because the repo holds no allowlist evidence. */
export const NEEDS_TRACKING_HOST_EVIDENCE = "NEEDS_TRACKING_HOST_EVIDENCE";

/**
 * Confidence in a host allowlist entry. Mirrors the TRACKING_PARAM_CONFIRMATION convention in
 * trackingParamRules.js: state the evidence grade rather than implying supplier confirmation.
 */
export const TRACKING_HOST_EVIDENCE = Object.freeze({
  /** Host appears in committed in-repo fixtures/expectations for this supplier. */
  EVIDENCED_IN_REPO: "EVIDENCED_IN_REPO",
  /** No in-repo evidence. Nothing may be validated against an invented pattern. */
  NONE: "NONE",
});

/**
 * Supplier tracking-host allowlist.
 *
 * PARTNERIZE: `prf.hn` is the click host carried by every committed Partnerize tracking-URL
 * fixture in this repo (test/supplierCampaignTracking.test.js, test/commercialService.test.js,
 * test/epic3.tracking.test.js, test/epic4.productFeed.test.js), consistently in the shape
 * https://prf.hn/click/... with a `camref` campaign reference. That is in-repo evidence, not
 * supplier-confirmed documentation, so the grade is EVIDENCED_IN_REPO.
 *
 * api.partnerize.com is deliberately NOT listed: it is the REST API host, not a click host.
 * No other host is guessed here.
 */
export const SUPPLIER_TRACKING_HOST_ALLOWLIST = Object.freeze({
  PARTNERIZE: Object.freeze({
    evidence: TRACKING_HOST_EVIDENCE.EVIDENCED_IN_REPO,
    hosts: Object.freeze(["prf.hn"]),
    notes: Object.freeze([
      "prf.hn observed as the Partnerize click host across committed repo fixtures.",
      "Grade is EVIDENCED_IN_REPO, not supplier-confirmed: a genuine additional Partnerize click host would be rejected until evidence is added.",
    ]),
  }),
});

const DISALLOWED_SCHEMES = Object.freeze([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "blob:",
  "about:",
  "ftp:",
  "http:",
]);

export class SupplierTrackingLinkValidationError extends Error {
  constructor(message, { code, details = null } = {}) {
    super(message);
    this.name = "SupplierTrackingLinkValidationError";
    this.code = code;
    this.details = details;
  }
}

/** Allowlist lookup for a SupplierKey. Unknown suppliers get an explicit NONE entry. */
export function trackingHostPolicyFor(supplier) {
  const key = String(supplier ?? "").trim().toUpperCase();
  return (
    SUPPLIER_TRACKING_HOST_ALLOWLIST[key] ?? {
      evidence: TRACKING_HOST_EVIDENCE.NONE,
      hosts: [],
      notes: ["No in-repo tracking-host evidence for this supplier."],
    }
  );
}

/** Exact host match, or a dot-bounded subdomain of an allowlisted host. */
export function hostMatchesAllowlist(hostname, hosts = []) {
  const host = String(hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return hosts.some((allowed) => {
    const base = String(allowed).trim().toLowerCase();
    if (!base) return false;
    return host === base || host.endsWith(`.${base}`);
  });
}

/**
 * Validate an operator-pasted supplier tracking URL.
 *
 * Deliberately NOT implemented: "reject it because it equals destination_url". That is not a
 * validation rule — it passes any other wrong URL. Host allowlisting is the real check.
 *
 * Deliberately NOT implemented: campaign-reference verification. Partnerize `camref` is an
 * opaque encoded token in every in-repo sample; it does not carry the plain supplier campaign
 * id, so no parsing rule is evidenced. Provenance and audit metadata are retained instead.
 *
 * @returns {{ url: string, hostname: string, evidence: string }}
 */
export function validateSupplierTrackingUrl(rawValue, { supplier } = {}) {
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) {
    throw new SupplierTrackingLinkValidationError("Supplier tracking URL is required.", {
      code: "TRACKING_URL_REQUIRED",
    });
  }
  if (value.length > 2048) {
    throw new SupplierTrackingLinkValidationError("Supplier tracking URL is too long.", {
      code: "TRACKING_URL_TOO_LONG",
    });
  }
  if (/[\s<>"']/.test(value)) {
    throw new SupplierTrackingLinkValidationError(
      "Supplier tracking URL contains illegal characters.",
      { code: "TRACKING_URL_MALFORMED" },
    );
  }

  const lowered = value.toLowerCase();
  for (const scheme of DISALLOWED_SCHEMES) {
    if (lowered.startsWith(scheme)) {
      throw new SupplierTrackingLinkValidationError(
        "Supplier tracking URL must use https.",
        { code: "TRACKING_URL_SCHEME_REJECTED", details: { scheme } },
      );
    }
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new SupplierTrackingLinkValidationError(
      "Supplier tracking URL must be an absolute URL.",
      { code: "TRACKING_URL_NOT_ABSOLUTE" },
    );
  }

  if (parsed.protocol !== "https:") {
    throw new SupplierTrackingLinkValidationError("Supplier tracking URL must use https.", {
      code: "TRACKING_URL_SCHEME_REJECTED",
      details: { scheme: parsed.protocol },
    });
  }
  if (parsed.username || parsed.password) {
    throw new SupplierTrackingLinkValidationError(
      "Supplier tracking URL must not embed credentials.",
      { code: "TRACKING_URL_CREDENTIALS_REJECTED" },
    );
  }

  const policy = trackingHostPolicyFor(supplier);
  if (policy.evidence === TRACKING_HOST_EVIDENCE.NONE || !policy.hosts.length) {
    throw new SupplierTrackingLinkValidationError(
      "No tracking-host evidence exists for this supplier; refusing to validate against an invented allowlist.",
      { code: NEEDS_TRACKING_HOST_EVIDENCE, details: { supplier: String(supplier ?? "") } },
    );
  }
  if (!hostMatchesAllowlist(parsed.hostname, policy.hosts)) {
    throw new SupplierTrackingLinkValidationError(
      "Supplier tracking URL host is not an allowlisted tracking host for this supplier.",
      {
        code: "TRACKING_HOST_NOT_ALLOWLISTED",
        details: { allowedHosts: [...policy.hosts], evidence: policy.evidence },
      },
    );
  }

  return {
    url: value,
    hostname: parsed.hostname.toLowerCase(),
    evidence: policy.evidence,
  };
}

/**
 * Sync merge rule.
 *
 * A supplier payload with no evidenced tracking link must never clear, null out or downgrade a
 * manually stored link. Only a real incoming link may replace a stored value.
 *
 * Future SUPPLIER_API precedence is intentionally NOT solved here.
 *
 * @returns {{ trackingUrl: string|null, state: string, provenance: string|null, retained: boolean }}
 */
export function mergeSupplierTrackingLinkOnSync({ incomingTrackingUrl = null, existing = null } = {}) {
  const incoming = typeof incomingTrackingUrl === "string" ? incomingTrackingUrl.trim() : "";
  const storedUrl = typeof existing?.trackingUrl === "string" ? existing.trackingUrl.trim() : "";
  const storedProvenance = existing?.supplierTrackingLinkProvenance ?? null;
  const storedState = existing?.supplierTrackingLinkState ?? null;
  const manual = storedProvenance === SUPPLIER_TRACKING_LINK_PROVENANCE.MANUAL_ADMIN;

  if (!incoming && manual && storedUrl) {
    return {
      trackingUrl: storedUrl,
      state: storedState ?? SUPPLIER_TRACKING_LINK_STATE.AVAILABLE,
      provenance: storedProvenance,
      retained: true,
    };
  }

  if (!incoming) {
    return {
      trackingUrl: null,
      // A revoked link stays revoked; it is not silently reset to "never generated".
      state:
        storedState === SUPPLIER_TRACKING_LINK_STATE.REVOKED
          ? SUPPLIER_TRACKING_LINK_STATE.REVOKED
          : SUPPLIER_TRACKING_LINK_STATE.NOT_GENERATED,
      provenance: null,
      retained: false,
    };
  }

  return {
    trackingUrl: incoming,
    state: SUPPLIER_TRACKING_LINK_STATE.AVAILABLE,
    provenance: storedProvenance,
    retained: false,
  };
}

/**
 * Suppliers whose campaign payload does not mint a publisher tracking link. For these, a missing
 * supplier tracking link is a normal state and destinationUrl must NOT stand in for it: minting an
 * MBO link over an advertiser landing page produces unattributed, unpaid clicks.
 */
export const NO_DESTINATION_FALLBACK_SUPPLIERS = Object.freeze(["PARTNERIZE"]);

export function supplierAllowsDestinationTrackingFallback(supplier) {
  return !NO_DESTINATION_FALLBACK_SUPPLIERS.includes(String(supplier ?? "").trim().toUpperCase());
}

/** True when the stored link may carry attributable, monetized traffic. */
export function isSupplierTrackingLinkUsable(record = {}) {
  const url = typeof record?.trackingUrl === "string" ? record.trackingUrl.trim() : "";
  return Boolean(url) && record?.supplierTrackingLinkState === SUPPLIER_TRACKING_LINK_STATE.AVAILABLE;
}

/** Host-only classification for audit metadata — never the full attributed URL. */
export function classifyTrackingUrlForAudit(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return "unparseable";
  }
}
