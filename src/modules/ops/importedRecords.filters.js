/**
 * Network Ops imported-record filters.
 * Dropdown values are the same mapped field values the list API returns.
 * Never query Prisma enums with display-only tokens (INACTIVE, EXPIRED, APPROVED).
 */

import { mapCampaignStatus, mapCampaignType, mapRelationshipStatus } from "./v15FieldContract.js";
import { displayNetwork } from "./importedRecords.contract.js";
import { normalizeCampaignStatus } from "../supplier/mappers/status.js";

const DB_CAMPAIGN_STATUS = new Set(["ACTIVE", "PAUSED", "PENDING", "RETIRED", "UNKNOWN"]);
const DB_RELATIONSHIP = new Set(["JOINED", "NOT_JOINED", "PENDING", "UNKNOWN"]);
const PRICING_MODELS = new Set(["CPA", "CPC", "CPL", "CPS", "HYBRID"]);

const CAMPAIGN_STATUS_ORDER = ["ACTIVE", "PAUSED", "PENDING", "EXPIRED", "NOTAPPLIED", "INACTIVE"];
const RELATIONSHIP_ORDER = [
  "JOINED",
  "APPROVED",
  "PENDING",
  "NOT_JOINED",
  "REJECTED",
  "SUSPENDED",
  "UNKNOWN",
];

/** Prisma predicate that matches no rows (empty `in: []` is unsafe). */
export const NO_MATCH = Object.freeze({ id: { equals: "__no_match__" } });

export function facetLabel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw === "NOT_JOINED" || raw === "NOT_APPLIED") return "Not Joined";
  if (raw === "NOTAPPLIED") return "Not Applied";
  return raw
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function networkFilterValue(networkSource) {
  const key = String(networkSource || "").toLowerCase();
  if (!key) return "";
  if (key.startsWith("optimise")) return "optimise";
  if (key === "vcommission") return "trackier";
  return key;
}

export function networkFacetLabel(networkSource) {
  return displayNetwork(networkSource) || facetLabel(networkFilterValue(networkSource));
}

export function isNotAppliedCampaignStatus(raw) {
  const v = String(raw || "")
    .toUpperCase()
    .replace(/[_\-\s]/g, "");
  return v === "NOTAPPLIED";
}

export function notAppliedEntityWhere() {
  return {
    entityType: "campaign",
    OR: [
      { rawData: { path: ["status"], equals: "notapplied" } },
      { rawData: { path: ["status"], equals: "not_applied" } },
    ],
  };
}

/**
 * Campaign Status shown in Network Ops — the network's own status field
 * when we have one. UNKNOWN is never displayed (use null → em dash only when
 * the payload truly has no campaign lifecycle status).
 *
 * Optimise GET /campaigns `status`: live | paused | closed | waiting | notapplied
 */
export function resolveDisplayedCampaignStatus({ stored, raw = {}, networkSource = "" } = {}) {
  const mapped = stored ? mapCampaignStatus(stored) : null;
  if (mapped && mapped !== "UNKNOWN") return mapped;

  const network = String(networkSource || "").toLowerCase();
  const status = String(raw.status ?? raw.campaign_status ?? raw.campaignStatus ?? "")
    .trim()
    .toLowerCase();

  if (network.startsWith("optimise")) {
    if (status === "live") return "ACTIVE";
    if (status === "paused") return "PAUSED";
    if (status === "closed" || status === "retired" || status === "ended") return "EXPIRED";
    if (status === "waiting" || status === "pending") return "PENDING";
    if (status === "notapplied" || status === "not_applied") return "NOTAPPLIED";
  }

  if (network === "partnerize") {
    if (status === "a") return "ACTIVE";
    if (status === "p" || status === "r") return null;
  }

  const skipJoinCodes = new Set(["a", "p", "r", "notapplied", "not_applied"]);
  const fromRaw = normalizeCampaignStatus(
    raw.advertiserCampaignStatus,
    raw.advertiser_campaign_status,
    raw.CampaignStatus,
    raw.campaignStatus,
    raw.campaign_status,
    raw.lifecycle_status,
    raw.campaign_lifecycle_status,
    skipJoinCodes.has(status) ? null : raw.status,
  );
  if (fromRaw && fromRaw !== "UNKNOWN") return mapCampaignStatus(fromRaw);
  return null;
}

