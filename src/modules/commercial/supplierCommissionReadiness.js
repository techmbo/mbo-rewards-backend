/**
 * Central finance-readiness assessment for SupplierCommissionRule candidates and rows.
 *
 * A numeric rate alone never proves financial semantics. A rule is finance-ready only
 * when its payout semantics are sufficiently established: an explicit exact percentage
 * (0% included) or an explicit fixed amount with a known currency and an executable basis,
 * no unresolved selection semantics (tiers, thresholds, unknown condition dimensions),
 * and a durable logical identity.
 *
 * Network-specific mappers (Optimise, Rakuten, CJ) decide readiness explicitly in
 * metadata.financeReady; that decision is preserved: false always blocks, true is honoured
 * subject to the matcher's normal fact/calculation safety. The generic heuristic applies
 * to generic campaign fan-out and legacy rows without an explicit decision.
 *
 * The matcher consumes the same assessment: an unready rule that is (or could be)
 * applicable makes matching REVIEW_REQUIRED instead of calculating or falling through
 * to a broader rule.
 */

import { createHash } from "node:crypto";
import { explicitNumber } from "../ops/campaignCommissions.js";

export const SUPPLIER_COMMISSION_READINESS_VERSION = "SCR-READINESS-2";

export const RULE_MAPPING_STATUS = Object.freeze({
  MAPPED: "MAPPED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  UNMAPPED: "UNMAPPED",
});

export const SEMANTIC_STATUS = Object.freeze({
  VERIFIED: "VERIFIED",
  VERIFY_LIVE: "VERIFY_LIVE",
  UNMAPPED: "UNMAPPED",
});

/** Condition dimensions whose matching meaning is not established generically. */
export const UNVERIFIED_CONDITION_TYPES = new Set([
  "OTHER_SOURCE_CONDITION",
  "CUSTOM_FIELD",
  "COMMISSION_TIER",
  "PERFORMANCE_THRESHOLD",
]);

const PERCENT_BASES = new Set(["PERCENT_OF_SALE", "CPS"]);
const FIXED_BASES = new Set([
  "FIXED_AMOUNT",
  "FIXED_PER_ORDER",
  "FIXED_PER_ITEM",
  "CPA",
  "CPL",
  "CPI",
  "CPS",
  "CPC",
  "CPM",
]);
const NOT_READY_STATUSES = new Set(["REVIEW_REQUIRED", "NEEDS_REVIEW", "UNMAPPED", "VERIFY_LIVE", "UNVERIFIED"]);

const EXPLICIT_UNIT_RE =
  /%|\bor\b|\$|£|€|₹|\b(?:rp|rm|rs\.?|usd|aed|sar|gbp|eur|idr|myr|sgd|hkd|thb|inr)\b|percent|revshare|sale-share|share|fixed|flat|cpa|cpl|cpc|cpi|cpm|cps/i;
const AMBIGUOUS_TEXT_RE = /\bup\s*to\b|\bvariable\b|\bdepends?\b|\bfrom\b\s*\d|\bstarting\b|\bmax(?:imum)?\b|\bvaries\b/i;

function present(value) {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

function text(value) {
  return present(value) ? String(value).trim() : null;
}

/** Human-readable commission text of a source entry (value + model/type), for readiness only. */
export function sourceCommissionText(entry) {
  if (entry == null) return null;
  if (typeof entry !== "object") return String(entry);
  const value =
    entry.value ??
    entry.commission ??
    entry.performance_value ??
    entry.amount ??
    entry.rate ??
    entry.payout_value ??
    entry.commissionCost ??
    entry.percentage ??
    entry.percent ??
    entry.fixed ??
    entry.fixed_amount ??
    entry.fixedAmount ??
    null;
  const model =
    entry.model ??
    entry.performance_model ??
    entry.performanceModel ??
    entry.pricing_model ??
    entry.pricingModel ??
    entry.type ??
    entry.payout_type ??
    entry.commissionType ??
    entry.commission_type ??
    null;
  if (value == null) return null;
  if (typeof value === "object") {
    const nested = value.value ?? value.amount ?? value.rate ?? value.payout ?? null;
    const nestedType = value.type ?? value.model ?? model ?? null;
    return [nestedType, nested].filter(present).map(String).join(" ") || null;
  }
  return [String(value), model].filter(present).map(String).join(" ");
}

export function commissionUnitIsExplicit(sourceText) {
  return Boolean(sourceText) && EXPLICIT_UNIT_RE.test(String(sourceText));
}

export function commissionTextIsAmbiguous(sourceText) {
  return Boolean(sourceText) && AMBIGUOUS_TEXT_RE.test(String(sourceText));
}

/** Canonical JSON: keys sorted recursively, arrays sorted by canonical form. */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).sort().join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(typeof value === "string" ? value.trim() : value);
}

