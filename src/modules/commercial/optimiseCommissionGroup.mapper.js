/**
 * Optimise detailed commission groups → SupplierCommissionRule candidates.
 *
 * Source: GET /campaigns/{campaignId}/commission-groups
 *   commissionGroup[].id / name / bandType / bands[] / commission / currency / conditions
 *
 * Locked MBO architecture (Pointer 12 / PR1-PR3):
 * - every distinct supplier payout outcome is its own SupplierCommissionRule;
 * - the Optimise commission-group id is the supplier group AND rule lineage
 *   (sourceGroupId / sourceRuleId) — never manufactured when supplied;
 * - `outcomeKey` is a stable logical identity that excludes the payout value, so a
 *   rate change (10% → 12%) versions the same outcome instead of creating a new one;
 * - bands are distinct outcomes: each band is one rule with the band boundaries kept
 *   as a COMMISSION_TIER child condition. Band/tier selection is NOT executable by the
 *   matcher until Optimise band semantics are verified live, so banded and
 *   condition-bearing rules are persisted as REVIEW_REQUIRED / VERIFY_LIVE and carry an
 *   MBO gate condition that makes the matcher fail closed (REVIEW_REQUIRED) instead of
 *   silently matching or falling back to a broader rule;
 * - a group without a supplier id never uses array position as identity: it is keyed by a
 *   fingerprint of stable non-economic semantics (name, band type, conditions) and is
 *   always REVIEW_REQUIRED (supplier_group_id_missing);
 * - explicit zero (0%, USD 0) is a real supplier outcome and survives normalization;
 * - campaign-level commissionCost / commissionGroupName stay display/fallback evidence.
 */

import { createHash } from "node:crypto";
import { listCampaignCommissionFacts } from "../ops/campaignCommissions.js";
import { conditionsFromSourceEntry } from "./supplierCommissionRuleFanOut.js";

export const OPTIMISE_COMMISSION_GROUP_SOURCE_OBJECT = "commission_groups";
export const OPTIMISE_COMMISSION_GROUP_RULE_VERSION = "OPT-CG-1";
export const OPTIMISE_VERIFY_LIVE_GATE = Object.freeze({
  conditionType: "OTHER_SOURCE_CONDITION",
  operator: "EQ",
  value: "VERIFY_LIVE",
  sourceConditionType: "MBO_VERIFY_LIVE_GATE",
});

const MATCHER_EXECUTABLE_CONDITION_TYPES = new Set([
  "COUNTRY",
  "REGION",
  "CATEGORY",
  "PRODUCT",
  "PRODUCT_ID",
  "SKU",
  "SKU_LIST",
  "CUSTOMER_TYPE",
  "COUPON",
  "VOUCHER",
  "ORDER_VALUE",
  "QUANTITY",
  "ACTION_TYPE",
  "DEVICE",
  "DATE",
  "PUBLISHER",
  "PUBLISHER_GROUP",
  "TRAFFIC_TYPE",
]);

