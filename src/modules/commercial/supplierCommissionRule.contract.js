/**
 * Pointer 12 — Supplier Commission Rule contract.
 * Campaign commission is summary-only; each rule is a separate record.
 * Rules describe advertised rate structure — not order payout truth.
 */

import { FIELD_MAPPING_OUTCOME } from "../mapping/mappingOutcome.contract.js";
import { formatCommissionSummary } from "../ops/v15FieldContract.js";
import { assessSupplierCommissionReadiness, readinessMetadata } from "./supplierCommissionReadiness.js";

/**
 * Canonical SupplierCommissionRule contract fields (persisted columns, child relation and
 * derived DTO fields). Commission 1...N is display sequencing only — there are no
 * commission_1 / commission_2 columns.
 */
export const SUPPLIER_COMMISSION_RULE_FIELDS = Object.freeze([
  "networkSource",
  "supplierCampaignId",
  "campaignSourceId",
  "sourceCampaignId",
  "sourceGroupId",
  "sourceGroupName",
  "sourceRuleId",
  "sourceRuleName",
  "outcomeKey",
  "outcomeSlot",
  "commissionSequence",
  "commissionModel",
  "commissionType",
  "supplierRuleType",
  "basis",
  "commissionValue",
  "ratePercent",
  "fixedAmount",
  "currency",
  "customerType",
  "country",
  "categoryProductGoal",
  "couponOrTier",
  "conditions",
  "effectiveFrom",
  "effectiveUntil",
  "networkSource",
  "sourceObject",
  "sourcePath",
  "mappingStatus",
  "fieldMappingOutcome",
  "ruleVersion",
].filter((field, index, list) => list.indexOf(field) === index));

function asString(value) {
  if (value == null || value === "") return null;
  return String(value).trim() || null;
}

export function buildCampaignCommissionSummary({
  grossCommission = null,
  commissionUnit = null,
  commissions = [],
  ruleCount = null,
} = {}) {
  const rates = (commissions || [])
    .filter((f) => f?.kind === "PERCENT" && Number.isFinite(Number(f.value)))
    .map((f) => Number(f.value));
  const count =
    ruleCount != null
      ? Number(ruleCount)
      : Array.isArray(commissions)
        ? commissions.length
        : 0;
  let summary = formatCommissionSummary({
    grossCommission,
    rules: count,
    commissionUnit,
    ratePercents: rates,
  });
  if (summary && count > 1 && !/^Up to/i.test(summary) && /%/.test(summary)) {
    summary = summary.replace(/^([\d.]+(?:\.\d+)?%)/, "Up to $1");
  }
  return summary;
}

/**
 * Enrich a rule record with mapping metadata. A numeric rate alone is NOT finance-ready:
 * the central readiness assessment decides MAPPED / REVIEW_REQUIRED / UNMAPPED and the
 * readiness evidence is carried in metadata. Explicit statuses supplied by the caller
 * (network-specific mappers) are preserved.
 */
export function enrichSupplierCommissionRuleRecord(base, meta = {}) {
  const readiness = assessSupplierCommissionReadiness(base, {
    sourceText: meta.sourceText ?? null,
    factDisplay: meta.factDisplay ?? base.metadata?.factDisplay ?? null,
  });
  const fieldMappingOutcome = readiness.financeReady
    ? FIELD_MAPPING_OUTCOME.MAPPED
    : FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED;

  return {
    ...base,
    networkSource: meta.networkSource ?? base.networkSource ?? null,
    sourceObject: meta.sourceObject ?? base.sourceObject ?? "campaigns",
    sourcePath: meta.sourcePath ?? base.sourcePath ?? null,
    mappingStatus: base.mappingStatus ?? readiness.mappingStatus,
    fieldMappingOutcome: base.fieldMappingOutcome ?? fieldMappingOutcome,
    ruleVersion: base.ruleVersion ?? meta.ruleVersion ?? base.mapperVersion ?? null,
    metadata: {
      ...(base.metadata && typeof base.metadata === "object" ? base.metadata : {}),
      ...readinessMetadata(readiness),
    },
  };
}