/**
 * List/API campaignStatus → Prisma CampaignStatus values.
 * EXPIRED is stored as RETIRED. INACTIVE is display-only and has no DB enum.
 */
export function campaignStatusToDb(raw) {
  if (raw == null || raw === "") return [];
  const v = String(raw).toUpperCase().trim();
  if (v === "EXPIRED") return ["RETIRED"];
  if (v === "INACTIVE" || v === "DISABLED") return [];
  if (isNotAppliedCampaignStatus(v)) return [];
  if (DB_CAMPAIGN_STATUS.has(v)) return [v];
  return [];
}

/**
 * List/API relationshipStatus → Prisma CampaignSourceRelationshipStatus values.
 */
export function relationshipStatusToDb(raw) {
  if (raw == null || raw === "") return [];
  const v = String(raw).toUpperCase().trim();
  if (v === "APPROVED") return ["JOINED"];
  if (v === "NOT_APPLIED" || v === "REJECTED" || v === "SUSPENDED") return ["NOT_JOINED"];
  if (v === "REQUIRES_APPROVAL") return ["PENDING"];
  if (DB_RELATIONSHIP.has(v)) return [v];
  return [];
}

export function countryFilterValue(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (value.length === 2) return value.toUpperCase();
  return value;
}

export function currencyFilterValue(raw) {
  const value = String(raw || "").trim().toUpperCase();
  if (!value) return "";
  return value.length === 3 ? value : value.slice(0, 3);
}

export function campaignTypeWhere(raw) {
  const ct = String(raw || "").trim();
  if (!ct) return null;
  const mapped = mapCampaignType(ct, ct);
  const or = [
    { campaignType: { equals: ct, mode: "insensitive" } },
    { campaignType: { contains: ct, mode: "insensitive" } },
  ];
  const pricing = PRICING_MODELS.has(String(mapped || "").toUpperCase())
    ? String(mapped).toUpperCase()
    : PRICING_MODELS.has(ct.toUpperCase())
      ? ct.toUpperCase()
      : null;
  if (pricing) or.push({ pricingModel: pricing });
  return {
    entityType: "campaign",
    supplierCampaigns: { some: { OR: or } },
  };
}

function sortByOrder(values, order) {
  return [...values].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return String(a).localeCompare(String(b));
  });
}

export function toFacetOptions(values, { mapValue = (v) => v, order = [], labelFn = facetLabel, omit = [] } = {}) {
  const skip = new Set((omit || []).map((v) => String(v).toUpperCase()));
  const seen = new Set();
  const mapped = [];
  for (const raw of values || []) {
    const value = mapValue(raw);
    if (value == null || value === "") continue;
    const key = String(value);
    if (skip.has(key.toUpperCase()) || seen.has(key)) continue;
    seen.add(key);
    mapped.push(key);
  }
  return sortByOrder(mapped, order).map((value) => ({
    value,
    label: labelFn(value),
  }));
}

export function campaignStatusFacetOptions(dbStatuses) {
  return toFacetOptions(dbStatuses, {
    mapValue: (v) => mapCampaignStatus(v),
    order: CAMPAIGN_STATUS_ORDER,
    omit: ["UNKNOWN"],
  });
}

export function relationshipFacetOptions(dbStatuses) {
  return toFacetOptions(dbStatuses, {
    mapValue: (v) => mapRelationshipStatus(v),
    order: RELATIONSHIP_ORDER,
    omit: ["UNKNOWN"],
  });
}

export function campaignTypeFacetOptions(types, pricingModels = []) {
  const mapped = [];
  for (const type of types || []) mapped.push(mapCampaignType(type, null));
  for (const model of pricingModels || []) mapped.push(mapCampaignType(null, model));
  return toFacetOptions(mapped.filter(Boolean), {
    order: ["CPS", "CPA", "CPL", "CPI", "CPC", "HYBRID", "TIERED"],
    labelFn: (v) => String(v),
    omit: ["UNKNOWN"],
  });
}

export function networkFacetOptions(networkSources) {
  return toFacetOptions(networkSources, {
    mapValue: networkFilterValue,
    labelFn: (value) => networkFacetLabel(value),
  });
}