export function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}

function conditionDimension(condition = {}) {
  const type = String(condition?.conditionType ?? "OTHER_SOURCE_CONDITION").toUpperCase();
  if (type === "OTHER_SOURCE_CONDITION" || type === "CUSTOM_FIELD") {
    return `${type}:${condition?.sourceConditionType ?? "UNKNOWN"}`;
  }
  return type;
}

/**
 * Order-independent condition identity. Mirrors the matcher's grouping (conditions are a
 * multiset keyed by dimension; same-dimension set-like values stay alternatives, different
 * dimensions stay conjunctive) so sorting atomic conditions loses no AND/OR semantics.
 * Identity only — persisted condition arrays keep their source order.
 */
export function canonicalConditionSignature(conditions = []) {
  return (Array.isArray(conditions) ? conditions : [])
    .filter((condition) => condition && String(condition.conditionType ?? "").toUpperCase() !== "DEFAULT")
    .map((condition) => `${conditionDimension(condition)}:${condition.operator ?? ""}:${condition.value ?? ""}`)
    .sort()
    .join("|");
}

const ECONOMIC_ENTRY_FIELDS = new Set([
  "value",
  "commission",
  "performance_value",
  "amount",
  "rate",
  "payout_value",
  "commissioncost",
  "percentage",
  "percent",
  "fixed",
  "fixed_amount",
  "fixedamount",
  "payout",
  "commissionvalue",
  "commission_value",
]);

