/**
 * Pointer 12 — Supplier Commission Rule contract.
 * Campaign commission is summary-only; each rule is a separate record.
 * Rules describe advertised rate structure — not order payout truth.
 */

import { FIELD_MAPPING_OUTCOME } from "../mapping/mappingOutcome.contract.js";
import { formatCommissionSummary } from "../ops/v15FieldContract.js";

export const SUPPLIER_COMMISSION_RULE_FIELDS = Object.freeze([
  "networkSource",
  "supplierCampaignId",
  "campaignSourceId",
  "sourceRuleId",
  "commissionType",
  "commissionValue",
  "ratePercent",
  "fixedAmount",
  "currency",
  "customerType",
  "country",
  "categoryProductGoal",
  "couponOrTier",
  "effectiveFrom",
  "effectiveUntil",
  "sourceObject",
  "sourcePath",
  "mappingStatus",
  "fieldMappingOutcome",
  "ruleVersion",
]);

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

export function enrichSupplierCommissionRuleRecord(base, meta = {}) {
  const hasRate = base.ratePercent != null || base.fixedAmount != null;
  const mappingStatus = hasRate ? "MAPPED" : "NEEDS_REVIEW";
  const fieldMappingOutcome = hasRate
    ? FIELD_MAPPING_OUTCOME.MAPPED
    : FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED;

  return {
    ...base,
    networkSource: meta.networkSource ?? base.networkSource ?? null,
    sourceObject: meta.sourceObject ?? base.sourceObject ?? "campaigns",
    sourcePath: meta.sourcePath ?? base.sourcePath ?? null,
    mappingStatus: base.mappingStatus ?? mappingStatus,
    fieldMappingOutcome: base.fieldMappingOutcome ?? fieldMappingOutcome,
    ruleVersion: base.ruleVersion ?? meta.ruleVersion ?? base.mapperVersion ?? null,
  };
}

export function toSupplierCommissionRuleDto(record, context = {}) {
  if (!record) return null;
  const sc = record.supplierCampaign ?? context.supplierCampaign ?? null;
  const cs = record.campaignSource ?? context.campaignSource ?? null;
  const campaign = sc ?? cs?.supplierCampaign ?? null;
  const ratePercent =
    record.ratePercent != null && record.ratePercent !== ""
      ? Number(record.ratePercent)
      : null;
  const fixedAmount =
    record.fixedAmount != null && record.fixedAmount !== ""
      ? Number(record.fixedAmount)
      : null;
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

  return {
    id: record.id,
    networkSource: record.networkSource ?? record.supplier ?? null,
    brandName: campaign?.merchantNameRaw ?? context.brandName ?? null,
    campaignName: campaign?.campaignName ?? context.campaignName ?? null,
    supplierCampaignId: record.supplierCampaignId ?? campaign?.id ?? null,
    campaignSourceId: record.campaignSourceId ?? cs?.id ?? null,
    supplierCommissionRuleId: record.sourceRuleId ?? record.id,
    sourceRuleId: record.sourceRuleId ?? null,
    commissionType: record.supplierRuleType ?? record.basis ?? "UNKNOWN",
    commissionValue,
    ratePercent,
    fixedAmount,
    currency: record.currency ?? null,
    customerType: record.customerType ?? null,
    country:
      record.country ??
      (Array.isArray(campaign?.countryCodes) && campaign.countryCodes.length
        ? campaign.countryCodes.join(", ")
        : null),
    categoryProductGoal: record.categoryProductGoal ?? campaign?.categoryName ?? null,
    couponOrTier: record.couponOrTier ?? null,
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
