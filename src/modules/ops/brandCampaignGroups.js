import { averageCommissionFacts } from "./campaignCommissions.js";

/**
 * All Network Data — one table row per brand/network, every campaign commission in that block.
 * Campaign grain is unchanged on Entity Explorer; this is a display grouping for Network Ops.
 */

function factIdentity(fact) {
  if (fact && typeof fact === "object") {
    return `${fact.kind || ""}|${fact.value ?? ""}|${fact.currency || ""}|${fact.display || ""}`;
  }
  return `display|${String(fact || "").trim()}`;
}

function factsFromRow(row) {
  if (Array.isArray(row?.commissions) && row.commissions.length) {
    return row.commissions.filter((item) => item && (item.display || typeof item === "string"));
  }
  const text = row?.commissionDisplay;
  if (text == null || text === "") return [];
  return String(text)
    .split(/\s*·\s*/)
    .map((display) => display.trim())
    .filter(Boolean)
    .map((display) => ({ kind: null, value: null, currency: null, display }));
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (value == null || value === "") continue;
    const text = String(value).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function brandGroupKey(row) {
  const network = String(row?.networkSource || "").toLowerCase();
  const advertiser = String(row?.sourceAdvertiserName || "").trim();
  const brand = String(row?.brand || "").trim();
  return `${network}\0${(advertiser || brand || "unknown").toLowerCase()}`;
}

function newerRow(a, b) {
  const ta = new Date(a?.lastUpdated || a?.lastSyncedAt || 0).getTime();
  const tb = new Date(b?.lastUpdated || b?.lastSyncedAt || 0).getTime();
  return tb > ta ? b : a;
}

function minDate(values) {
  const times = values.map((v) => new Date(v).getTime()).filter((n) => Number.isFinite(n));
  if (!times.length) return null;
  return values.find((v) => new Date(v).getTime() === Math.min(...times)) || null;
}

function maxDate(values) {
  const times = values.map((v) => new Date(v).getTime()).filter((n) => Number.isFinite(n));
  if (!times.length) return null;
  return values.find((v) => new Date(v).getTime() === Math.max(...times)) || null;
}

function uniqueFacts(facts) {
  const seen = new Set();
  const out = [];
  for (const fact of facts || []) {
    const display = fact && typeof fact === "object" ? fact.display : fact;
    const text = display == null ? "" : String(display).trim();
    if (!text || text === "[object Object]") continue;
    const key = factIdentity(typeof fact === "object" ? { ...fact, display: text } : text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(typeof fact === "object" ? { ...fact, display: text } : { display: text });
  }
  return out;
}

function operationFromMember(row) {
  return {
    id: row.id || null,
    campaign: row.campaign || null,
    commissions: uniqueFacts(factsFromRow(row)),
  };
}

function mergeBrandGroup(members) {
  const latest = members.reduce(newerRow);
  const operations = members.map(operationFromMember);
  const commissions = operations.flatMap((op) => op.commissions);
  const campaignNames = operations.map((op) => op.campaign).filter(Boolean);
  const trackingLinks = uniqueStrings(
    members.map((row) => row.supplierTrackingLink || row.networkTrackingLink),
  );
  const countries = uniqueStrings(members.map((row) => row.country));
  const statuses = uniqueStrings(members.map((row) => row.campaignStatus));

  return {
    ...latest,
    memberIds: members.map((row) => row.id).filter(Boolean),
    groupedCampaignCount: members.length,
    campaignNames: uniqueStrings(campaignNames),
    campaign: uniqueStrings(campaignNames).join(" · ") || latest.campaign || null,
    commissionOperations: operations,
    commissions,
    commissionDisplay: commissions.length ? commissions.map((f) => f.display).join(" · ") : null,
    commissionAverageDisplay: averageCommissionFacts(commissions),
    commissionRuleCount: commissions.length,
    supplierTrackingLink: trackingLinks.length === 1 ? trackingLinks[0] : null,
    supplierTrackingLinks: trackingLinks,
    supplierTrackingLinkCount: trackingLinks.length,
    networkTrackingLink: trackingLinks.length === 1 ? trackingLinks[0] : null,
    networkTrackingLinks: trackingLinks,
    country: countries.join(", ") || latest.country || null,
    startDate: minDate(members.map((row) => row.startDate).filter(Boolean)) || latest.startDate || null,
    endDate: maxDate(members.map((row) => row.endDate).filter(Boolean)) || latest.endDate || null,
    campaignStatus: statuses.length === 1 ? statuses[0] : latest.campaignStatus || null,
  };
}

/**
 * Collapse campaign list rows that share a network + brand into one row.
 * Each operation keeps its own commission line(s), even when the rate matches another campaign.
 */
export function groupCampaignRowsByBrand(rows = []) {
  const buckets = new Map();
  for (const row of rows) {
    const key = brandGroupKey(row);
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
  }
  const grouped = [...buckets.values()].map((members) => mergeBrandGroup(members));
  grouped.sort((a, b) => {
    const tb = new Date(b.lastUpdated || b.lastSyncedAt || 0).getTime();
    const ta = new Date(a.lastUpdated || a.lastSyncedAt || 0).getTime();
    if (tb !== ta) return tb - ta;
    return String(a.brand || "").localeCompare(String(b.brand || ""));
  });
  return grouped;
}
