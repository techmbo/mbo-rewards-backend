/**
 * Pointer 40 — Commission summary and Avg Commission.
 * Campaign-level commission fields are derived summaries only — never authoritative for order calculation.
 */

export const CONTRACT_POINTER = 40;

export const CAMPAIGN_COMMISSION_SUMMARY_RULES = Object.freeze({
  authoritativeBoundary:
    "Campaign-level commission fields are derived summaries only. They are never authoritative for order-level calculation.",
  displayOnly:
    "Avg Commission, Min Commission, Max Commission and campaign ranges are display/reporting values only. They must never participate in client payable calculation.",
  mixedNotPayable:
    "If values are not comparable, avg_commission_type = MIXED and avg_commission must not be used as a payable rate.",
  excludeExpired:
    "Expired/inactive historical rules must not be included in the current average.",
});

export const RECOMMENDED_CAMPAIGN_SUMMARY_FIELDS = Object.freeze([
  "commission_count",
  "avg_commission",
  "avg_commission_type",
  "min_commission",
  "max_commission",
  "campaign_commission_summary",
]);

export const AVG_COMMISSION_TYPE = Object.freeze({
  PERCENT: "PERCENT",
  FIXED: "FIXED",
  MIXED: "MIXED",
});

/** Fields that must never drive client payable calculation. */
export const DISPLAY_ONLY_SUMMARY_FIELDS = Object.freeze([
  "avg_commission",
  "min_commission",
  "max_commission",
  "campaign_commission_summary",
  "commissionAverageDisplay",
  "commissionDisplay",
]);

export const AVG_COMMISSION_RULES = Object.freeze([
  {
    key: "all_percent",
    rule: "If all currently active comparable commission rules are percentages, average the percentage values.",
    resultingType: AVG_COMMISSION_TYPE.PERCENT,
  },
  {
    key: "all_fixed_comparable",
    rule: "If all currently active comparable rules are fixed amounts in the same currency and comparable payout basis, average the fixed values.",
    resultingType: AVG_COMMISSION_TYPE.FIXED,
  },
  {
    key: "no_percent_fixed_mix",
    rule: "Do not average percentage and fixed-value commissions together.",
    resultingType: AVG_COMMISSION_TYPE.MIXED,
  },
  {
    key: "no_cross_currency_fixed",
    rule: "Do not average fixed amounts in different currencies together.",
    resultingType: AVG_COMMISSION_TYPE.MIXED,
  },
  {
    key: "no_incompatible_basis",
    rule: "Do not average incompatible payout bases such as CPA and CPI merely because both are fixed values.",
    resultingType: AVG_COMMISSION_TYPE.MIXED,
  },
]);