function nonEconomicFields(entry = {}) {
  const out = {};
  for (const [key, value] of Object.entries(entry ?? {})) {
    if (value === undefined) continue;
    if (ECONOMIC_ENTRY_FIELDS.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Durable identity for a generic source entry without supplier rule/group ids.
 * Array position is never identity. The key fingerprints stable NON-economic semantics
 * (name, model/type, conditions, dimension labels, action type, payout kind/basis/currency).
 * When none of those exist the identity is INSUFFICIENT: a review-only evidence
 * fingerprint of the canonical entry keeps the row, but it can never be finance-ready.
 */
export function anonymousRuleIdentity({
  entry = {},
  conditions = [],
  kind = null,
  basis = null,
  currency = null,
  name = null,
  commissionModel = null,
  commissionType = null,
  customerType = null,
  country = null,
  categoryProductGoal = null,
  couponOrTier = null,
  actionType = null,
} = {}) {
  const lower = (value) => (text(value) ? String(value).trim().toLowerCase().replace(/\s+/g, " ") : null);
  const inputs = {
    name: lower(name),
    commissionModel: lower(commissionModel),
    commissionType: lower(commissionType),
    conditions: canonicalConditionSignature(conditions) || null,
    customerType: lower(customerType),
    country: lower(country),
    categoryProductGoal: lower(categoryProductGoal),
    couponOrTier: lower(couponOrTier),
    actionType: lower(actionType),
    kind: kind ?? null,
    basis: basis ?? null,
    currency: currency ?? null,
  };
  const semanticInputs = [
    inputs.name,
    inputs.commissionModel,
    inputs.commissionType,
    inputs.conditions,
    inputs.customerType,
    inputs.country,
    inputs.categoryProductGoal,
    inputs.couponOrTier,
    inputs.actionType,
  ];
  if (semanticInputs.some(present)) {
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
    key: `ANON_UNIDENTIFIED:${fingerprint({ ...inputs, entry: nonEconomicFields(entry), evidence: entry })}`,
    inputs,
  };
}

function metadataOf(rule) {
  return rule?.metadata && typeof rule.metadata === "object" ? rule.metadata : {};
}

/**
 * Trustworthy commission-semantics evidence for a rule.
 *
 * Only source-level evidence counts: an explicit caller-supplied source text, the
 * persisted raw supplier fragment (rawRuleReference), source text kept in metadata, or
 * the supplier-provided payout model (commissionModel is only ever copied from the
 * supplier's model/pricing fields). Normalized columns — ratePercent, fixedAmount, basis,
 * currency, supplierRuleType, commissionType (derived from the fact kind), outcomeKey,
 * sourceRuleId/sourceGroupId (lineage) and an old MAPPED status — may all have been
 * produced by an older normalizer and prove nothing about semantics.
 * The fact display is used only to detect ceilings ("Up to"), never as unit evidence,
 * because a bare source number is displayed as "10%" after normalization.
 */
export function resolveReadinessEvidence(rule = {}, { sourceText = null, factDisplay = null } = {}) {
  const metadata = metadataOf(rule);
  const sources = [];
  const parts = [];

  const explicit = text(sourceText);
  if (explicit) {
    parts.push(explicit);
    sources.push("source_text");
  }
  const raw = rule?.rawRuleReference;
  const rawText = raw != null ? text(sourceCommissionText(raw)) : null;
  if (rawText) {
    parts.push(rawText);
    sources.push("raw_rule_reference");
  }
  const metaText = text(metadata.sourceCommissionText);
  if (metaText) {
    parts.push(metaText);
    sources.push("metadata_source_commission_text");
  }
  const model = text(rule?.commissionModel);
  if (model) {
    parts.push(model);
    sources.push("supplier_commission_model");
  }

  return {
    evidenceText: parts.length ? parts.join(" ") : null,
    evidenceSources: sources,
    factDisplay: text(factDisplay) ?? text(metadata.factDisplay) ?? null,
  };
}

function conditionVerified(condition) {
  const meta = condition?.metadata && typeof condition.metadata === "object" ? condition.metadata : {};
  return meta.matcherReady === true || meta.semanticsVerified === true;
}

function buildResult({ financeReady, reviewReasons, hasNumericOutcome, mappingStatus = null, decisionSource, evidenceSources = [] }) {
  const reasons = [...new Set(reviewReasons)];
  let status = mappingStatus;
  if (!status) {
    status = financeReady
      ? RULE_MAPPING_STATUS.MAPPED
      : hasNumericOutcome
        ? RULE_MAPPING_STATUS.REVIEW_REQUIRED
        : RULE_MAPPING_STATUS.UNMAPPED;
  }
  const semanticStatus = financeReady
    ? SEMANTIC_STATUS.VERIFIED
    : hasNumericOutcome
      ? SEMANTIC_STATUS.VERIFY_LIVE
      : SEMANTIC_STATUS.UNMAPPED;
  return {
    financeReady,
    reviewReasons: reasons,
    semanticStatus,
    mappingStatus: status,
    fieldMappingOutcome: financeReady ? "MAPPED" : "REVIEW_REQUIRED",
    decisionSource,
    evidenceSources,
    readinessVersion: SUPPLIER_COMMISSION_READINESS_VERSION,
  };
}

/**
 * Assess one SupplierCommissionRule candidate or persisted row.
 *
 * @param {object} rule  candidate/row with ratePercent, fixedAmount, basis, currency,
 *                       conditions, mappingStatus, metadata, rawRuleReference, outcomeKey
 * @param {object} [options]
 * @param {string|null} [options.sourceText]  raw supplier commission text (fan-out path)
 * @param {string|null} [options.factDisplay] normalized display (e.g. "Up to 5.4%")
 * @param {object|null} [options.identity]    anonymousRuleIdentity()/supplier-id result
 */
export function assessSupplierCommissionReadiness(rule = {}, { sourceText = null, factDisplay = null, identity = null } = {}) {
  const metadata = metadataOf(rule);
  const ratePercent = explicitNumber(rule?.ratePercent);
  const fixedAmount = explicitNumber(rule?.fixedAmount);
  const hasNumericOutcome = ratePercent != null || fixedAmount != null;
  const explicitStatus = text(rule?.mappingStatus)?.toUpperCase() ?? null;

  // Network-specific explicit decision wins in both directions.
  if (metadata.financeReady === false) {
    const reasons = Array.isArray(metadata.reviewReasons) && metadata.reviewReasons.length
      ? metadata.reviewReasons
      : ["network_specific_finance_ready_false"];
    return buildResult({
      financeReady: false,
      reviewReasons: reasons,
      hasNumericOutcome,
      mappingStatus: explicitStatus ?? null,
      decisionSource: "NETWORK_SPECIFIC",
    });
  }
  if (metadata.financeReady === true) {
    return buildResult({
      financeReady: true,
      reviewReasons: [],
      hasNumericOutcome,
      mappingStatus: explicitStatus ?? null,
      decisionSource: "NETWORK_SPECIFIC",
    });
  }

  const reasons = [];
  if (explicitStatus && NOT_READY_STATUSES.has(explicitStatus)) {
    reasons.push(`mapping_status_${explicitStatus.toLowerCase()}`);
  }

  if (!hasNumericOutcome) {
    reasons.push("no_numeric_commission_outcome");
  }

  const basis = text(rule?.basis)?.toUpperCase() ?? null;
  if (ratePercent != null) {
    if (basis && !PERCENT_BASES.has(basis)) reasons.push(`percent_basis_not_executable:${basis}`);
  } else if (fixedAmount != null) {
    if (!basis || basis === "UNKNOWN") reasons.push("payout_basis_unknown");
    else if (!FIXED_BASES.has(basis)) reasons.push(`fixed_basis_not_executable:${basis}`);
    if (!text(rule?.currency)) reasons.push("fixed_payout_currency_missing");
  }

  // Numeric commission alone is never verified semantics. Readiness needs trustworthy
  // source evidence (raw fragment / source text / supplier model); legacy rows without
  // any such evidence fail closed until a re-sync attaches it.
  const evidence = resolveReadinessEvidence(rule, { sourceText, factDisplay });
  const display = evidence.factDisplay ?? "";
  const source = evidence.evidenceText ?? "";
  if (hasNumericOutcome && !source) reasons.push("legacy_readiness_evidence_missing");
  if (/^\s*up\s*to/i.test(display) || commissionTextIsAmbiguous(source)) reasons.push("up_to_ceiling_not_exact_rate");
  if (source && !commissionUnitIsExplicit(source)) reasons.push("commission_unit_not_explicit");

  for (const condition of Array.isArray(rule?.conditions) ? rule.conditions : []) {
    const type = String(condition?.conditionType ?? "").toUpperCase();
    if (UNVERIFIED_CONDITION_TYPES.has(type) && !conditionVerified(condition)) {
      reasons.push(`unverified_condition_semantics:${type}`);
    }
  }

  const identityStrategy = identity?.strategy ?? metadata.identityStrategy ?? null;
  const identitySufficient = identity ? identity.sufficient !== false : metadata.identitySufficient !== false;
  if (
    identityStrategy === "ANONYMOUS_INSUFFICIENT" ||
    !identitySufficient ||
    /ANON_UNIDENTIFIED|ANON_SOURCE_ENTRY_/.test(String(rule?.outcomeKey ?? ""))
  ) {
    reasons.push("anonymous_rule_identity_insufficient");
  }
  if (Array.isArray(metadata.reviewReasons)) {
    for (const reason of metadata.reviewReasons) if (present(reason)) reasons.push(String(reason));
  }

  return buildResult({
    financeReady: reasons.length === 0 && hasNumericOutcome,
    reviewReasons: reasons,
    hasNumericOutcome,
    decisionSource: "GENERIC",
    evidenceSources: evidence.evidenceSources,
  });
}

/** Readiness metadata fragment to persist alongside a canonical rule. */
export function readinessMetadata(assessment, extra = {}) {
  return {
    financeReady: assessment.financeReady,
    reviewReasons: assessment.reviewReasons,
    semanticStatus: assessment.semanticStatus,
    readinessVersion: assessment.readinessVersion,
    readinessDecisionSource: assessment.decisionSource,
    readinessEvidenceSources: assessment.evidenceSources ?? [],
    ...extra,
  };
}