export function toSupplierCommissionRuleDto(record, context = {}) {
  if (!record) return null;
  const sc = record.supplierCampaign ?? context.supplierCampaign ?? null;
  const cs = record.campaignSource ?? context.campaignSource ?? null;
  const campaign = sc ?? cs?.supplierCampaign ?? null;
  // Explicit zero stays 0; blank/whitespace stays null (never coerced to 0).
  const numberOrNull = (value) => {
    if (value == null) return null;
    if (typeof value === "string" && value.trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const ratePercent = numberOrNull(record.ratePercent);
  const fixedAmount = numberOrNull(record.fixedAmount);
  const commissionValue =
    ratePercent != null
      ? `${ratePercent}%`
      : fixedAmount != null
        ? String(fixedAmount)
        : null;
  const status =
    record.effectiveUntil && new Date(record.effectiveUntil) < new Date()
      ? "EXPIRED"
      : "ACTIVE";
  const conditions = Array.isArray(record.conditions)
    ? record.conditions.map((condition) => ({
        id: condition?.id ?? null,
        conditionType: condition?.conditionType ?? null,
        operator: condition?.operator ?? null,
        value: condition?.value ?? null,
        sourceConditionType: condition?.sourceConditionType ?? null,
        sourceConditionValue: condition?.sourceConditionValue ?? null,
      }))
    : [];
  const campaignCountries = Array.isArray(campaign?.countryCodes) ? [...campaign.countryCodes] : [];

  return {
    id: record.id,
    networkSource: record.networkSource ?? record.supplier ?? null,
    brandName: campaign?.merchantNameRaw ?? context.brandName ?? null,
    campaignName: campaign?.campaignName ?? context.campaignName ?? null,
    supplierCampaignId: record.supplierCampaignId ?? campaign?.id ?? null,
    /** Supplier-side campaign id (source lineage), distinct from the MBO SupplierCampaign db id. */
    sourceCampaignId:
      campaign?.supplierCampaignId ?? record.sourceCampaignId ?? record.metadata?.sourceCampaignId ?? null,
    campaignSourceId: record.campaignSourceId ?? cs?.id ?? null,
    supplierCommissionRuleId: record.sourceRuleId ?? record.id,
    // Supplier lineage (never overwritten by MBO display labels).
    sourceRuleId: record.sourceRuleId ?? null,
    sourceRuleName: record.sourceRuleName ?? null,
    sourceGroupId: record.sourceGroupId ?? null,
    sourceGroupName: record.sourceGroupName ?? null,
    // Stable MBO outcome identity and display sequencing (Commission 1...N is display only).
    outcomeKey: record.outcomeKey ?? null,
    outcomeSlot: record.outcomeSlot ?? null,
    commissionSequence: record.commissionSequence ?? null,
    commissionType: record.supplierRuleType ?? record.basis ?? "UNKNOWN",
    basis: record.basis ?? null,
    commissionValue,
    ratePercent,
    fixedAmount,
    currency: record.currency ?? null,
    // Rule-scoped fields only. Campaign metadata (countries/category) is context, never
    // an implied rule restriction — see campaignCountries / campaignCategory.
    customerType: record.customerType ?? null,
    country: record.country ?? null,
    categoryProductGoal: record.categoryProductGoal ?? null,
    couponOrTier: record.couponOrTier ?? null,
    conditions,
    campaignCountries,
    campaignCategory: campaign?.categoryName ?? null,
    effectiveFrom: record.effectiveFrom ?? null,
    effectiveUntil: record.effectiveUntil ?? null,
    sourceObject: record.sourceObject ?? null,
    sourcePath: record.sourcePath ?? null,
    mappingStatus: record.mappingStatus ?? null,
    fieldMappingOutcome: record.fieldMappingOutcome ?? null,
    ruleVersion: record.ruleVersion ?? null,
    ruleStatus: status,
    sourceFieldPath: record.sourcePath ?? record.sourceObject ?? "SupplierCommissionRule",
    projected: record.projected === true,
    projectionNote: record.projectionNote ?? null,
    note: "Supplier commission rules are rate structure — not actual commission earned on orders.",
    lastModifiedAt: record.updatedAt ?? null,
  };
}

export function isOrderCommissionFact(record = {}) {
  return Boolean(
    record.orderId ||
      record.conversionId ||
      record.confirmedCommission != null ||
      record.payableCommission != null,
  );
}