export class CampaignCommissionSummaryError extends Error {
  constructor(message, { code = "CAMPAIGN_COMMISSION_SUMMARY_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "CampaignCommissionSummaryError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function asNumber(value) {
  // Explicit zero participates in Avg/Min/Max; blank/whitespace input does not.
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeBasis(value) {
  return String(value || "UNKNOWN")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function isRuleActive(rule = {}, { now = new Date() } = {}) {
  if (rule.active === false || rule.inactive === true) return false;
  const current = now instanceof Date ? now : new Date(now);
  const from = rule.effectiveFrom ?? rule.effective_from;
  const until = rule.effectiveUntil ?? rule.effective_until;
  if (from && new Date(from) > current) return false;
  if (until && new Date(until) < current) return false;
  return true;
}

function ruleKind(rule = {}) {
  const rate = asNumber(rule.ratePercent ?? rule.rate_percent);
  if (rate != null) return "PERCENT";
  const fixed = asNumber(rule.fixedAmount ?? rule.fixed_amount);
  if (fixed != null) return "FIXED";
  return null;
}

function average(values = []) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return null;
  return Number((nums.reduce((sum, value) => sum + value, 0) / nums.length).toFixed(4));
}

function formatSummary({ avgCommissionType, avgCommission, minCommission, maxCommission, commissionCount }) {
  if (avgCommissionType === AVG_COMMISSION_TYPE.MIXED) {
    return commissionCount > 1 ? `Mixed commissions · ${commissionCount} rules` : "Mixed commissions";
  }
  if (avgCommissionType === AVG_COMMISSION_TYPE.PERCENT && avgCommission != null) {
    const min = minCommission != null ? `${minCommission}%` : null;
    const max = maxCommission != null ? `${maxCommission}%` : null;
    if (min && max && min !== max) return `${min} – ${max} avg ${avgCommission}% · ${commissionCount} rules`;
    return `${avgCommission}% avg · ${commissionCount} rules`;
  }
  if (avgCommissionType === AVG_COMMISSION_TYPE.FIXED && avgCommission != null) {
    return `${avgCommission} avg fixed · ${commissionCount} rules`;
  }
  return commissionCount ? `${commissionCount} rules` : null;
}

/**
 * Compute derived campaign commission summary from active SupplierCommissionRule records.
 */
export function computeCampaignCommissionSummary({ rules = [], now = new Date() } = {}) {
  const activeRules = (Array.isArray(rules) ? rules : []).filter((rule) => isRuleActive(rule, { now }));
  const commissionCount = activeRules.length;

  if (!commissionCount) {
    return {
      commission_count: 0,
      avg_commission: null,
      avg_commission_type: AVG_COMMISSION_TYPE.MIXED,
      min_commission: null,
      max_commission: null,
      campaign_commission_summary: null,
      payableRateAllowed: false,
    };
  }

  const kinds = new Set(activeRules.map((rule) => ruleKind(rule)).filter(Boolean));
  if (kinds.size > 1) {
    return {
      commission_count: commissionCount,
      avg_commission: null,
      avg_commission_type: AVG_COMMISSION_TYPE.MIXED,
      min_commission: null,
      max_commission: null,
      campaign_commission_summary: formatSummary({
        avgCommissionType: AVG_COMMISSION_TYPE.MIXED,
        commissionCount,
      }),
      payableRateAllowed: false,
    };
  }

  const kind = [...kinds][0];

  if (kind === "PERCENT") {
    const percents = activeRules.map((rule) => asNumber(rule.ratePercent ?? rule.rate_percent)).filter((value) => value != null);
    const avgCommission = average(percents);
    const minCommission = percents.length ? Math.min(...percents) : null;
    const maxCommission = percents.length ? Math.max(...percents) : null;
    return {
      commission_count: commissionCount,
      avg_commission: avgCommission,
      avg_commission_type: AVG_COMMISSION_TYPE.PERCENT,
      min_commission: minCommission,
      max_commission: maxCommission,
      campaign_commission_summary: formatSummary({
        avgCommissionType: AVG_COMMISSION_TYPE.PERCENT,
        avgCommission,
        minCommission,
        maxCommission,
        commissionCount,
      }),
      payableRateAllowed: false,
    };
  }

  const currencies = new Set(
    activeRules.map((rule) => String(rule.currency || "").trim().toUpperCase()).filter(Boolean),
  );
  const bases = new Set(activeRules.map((rule) => normalizeBasis(rule.basis ?? rule.supplierRuleType ?? rule.payoutBasis)));

  if (currencies.size > 1 || bases.size > 1 || bases.has("UNKNOWN")) {
    return {
      commission_count: commissionCount,
      avg_commission: null,
      avg_commission_type: AVG_COMMISSION_TYPE.MIXED,
      min_commission: null,
      max_commission: null,
      campaign_commission_summary: formatSummary({
        avgCommissionType: AVG_COMMISSION_TYPE.MIXED,
        commissionCount,
      }),
      payableRateAllowed: false,
    };
  }

  const fixedValues = activeRules
    .map((rule) => asNumber(rule.fixedAmount ?? rule.fixed_amount))
    .filter((value) => value != null);
  const avgCommission = average(fixedValues);
  const minCommission = fixedValues.length ? Math.min(...fixedValues) : null;
  const maxCommission = fixedValues.length ? Math.max(...fixedValues) : null;

  return {
    commission_count: commissionCount,
    avg_commission: avgCommission,
    avg_commission_type: AVG_COMMISSION_TYPE.FIXED,
    min_commission: minCommission,
    max_commission: maxCommission,
    campaign_commission_summary: formatSummary({
      avgCommissionType: AVG_COMMISSION_TYPE.FIXED,
      avgCommission,
      minCommission,
      maxCommission,
      commissionCount,
    }),
    payableRateAllowed: false,
  };
}

/**
 * Assert avg commission inputs are comparable under Pointer 40 rules.
 */
export function assertAvgCommissionComparable({ rules = [], avgCommissionType = null, now = new Date() } = {}) {
  const computed = computeCampaignCommissionSummary({ rules, now });
  const expected = avgCommissionType != null ? String(avgCommissionType).toUpperCase() : computed.avg_commission_type;

  if (expected !== computed.avg_commission_type) {
    throw new CampaignCommissionSummaryError("Non-comparable commission values must yield avg_commission_type = MIXED.", {
      code: "AVG_COMMISSION_NOT_MIXED",
      details: { expected, computed },
    });
  }

  if (computed.avg_commission_type === AVG_COMMISSION_TYPE.MIXED && computed.avg_commission != null) {
    throw new CampaignCommissionSummaryError(
      "avg_commission must not be used as a payable rate when avg_commission_type = MIXED.",
      {
        code: "MIXED_AVG_USED_AS_PAYABLE",
        details: { computed },
      },
    );
  }

  return true;
}

/**
 * Assert campaign summary fields are not used in client payable calculation.
 */
export function assertSummaryNotUsedForPayable({
  usedInPayableCalculation = false,
  field = null,
} = {}) {
  if (!usedInPayableCalculation) return true;

  const key = String(field || "").trim();
  if (DISPLAY_ONLY_SUMMARY_FIELDS.includes(key)) {
    throw new CampaignCommissionSummaryError(
      "Campaign commission summary fields are display/reporting values only — never authoritative for order-level or client payable calculation.",
      {
        code: "SUMMARY_USED_FOR_PAYABLE",
        details: { field: key },
      },
    );
  }

  if (!key) {
    throw new CampaignCommissionSummaryError(
      "Campaign commission summary fields must not participate in client payable calculation.",
      {
        code: "SUMMARY_USED_FOR_PAYABLE",
        details: { field: key },
      },
    );
  }

  return true;
}

export function buildCampaignCommissionSummaryGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...CAMPAIGN_COMMISSION_SUMMARY_RULES },
    recommendedFields: [...RECOMMENDED_CAMPAIGN_SUMMARY_FIELDS],
    avgCommissionTypes: Object.values(AVG_COMMISSION_TYPE),
    avgCommissionRules: AVG_COMMISSION_RULES.map((item) => ({ ...item })),
    displayOnlyFields: [...DISPLAY_ONLY_SUMMARY_FIELDS],
    runtimeRefs: Object.freeze({
      supplierCommissionRuleContract: "commercial/supplierCommissionRule.contract.js",
      buildCampaignCommissionSummary: "commercial/supplierCommissionRule.contract.js#buildCampaignCommissionSummary",
      importedRecordsService: "ops/importedRecords.service.js",
      commercialRuleEngine: "commercial/commercialRuleEngine.js",
    }),
    crossRefs: Object.freeze({
      pointer12SummaryOnly: "Supplier commission rules describe rate structure — campaign summary is derived.",
      pointer38OneOutcomeOneRecord: "Individual SupplierCommissionRule records feed the summary.",
      pointer32CommercialSequencing: "Client payable calculation uses commercial engine — not campaign averages.",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      network: family,
      sourceObject: obj,
      campaignFields: "ops/importedRecords.service.js#buildNetworkCampaignFields",
      commissionRulesApi: "networkPortal/networkPortal.service.js#listSupplierCommissionRules",
    });
  }

  return guide;
}

export function applyCampaignCommissionSummaryContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    campaignCommissionSummaryPointer: CONTRACT_POINTER,
    campaignCommissionSummaryNetwork: network || null,
    campaignCommissionSummarySourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
