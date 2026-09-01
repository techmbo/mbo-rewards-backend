/**
 * Pointer 11 — Tracking Link logic.
 * Supplier and MBO tracking links are independent; never substitute one for the other.
 *
 * Runtime chain:
 * Client → MBO Tracking Link → MBO Click ID → attribution token on network param → Supplier Tracking Link → Brand
 */

import {
  getTrackingParamRule,
  resolveSupplierKey,
  TRACKING_PARAM_CONFIRMATION,
} from "./trackingParamRules.js";

export const TRACKING_LINK_KIND = Object.freeze({
  SUPPLIER: "SUPPLIER",
  MBO: "MBO",
});

export const REDIRECT_CHAIN_STEP = Object.freeze({
  CLIENT: "CLIENT",
  MBO_TRACKING_LINK: "MBO_TRACKING_LINK",
  MBO_CLICK_ID: "MBO_CLICK_ID",
  ATTRIBUTION_INJECTION: "ATTRIBUTION_INJECTION",
  SUPPLIER_TRACKING_LINK: "SUPPLIER_TRACKING_LINK",
  BRAND_DESTINATION: "BRAND_DESTINATION",
});

const REDIRECT_CHAIN_LABELS = Object.freeze({
  [REDIRECT_CHAIN_STEP.CLIENT]: "Client",
  [REDIRECT_CHAIN_STEP.MBO_TRACKING_LINK]: "MBO Tracking Link",
  [REDIRECT_CHAIN_STEP.MBO_CLICK_ID]: "Create / resolve MBO Click ID",
  [REDIRECT_CHAIN_STEP.ATTRIBUTION_INJECTION]: "Inject MBO attribution token",
  [REDIRECT_CHAIN_STEP.SUPPLIER_TRACKING_LINK]: "Supplier Tracking Link",
  [REDIRECT_CHAIN_STEP.BRAND_DESTINATION]: "Brand destination",
});

