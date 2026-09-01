/**
 * Pointer 12 — explode embedded commission payloads into individual rule records.
 */

import {
  collectSourceEntries,
  listCampaignCommissionFacts,
} from "../ops/campaignCommissions.js";

function campaignIdFromRaw(raw = {}) {
  return raw.id ?? raw.campaignId ?? raw.campaign_id ?? raw.productId ?? null;
}

function asString(value) {
  if (value == null || value === "") return null;
  return String(value).trim() || null;
}

function normalizeRuleEntry(entry, { sourcePath, sourceObject, campaignId, entryIndex, factIndex, fact }) {
  if (!fact?.display) return null;
  const sourceRuleId = asString(
    entry?.id ??
      entry?.rule_id ??
      entry?.ruleId ??
      entry?.commission_id ??
      entry?.commissionId ??
      `${campaignId ?? "camp"}:${sourcePath}:${entryIndex}:${factIndex}`,
  );

  return {
    sourceRuleId,
    supplierRuleType: fact.kind === "PERCENT" ? "PERCENT" : fact.kind === "FIXED" ? "FIXED" : "OTHER",
    basis: fact.kind === "PERCENT" ? "PERCENT_OF_SALE" : fact.kind === "FIXED" ? "FIXED_AMOUNT" : "UNKNOWN",
    ratePercent: fact.kind === "PERCENT" ? fact.value : null,
    fixedAmount: fact.kind === "FIXED" ? fact.value : null,
    currency: fact.currency ?? null,
    customerType: asString(entry?.customer_type ?? entry?.customerType ?? entry?.audience),
    country: asString(
      entry?.country ??
        entry?.country_code ??
        (Array.isArray(entry?.countries) ? entry.countries[0] : null),
    ),
    categoryProductGoal: asString(
      entry?.category ??
        entry?.product ??
        entry?.goal ??
        entry?.scope ??
        entry?.vertical ??
        entry?.product_category,
    ),
    couponOrTier: asString(
      entry?.tier ?? entry?.coupon ?? entry?.coupon_code ?? entry?.couponCode ?? entry?.couponOrTier,
    ),
    effectiveFrom: entry?.effective_from ?? entry?.effectiveFrom ?? entry?.start_date ?? null,
    effectiveUntil: entry?.effective_until ?? entry?.effectiveUntil ?? entry?.end_date ?? null,
    sourceObject,
    sourcePath,
    _mboSourcePath: sourcePath,
    _mboSourceObject: sourceObject,
    record_source: "commission_rule",
  };
}

export function extractCommissionRulesFromCampaignRaw(
  raw,
  { sourceObject = "campaigns", commissionGroups = null, commissionUnit = null, currency = null } = {},
) {
  if (!raw || typeof raw !== "object") return [];
  const campaignId = campaignIdFromRaw(raw);
  const dedupe = new Map();
  let entryIndex = 0;

  for (const entry of collectSourceEntries({ groups: commissionGroups, raw })) {
    const { facts } = listCampaignCommissionFacts({
      groups: [entry],
      commissionUnit,
      currency,
      raw: {},
    });
    facts.forEach((fact, factIndex) => {
      const normalized = normalizeRuleEntry(entry, {
        sourcePath: "commission",
        sourceObject,
        campaignId,
        entryIndex,
        factIndex,
        fact,
      });
      if (!normalized) return;
      dedupe.set(String(normalized.sourceRuleId), normalized);
    });
    entryIndex += 1;
  }

  return [...dedupe.values()];
}

export function collectEmbeddedCommissionRulesFromCampaigns(
  campaigns = [],
  { sourceObject = "campaigns" } = {},
) {
  const all = [];
  for (const campaign of campaigns) {
    const raw = campaign?.rawData ?? campaign?.originalPayload ?? campaign;
    const extracted = extractCommissionRulesFromCampaignRaw(raw, {
      sourceObject,
      commissionGroups: campaign?.commissionGroups ?? raw?.commissionGroups,
    });
    for (const row of extracted) all.push(row);
  }
  return all;
}