function present(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

function text(value) {
  return present(value) ? String(value).trim() : null;
}

function firstPresent(...values) {
  return values.find(present) ?? null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function currencyCode(value) {
  if (!present(value)) return null;
  if (typeof value === "object") {
    return currencyCode(value.code ?? value.currencyCode ?? value.currency_code ?? value.iso ?? value.currency);
  }
  const code = String(value).trim().toUpperCase().slice(0, 3);
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export function optimiseGroupId(group = {}) {
  return text(
    firstPresent(
      group.id,
      group.commissionGroupId,
      group.commission_group_id,
      group.groupId,
      group.group_id,
    ),
  );
}

export function optimiseGroupName(group = {}) {
  return text(
    firstPresent(
      group.name,
      group.commissionGroupName,
      group.commission_group_name,
      group.groupName,
      group.group_name,
      group.title,
    ),
  );
}

function optimiseBandType(group = {}) {
  return text(firstPresent(group.bandType, group.band_type, group.commissionGroupBandType));
}

function optimiseBands(group = {}) {
  return asArray(firstPresent(group.bands, group.commissionBands, group.commission_bands, group.band));
}

function optimiseGroupCommission(group = {}) {
  return firstPresent(
    group.commission,
    group.commissionValue,
    group.commission_value,
    group.value,
    group.rate,
    group.payout,
  );
}

function optimiseBandCommission(band = {}) {
  if (band == null || typeof band !== "object") return band;
  return firstPresent(
    band.commission,
    band.commissionValue,
    band.commission_value,
    band.value,
    band.rate,
    band.amount,
    band.payout,
  );
}

function bandLower(band = {}) {
  return firstPresent(
    band.from,
    band.lower,
    band.lowerBound,
    band.lower_bound,
    band.min,
    band.minimum,
    band.start,
    band.threshold,
    band.bandFrom,
    band.band_from,
  );
}

function bandUpper(band = {}) {
  return firstPresent(
    band.to,
    band.upper,
    band.upperBound,
    band.upper_bound,
    band.max,
    band.maximum,
    band.end,
    band.upperThreshold,
    band.upper_threshold,
    band.bandTo,
    band.band_to,
  );
}

function boundNumber(value) {
  if (!present(value)) return null;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function effectiveWindow(group = {}) {
  return {
    effectiveFrom:
      firstPresent(group.effectiveFrom, group.effective_from, group.startDate, group.start_date, group.validFrom) ?? null,
    effectiveUntil:
      firstPresent(group.effectiveUntil, group.effective_until, group.endDate, group.end_date, group.validUntil) ?? null,
  };
}

/**
 * Whether the supplier stated the payout unit explicitly ("10%", "USD 20", "$5",
 * { type: "Percentage", value }). A bare number ("8.5") is interpreted the way the
 * campaign mapping already does (percent), but it is flagged for review rather than
 * treated as verified financial truth.
 */
function unitIsExplicit(commissionValue) {
  if (commissionValue == null) return false;
  if (typeof commissionValue === "object") {
    return present(commissionValue.type) || present(commissionValue.model) || unitIsExplicit(commissionValue.value);
  }
  const s = String(commissionValue);
  return /%/.test(s) || /(S\$|HK\$|AU\$|NZ\$|CA\$|US\$|A\$|C\$|Rp|RM|Rs\.?|USD|AED|SAR|GBP|EUR|IDR|MYR|SGD|HKD|THB|INR|£|€|\$|₹)/i.test(s);
}

function factsFor(commissionValue, currency) {
  if (!present(commissionValue)) return [];
  const entry =
    typeof commissionValue === "object" && !Array.isArray(commissionValue)
      ? { ...commissionValue, currency: currency ?? commissionValue.currency ?? null }
      : { value: commissionValue, currency };
  return listCampaignCommissionFacts({ groups: [entry], currency, raw: {} }).facts;
}

function bandSupplierId(band = {}) {
  return text(firstPresent(band?.id, band?.bandId, band?.band_id, band?.commissionBandId));
}

function bandName(band = {}) {
  return text(firstPresent(band?.name, band?.bandName, band?.band_name, band?.label, band?.title));
}

/**
 * Band condition kept as evidence for the matcher. The identity-bearing `value` holds
 * only stable semantics (band type + bounds); the array position lives in metadata as
 * evidence/debug data and never reaches conditionSignature() / outcomeKey.
 */
function bandCondition(band, bandIndex, bandType) {
  const lower = bandLower(band);
  const upper = bandUpper(band);
  return {
    conditionType: "COMMISSION_TIER",
    operator: "SOURCE_RANGE",
    value: canonicalJson({
      bandType: bandType ?? null,
      lower: lower ?? null,
      upper: upper ?? null,
      bandId: bandSupplierId(band),
      bandName: bandName(band),
    }),
    sourceConditionType: bandType ? `OPTIMISE_BAND:${bandType}` : "OPTIMISE_BAND",
    sourceConditionValue: band,
    metadata: {
      dimension: bandType ?? null,
      lowerBound: boundNumber(lower),
      upperBound: boundNumber(upper),
      lowerBoundRaw: lower ?? null,
      upperBoundRaw: upper ?? null,
      bandIndex,
      matcherReady: false,
      semanticStatus: "VERIFY_LIVE",
      reason: "optimise_band_boundary_semantics_not_verified_live",
    },
  };
}

/**
 * Durable band identity. Never the array position: a band is identified by a canonical
 * fingerprint of its stable non-economic semantics — supplier band id, band name, band
 * type, lower/upper boundary. Rates, amounts, index and timestamps are excluded so a
 * payout change versions the same logical band. A band with none of those is
 * INSUFFICIENT: it is kept with its raw evidence (fingerprint of the whole canonical
 * band, so two indistinguishable bands collapse instead of fabricating lineage) and is
 * flagged `band_identity_insufficient`.
 *
 * @returns {{ key: string, label: string, sufficient: boolean, inputs: object }}
 */
export function bandIdentity(band = {}, bandType = null) {
  const lower = bandLower(band);
  const upper = bandUpper(band);
  const id = bandSupplierId(band);
  const name = bandName(band);
  const inputs = {
    bandId: id,
    bandName: name ? name.toLowerCase().replace(/\s+/g, " ") : null,
    bandType: bandType ? String(bandType).toLowerCase() : null,
    lower: present(lower) ? String(lower).trim() : null,
    upper: present(upper) ? String(upper).trim() : null,
  };
  const label = id
    ? `band:id:${id}`
    : present(lower) || present(upper)
      ? `band:${inputs.lower ?? ""}-${inputs.upper ?? ""}`
      : name
        ? `band:name:${name}`
        : "band:unidentified";
  if (id || name || present(lower) || present(upper)) {
    return { key: `band:${fingerprint(inputs)}`, label, sufficient: true, inputs };
  }
  return {
    key: `band:unidentified:${fingerprint({ ...inputs, band })}`,
    label,
    sufficient: false,
    inputs,
  };
}

function isUnboundedSingleBand(bands) {
  if (bands.length !== 1) return false;
  const lower = boundNumber(bandLower(bands[0]));
  const upper = bandUpper(bands[0]);
  return (lower == null || lower === 0) && !present(upper);
}

/**
 * Order-independent condition identity. Mirrors the matcher's grouping: conditions are a
 * multiset grouped by dimension (conditionType, plus sourceConditionType only for
 * OTHER_SOURCE_CONDITION / CUSTOM_FIELD), so sorting atomic conditions loses no AND/OR
 * semantics — same-dimension values remain alternatives, different dimensions remain
 * conjunctive, exactly as evaluated. Used for identity only; persisted condition arrays
 * keep their source order.
 */
export function conditionSignature(conditions = []) {
  return (conditions || [])
    .map((condition) => {
      const type = String(condition.conditionType ?? "OTHER_SOURCE_CONDITION");
      const dimension =
        type === "OTHER_SOURCE_CONDITION" || type === "CUSTOM_FIELD"
          ? `${type}:${condition.sourceConditionType ?? "UNKNOWN"}`
          : type;
      return `${dimension}:${condition.operator ?? ""}:${condition.value}`;
    })
    .sort()
    .join("|");
}

/** Canonical JSON: object keys sorted recursively, arrays sorted by canonical form. */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).sort().join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(typeof value === "string" ? value.trim() : value);
}

function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}

const ECONOMIC_GROUP_FIELDS = new Set([
  "commission",
  "commissionvalue",
  "commission_value",
  "value",
  "rate",
  "amount",
  "payout",
  "fixed",
  "fixedamount",
  "fixed_amount",
  "bands",
  "commissionbands",
  "commission_bands",
  "band",
]);

function nonEconomicGroupFields(group = {}) {
  const out = {};
  for (const [key, value] of Object.entries(group)) {
    if (ECONOMIC_GROUP_FIELDS.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Durable identity for a group the supplier returned WITHOUT an id.
 *
 * Array position is never identity (a reordered response must not create new
 * lineage). The identity is a fingerprint of stable, non-economic supplier semantics:
 * normalized name, band type, canonicalised source conditions, plus payout kind /
 * basis / currency (the same non-value dimensions the campaign fan-out keys on).
 * Rates and amounts are excluded so a payout change versions the same logical rule.
 * When none of name / band type / conditions exist the identity is INSUFFICIENT: the
 * rule is still preserved with its raw evidence, keyed by a fingerprint of the whole
 * canonical group, and can never be finance-ready.
 */
export function anonymousGroupIdentity(group = {}, { kind = null, basis = null, currency = null } = {}) {
  const name = optimiseGroupName(group);
  const bandType = optimiseBandType(group);
  const conditions = group.conditions ?? group.condition ?? group.rules ?? null;
  const hasConditions = Array.isArray(conditions) ? conditions.length > 0 : Boolean(conditions && typeof conditions === "object" && Object.keys(conditions).length);
  const inputs = {
    supplier: "OPTIMISE",
    sourceObject: OPTIMISE_COMMISSION_GROUP_SOURCE_OBJECT,
    name: name ? name.toLowerCase().replace(/\s+/g, " ") : null,
    bandType: bandType ? bandType.toLowerCase() : null,
    conditions: hasConditions ? conditions : null,
    kind: kind ?? null,
    basis: basis ?? null,
    currency: currency ?? null,
  };
  if (name || bandType || hasConditions) {
    return {
      strategy: "ANONYMOUS_SEMANTIC_FINGERPRINT",
      sufficient: true,
      key: `ANON:${fingerprint(inputs)}`,
      inputs,
    };
  }
  return {
    strategy: "ANONYMOUS_INSUFFICIENT",
    sufficient: false,
    key: `ANON_UNIDENTIFIED:${fingerprint({ ...inputs, group: nonEconomicGroupFields(group), whole: group })}`,
    inputs,
  };
}

export function optimiseCommissionGroupOutcomeKey({
  campaignId,
  groupKey,
  bandKey,
  outcomeSlot,
  conditions,
}) {
  return [
    "optimise",
    OPTIMISE_COMMISSION_GROUP_SOURCE_OBJECT,
    campaignId ?? "NO_CAMPAIGN_ID",
    groupKey ?? "NO_GROUP_KEY",
    bandKey ?? "base",
    `slot:${outcomeSlot}`,
    conditionSignature(conditions),
  ].join("::");
}

/** Source campaign id encoded in a detailed-rule outcomeKey (null for other keys). */
export function sourceCampaignIdFromOutcomeKey(outcomeKey) {
  if (typeof outcomeKey !== "string") return null;
  const parts = outcomeKey.split("::");
  if (parts[0] !== "optimise" || parts[1] !== OPTIMISE_COMMISSION_GROUP_SOURCE_OBJECT) return null;
  const campaignId = parts[2];
  return campaignId && campaignId !== "NO_CAMPAIGN_ID" ? campaignId : null;
}

/**
 * Map every commission group of one campaign into SupplierCommissionRule candidates.
 *
 * @param {object[]} groups  raw groups returned for the campaign
 * @param {object} context   { sourceCampaignId, networkSource, sourceAccountLabel, currency,
 *                             supplierCampaignId, campaignSourceId, fetchedAt }
 */
export function mapOptimiseCommissionGroupCandidates(groups = [], context = {}) {
  const campaignId = text(context.sourceCampaignId);
  const results = [];
  const seen = new Set();
  let commissionSequence = 0;

  asArray(groups).forEach((group, groupIndex) => {
    if (!group || typeof group !== "object") return;

    const groupId = optimiseGroupId(group);
    const groupName = optimiseGroupName(group);
    const bandType = optimiseBandType(group);
    const bands = optimiseBands(group);
    const groupCurrency = currencyCode(group.currency ?? group.currencyCode ?? group.currency_code) ?? currencyCode(context.currency);
    const groupCommission = optimiseGroupCommission(group);
    const window = effectiveWindow(group);
    const sourceConditions = conditionsFromSourceEntry({
      conditions: group.conditions ?? group.condition ?? group.rules ?? null,
    });
    const unverifiedConditions = sourceConditions.filter(
      (condition) => !MATCHER_EXECUTABLE_CONDITION_TYPES.has(condition.conditionType),
    );

    // Bands are the authoritative distinct outcomes when present; the group-level
    // commission is then summary evidence only (never a second rule).
    const outcomes = bands.length
      ? bands.map((band, bandIndex) => {
          const identity = bandIdentity(band, bandType);
          return {
            band,
            bandIndex,
            commissionValue: optimiseBandCommission(band),
            currency: currencyCode(band?.currency ?? band?.currencyCode) ?? groupCurrency,
            bandKey: identity.key,
            bandLabel: identity.label,
            bandIdentity: identity,
            sourcePath: `commission-groups[${groupIndex}].bands[${bandIndex}]`,
          };
        })
      : [
          {
            band: null,
            bandIndex: null,
            commissionValue: groupCommission,
            currency: groupCurrency,
            bandKey: null,
            bandLabel: null,
            bandIdentity: null,
            sourcePath: `commission-groups[${groupIndex}]`,
          },
        ];

    const bandRestricted = bands.length > 0 && !isUnboundedSingleBand(bands);

    for (const outcome of outcomes) {
      const facts = factsFor(outcome.commissionValue, outcome.currency);
      const unitExplicit = unitIsExplicit(outcome.commissionValue);
      let outcomeSlot = 0;

      for (const fact of facts) {
        outcomeSlot += 1;
        commissionSequence += 1;

        const conditions = sourceConditions.map((condition) => ({ ...condition }));
        if (bandRestricted && outcome.band) {
          conditions.push(bandCondition(outcome.band, outcome.bandIndex, bandType));
        }

        const identity = groupId
          ? { strategy: "SUPPLIER_ID", sufficient: true, key: groupId, inputs: null }
          : anonymousGroupIdentity(group, {
              kind: fact.kind,
              basis: fact.basis ?? null,
              currency: fact.kind === "FIXED" ? fact.currency ?? outcome.currency ?? null : null,
            });

        const reviewReasons = [];
        if (!groupId) reviewReasons.push("supplier_group_id_missing");
        if (!groupId && !identity.sufficient) reviewReasons.push("anonymous_group_identity_insufficient");
        if (outcome.bandIdentity && !outcome.bandIdentity.sufficient) reviewReasons.push("band_identity_insufficient");
        if (!unitExplicit) reviewReasons.push("commission_unit_not_explicit");
        if (bandRestricted) reviewReasons.push("band_selection_semantics_not_verified_live");
        if (sourceConditions.length) reviewReasons.push("optimise_condition_semantics_not_verified_live");
        if (unverifiedConditions.length) reviewReasons.push("unverified_condition_dimension");
        if (fact.kind === "FIXED" && !fact.currency) reviewReasons.push("fixed_payout_currency_missing");
        if (!fact.basis || fact.basis === "UNKNOWN") reviewReasons.push("payout_basis_unknown");

        const mappingStatus = reviewReasons.length ? "REVIEW_REQUIRED" : "VERIFIED";
        const semanticStatus = reviewReasons.length ? "VERIFY_LIVE" : "VERIFIED";
        if (mappingStatus !== "VERIFIED") {
          // Fail-closed gate: the matcher cannot evaluate this MBO condition, so an
          // unverified Optimise rule yields REVIEW_REQUIRED rather than a payout guess
          // or a silent fallback to a broader rule.
          conditions.push({
            ...OPTIMISE_VERIFY_LIVE_GATE,
            sourceConditionValue: { reviewReasons },
            metadata: { mboGate: true, reviewReasons },
          });
        }

        const outcomeKey = optimiseCommissionGroupOutcomeKey({
          campaignId,
          groupKey: identity.key,
          bandKey: outcome.bandKey,
          outcomeSlot,
          conditions: conditions.filter((c) => c.sourceConditionType !== OPTIMISE_VERIFY_LIVE_GATE.sourceConditionType),
        });
        if (seen.has(outcomeKey)) continue;
        seen.add(outcomeKey);

        results.push({
          supplier: "OPTIMISE",
          sourceAccountLabel: context.sourceAccountLabel ?? "default",
          campaignSourceId: context.campaignSourceId ?? null,
          supplierCampaignId: context.supplierCampaignId ?? null,
          sourceCampaignId: campaignId,
          sourceGroupId: groupId,
          sourceGroupName: groupName,
          sourceRuleId: groupId,
          sourceRuleName: groupName,
          outcomeKey,
          outcomeSlot,
          commissionSequence,
          commissionModel: bandType ? `BANDED:${bandType}` : null,
          commissionType: fact.kind === "PERCENT" ? "PERCENTAGE" : fact.kind === "FIXED" ? "FIXED" : "OTHER",
          supplierRuleType: fact.kind === "PERCENT" ? "PERCENT" : fact.kind === "FIXED" ? "FIXED" : "OTHER",
          basis: fact.basis ?? (fact.kind === "PERCENT" ? "PERCENT_OF_SALE" : fact.kind === "FIXED" ? "FIXED_AMOUNT" : "UNKNOWN"),
          ratePercent: fact.kind === "PERCENT" ? fact.value : null,
          fixedAmount: fact.kind === "FIXED" ? fact.value : null,
          currency: fact.kind === "FIXED" ? fact.currency ?? outcome.currency ?? null : null,
          actionType: null,
          priority: null,
          rank: null,
          customerType: null,
          country: null,
          categoryProductGoal: null,
          couponOrTier: outcome.bandLabel,
          conditions,
          effectiveFrom: window.effectiveFrom,
          effectiveUntil: window.effectiveUntil,
          networkSource: context.networkSource ?? null,
          sourceObject: OPTIMISE_COMMISSION_GROUP_SOURCE_OBJECT,
          sourcePath: outcome.sourcePath,
          mappingStatus,
          fieldMappingOutcome: mappingStatus === "VERIFIED" ? "MAPPED" : "REVIEW_REQUIRED",
          ruleVersion: OPTIMISE_COMMISSION_GROUP_RULE_VERSION,
          rawRuleReference: {
            supplier: "OPTIMISE",
            campaignId,
            commissionGroupId: groupId,
            commissionGroupName: groupName,
            bandType,
            bandIndex: outcome.bandIndex,
            band: outcome.band,
            commission: groupCommission ?? null,
            currency: group.currency ?? null,
            conditions: group.conditions ?? group.condition ?? group.rules ?? null,
            group,
          },
          metadata: {
            sourceEndpoint: `GET /campaigns/${campaignId ?? "{campaignId}"}/commission-groups`,
            sourceCampaignId: campaignId,
            commissionGroupId: groupId,
            commissionGroupName: groupName,
            bandType,
            bandCount: bands.length,
            bandIndex: outcome.bandIndex,
            bandIdentityStrategy: outcome.bandIdentity
              ? outcome.bandIdentity.sufficient
                ? "BAND_SEMANTIC_FINGERPRINT"
                : "BAND_INSUFFICIENT"
              : null,
            bandIdentityInputs: outcome.bandIdentity?.inputs ?? null,
            bandIdentityKey: outcome.bandKey,
            band: outcome.band
              ? {
                  lower: bandLower(outcome.band) ?? null,
                  upper: bandUpper(outcome.band) ?? null,
                  commission: optimiseBandCommission(outcome.band) ?? null,
                }
              : null,
            groupCommission: groupCommission ?? null,
            factDisplay: fact.display,
            unitExplicit,
            identityStrategy: identity.strategy,
            identitySufficient: identity.sufficient,
            identityInputs: identity.inputs,
            sourceConditionCount: sourceConditions.length,
            unverifiedConditionCount: unverifiedConditions.length,
            reviewReasons,
            semanticStatus,
            financeReady: mappingStatus === "VERIFIED",
            sourceEffectiveFromProvided: Boolean(window.effectiveFrom),
            fetchedAt: context.fetchedAt ?? null,
          },
        });
      }
    }
  });

  return results;
}

/** Candidate ids grouped by campaign for the campaign-summary fan-out precedence rule. */
export function campaignIdsWithDetailedOutcomes(candidatesByCampaign = new Map()) {
  const ids = new Set();
  for (const [campaignId, candidates] of candidatesByCampaign) {
    if (Array.isArray(candidates) && candidates.length) ids.add(String(campaignId));
  }
  return ids;
}