function first(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function asTrimmedString(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  return s || null;
}

function isHttpUrl(value) {
  const s = asTrimmedString(value);
  return Boolean(s && /^https?:\/\//i.test(s));
}

/**
 * Resolve the network-provided affiliate URL. Never falls back to MBO link.
 */
export function resolveSupplierTrackingLink(candidates = {}) {
  const url = first(
    candidates.supplierTrackingLink,
    candidates.networkTrackingLink,
    candidates.trackingUrl,
    candidates.supplierTrackingUrl,
    candidates.destinationUrl,
  );
  const trimmed = asTrimmedString(url);
  return isHttpUrl(trimmed) ? trimmed : trimmed;
}

/**
 * Resolve the MBO client-facing redirect URL. Never falls back to supplier link.
 */
export function resolveMboTrackingLink(candidates = {}) {
  const url = first(candidates.mboTrackingLink, candidates.mboTrackingUrl);
  const trimmed = asTrimmedString(url);
  return isHttpUrl(trimmed) ? trimmed : trimmed;
}

/**
 * Guard against accidental substitution (supplier URL copied into MBO field).
 */
export function assertTrackingLinksIndependent(supplierLink, mboLink) {
  const supplier = asTrimmedString(supplierLink);
  const mbo = asTrimmedString(mboLink);
  if (!supplier || !mbo) return true;
  return supplier !== mbo;
}

export function attributionParameterLabel(supplier) {
  const rule = getTrackingParamRule(supplier);
  if (
    rule.confirmation === TRACKING_PARAM_CONFIRMATION.UNCONFIRMED ||
    rule.confirmation === TRACKING_PARAM_CONFIRMATION.DISABLED
  ) {
    return "VERIFY_LIVE";
  }
  const key = resolveSupplierKey(supplier);
  if (key === "IMPACT") return "SubId1";
  if (key === "OPTIMISE") return "UID";
  if (key === "AWIN") return "clickRef";
  if (key === "PARTNERIZE") return "adref";
  if (key === "TRACKIER") return "p1";
  if (rule.clientIdParam) return rule.clientIdParam;
  return "VERIFY_LIVE";
}

export function buildAttributionParamSummary(supplier) {
  const rule = getTrackingParamRule(supplier);
  const parts = [];
  if (rule.clientIdParam) parts.push(`${rule.clientIdParam}=client`);
  if (rule.assignmentIdParam) parts.push(`${rule.assignmentIdParam}=assignment`);
  if (rule.mboClickIdParam) parts.push(`${rule.mboClickIdParam}=mbo_click_id`);
  return parts.length ? parts.join(", ") : "VERIFY_LIVE";
}

/**
 * Document the runtime redirect chain for internal ops surfaces.
 */
export function buildRedirectChain({ supplier = null, attributionParameter = null } = {}) {
  const param = attributionParameter || attributionParameterLabel(supplier);
  return [
    { step: REDIRECT_CHAIN_STEP.CLIENT, label: REDIRECT_CHAIN_LABELS[REDIRECT_CHAIN_STEP.CLIENT], order: 1 },
    {
      step: REDIRECT_CHAIN_STEP.MBO_TRACKING_LINK,
      label: REDIRECT_CHAIN_LABELS[REDIRECT_CHAIN_STEP.MBO_TRACKING_LINK],
      order: 2,
    },
    {
      step: REDIRECT_CHAIN_STEP.MBO_CLICK_ID,
      label: REDIRECT_CHAIN_LABELS[REDIRECT_CHAIN_STEP.MBO_CLICK_ID],
      order: 3,
    },
    {
      step: REDIRECT_CHAIN_STEP.ATTRIBUTION_INJECTION,
      label: REDIRECT_CHAIN_LABELS[REDIRECT_CHAIN_STEP.ATTRIBUTION_INJECTION],
      detail: param,
      order: 4,
    },
    {
      step: REDIRECT_CHAIN_STEP.SUPPLIER_TRACKING_LINK,
      label: REDIRECT_CHAIN_LABELS[REDIRECT_CHAIN_STEP.SUPPLIER_TRACKING_LINK],
      order: 5,
    },
    {
      step: REDIRECT_CHAIN_STEP.BRAND_DESTINATION,
      label: REDIRECT_CHAIN_LABELS[REDIRECT_CHAIN_STEP.BRAND_DESTINATION],
      order: 6,
    },
  ];
}

export function formatRedirectChainSummary(chain = buildRedirectChain()) {
  return chain.map((item) => item.label).join(" → ");
}

export function toInternalTrackingLinkDto(input = {}) {
  const supplier = input.supplier ?? input.networkSource ?? null;
  const supplierTrackingLink = resolveSupplierTrackingLink(input);
  const mboTrackingLink = resolveMboTrackingLink(input);
  const attributionParameter =
    input.attributionParameter ?? attributionParameterLabel(supplier);

  return {
    id: input.id ?? null,
    networkSource: supplier,
    supplierTrackingLink,
    /** @deprecated use supplierTrackingLink */
    networkTrackingLink: supplierTrackingLink,
    mboTrackingLink,
    trackingLinkId: input.trackingLinkId ?? input.id ?? null,
    attributionParameter,
    attributionParamSummary: buildAttributionParamSummary(supplier),
    linkKind:
      supplierTrackingLink && mboTrackingLink
        ? "BOTH"
        : supplierTrackingLink
          ? TRACKING_LINK_KIND.SUPPLIER
          : mboTrackingLink
            ? TRACKING_LINK_KIND.MBO
            : null,
    redirectChain: buildRedirectChain({ supplier, attributionParameter }),
    redirectChainSummary: formatRedirectChainSummary(
      buildRedirectChain({ supplier, attributionParameter }),
    ),
    linksIndependent: assertTrackingLinksIndependent(supplierTrackingLink, mboTrackingLink),
    note: "Supplier and MBO tracking links are independent — never substituted.",
  };
}

/** Strip internal-only supplier URLs from client-safe payloads. */
export function toClientSafeTrackingDto(input = {}) {
  return {
    mboTrackingLink: resolveMboTrackingLink(input),
    trackingLinkId: input.trackingLinkId ?? null,
  };
}

export function stripSupplierTrackingFields(dto) {
  if (!dto || typeof dto !== "object") return dto;
  const next = { ...dto };
  delete next.supplierTrackingLink;
  delete next.networkTrackingLink;
  delete next.trackingUrl;
  delete next.supplierTrackingUrl;
  delete next.redirectChain;
  delete next.redirectChainSummary;
  delete next.attributionParamSummary;
  if (next.tracking && typeof next.tracking === "object") {
    next.tracking = toClientSafeTrackingDto(next.tracking);
  }
  return next;
}
