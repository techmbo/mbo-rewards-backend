const SUPPORTED_TIER_METRICS = new Set([
  "ORDER_COUNT",
  "ORDER_VALUE",
  "SUPPLIER_COMMISSION",
  "CLIENT_REVENUE",
]);

const SUPPORTED_TIER_PERIODS = new Set([
  "TRANSACTION",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "LIFETIME",
]);

function normalize(value) {
  if (value == null) return null;
  return String(value).trim().toUpperCase().replace(/[\s/-]+/g, "_");
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(4));
}

function currency(value) {
  const normalized = normalize(value);
  return normalized && normalized.length === 3 ? normalized : null;
}

function ruleType(rule = {}) {
  return normalize(rule.commissionType ?? rule.commission_type ?? rule.type) || "UNKNOWN";
}

function clientSharePercent(rule = {}) {
  const gross = asNumber(rule.grossCommission ?? rule.gross_commission);
  const client = asNumber(rule.clientCommission ?? rule.client_commission);
  if (gross == null || client == null || gross <= 0 || client < 0) return null;
  return (client / gross) * 100;
}

function completeApproval(approval = {}) {
  return Boolean(
    approval &&
      approval.allowed === true &&
      approval.approvedAt &&
      approval.approvedBy &&
      approval.approvalRef,
  );
}

export function validateClientCommercialLineage(rule = {}) {
  const agreementRef =
    rule.agreementRef ??
    rule.agreement_ref ??
    rule.commercialApprovalRef ??
    rule.commercial_approval_ref ??
    null;
  const approvedAt =
    rule.agreementApprovedAt ??
    rule.agreement_approved_at ??
    rule.commercialApprovedAt ??
    rule.commercial_approved_at ??
    null;
  const approvedBy =
    rule.agreementApprovedBy ??
    rule.agreement_approved_by ??
    rule.commercialApprovedBy ??
    rule.commercial_approved_by ??
    null;

  const missing = [];
  if (!agreementRef) missing.push("agreementRef");
  if (!approvedAt) missing.push("approvedAt");
  if (!approvedBy) missing.push("approvedBy");

  return {
    status: missing.length ? "REVIEW_REQUIRED" : "COMPLETE",
    agreementRef,
    approvedAt,
    approvedBy,
    missing,
  };
}

function metricValue(metric, context = {}) {
  const values = {
    ORDER_COUNT: context.orderCount,
    ORDER_VALUE: context.orderValue,
    SUPPLIER_COMMISSION:
      context.networkActualCommission ?? context.validatedSupplierCommission,
    CLIENT_REVENUE: context.clientRevenue,
  };
  return asNumber(values[metric]);
}

function tierBounds(tier = {}) {
  return {
    min: asNumber(tier.minInclusive ?? tier.min ?? tier.from),
    max: asNumber(tier.maxExclusive ?? tier.max ?? tier.to),
  };
}

/**
 * Tiers use min-inclusive / max-exclusive boundaries. Open-ended max is allowed.
 * Any overlapping winning bands fail closed instead of guessing.
 */
export function selectClientCommercialTier({ rule = {}, context = {} } = {}) {
  const metric = normalize(rule.tierMetric ?? rule.tier_metric);
  const period = normalize(rule.tierPeriod ?? rule.tier_period ?? "TRANSACTION");
  if (!SUPPORTED_TIER_METRICS.has(metric)) {
    return { status: "REVIEW_REQUIRED", reason: "unsupported_or_missing_tier_metric", metric, period };
  }
  if (!SUPPORTED_TIER_PERIODS.has(period)) {
    return { status: "REVIEW_REQUIRED", reason: "unsupported_tier_period", metric, period };
  }

  const value = metricValue(metric, context);
  if (value == null) {
    return { status: "REVIEW_REQUIRED", reason: `missing_tier_metric:${metric}`, metric, period };
  }

  const tiers = Array.isArray(rule.tiers) ? rule.tiers : [];
  if (!tiers.length) {
    return { status: "REVIEW_REQUIRED", reason: "missing_tier_bands", metric, period };
  }

  const invalid = [];
  const matches = [];
  tiers.forEach((tier, index) => {
    const { min, max } = tierBounds(tier);
    if (min == null || (max != null && max <= min)) {
      invalid.push(tier.id ?? index);
      return;
    }
    if (value >= min && (max == null || value < max)) {
      matches.push({ tier, index, min, max });
    }
  });

  if (invalid.length) {
    return {
      status: "REVIEW_REQUIRED",
      reason: "invalid_tier_band",
      metric,
      period,
      invalidTierIds: invalid,
    };
  }
  if (!matches.length) {
    return { status: "NO_MATCH", reason: "no_tier_band_matched", metric, period, metricValue: value };
  }
  if (matches.length > 1) {
    return {
      status: "REVIEW_REQUIRED",
      reason: "overlapping_tier_bands",
      metric,
      period,
      metricValue: value,
      matchedTierIds: matches.map((item) => item.tier.id ?? item.index),
    };
  }

  return {
    status: "MATCHED",
    metric,
    period,
    metricValue: value,
    selectedTier: matches[0].tier,
    selectedTierId: matches[0].tier.id ?? matches[0].index,
  };
}

function calculatePercentageOfSupplier(rule, context) {
  const share = clientSharePercent(rule);
  const actual = asNumber(
    context.networkActualCommission ?? context.validatedSupplierCommission,
  );
  if (share == null) {
    return { status: "REVIEW_REQUIRED", reason: "invalid_client_share_ratio" };
  }
  if (actual == null) {
    const expected = asNumber(context.expectedSupplierCommission);
    if (expected == null || context.provisionalAllowed !== true) {
      return { status: "REVIEW_REQUIRED", reason: "supplier_commission_evidence_missing" };
    }
    return {
      status: "CALCULATED",
      amount: roundMoney((expected * share) / 100),
      provisional: true,
      payoutBasis: "EXPECTED_SUPPLIER_COMMISSION",
      sharePercent: roundMoney(share),
    };
  }
  return {
    status: "CALCULATED",
    amount: roundMoney((actual * share) / 100),
    provisional: false,
    payoutBasis: "NETWORK_ACTUAL_COMMISSION",
    sharePercent: roundMoney(share),
  };
}

function calculatePercentOfOrderValue(rule, context) {
  const percent = asNumber(rule.orderValuePercent ?? rule.order_value_percent);
  const orderValue = asNumber(context.orderValue);
  if (percent == null || percent < 0) {
    return { status: "REVIEW_REQUIRED", reason: "invalid_order_value_percent" };
  }
  if (orderValue == null) {
    return { status: "REVIEW_REQUIRED", reason: "order_value_missing" };
  }
  return {
    status: "CALCULATED",
    amount: roundMoney((orderValue * percent) / 100),
    provisional: false,
    payoutBasis: "ORDER_VALUE",
    sharePercent: percent,
  };
}

function calculateFixed(rule) {
  const amount = asNumber(rule.fixedAmount ?? rule.fixed_amount);
  if (amount == null || amount < 0) {
    return { status: "REVIEW_REQUIRED", reason: "invalid_fixed_amount" };
  }
  return {
    status: "CALCULATED",
    amount: roundMoney(amount),
    provisional: false,
    payoutBasis: "FIXED_AMOUNT",
  };
}

function calculateManual(rule) {
  const amount = asNumber(rule.manualAmount ?? rule.manual_amount);
  const approved = rule.manualApproved ?? rule.manual_approved;
  const approvedAt = rule.manualApprovedAt ?? rule.manual_approved_at;
  const approvedBy = rule.manualApprovedBy ?? rule.manual_approved_by;
  if (approved !== true || !approvedAt || !approvedBy) {
    return { status: "REVIEW_REQUIRED", reason: "manual_commission_not_approved" };
  }
  if (amount == null || amount < 0) {
    return { status: "REVIEW_REQUIRED", reason: "invalid_manual_amount" };
  }
  return {
    status: "CALCULATED",
    amount: roundMoney(amount),
    provisional: false,
    payoutBasis: "MANUAL_APPROVED_AMOUNT",
  };
}

function calculateTierPayout(tier, rule, context) {
  const payoutType = normalize(
    tier.payoutType ?? tier.payout_type ?? tier.commissionType ?? tier.commission_type,
  );
  const syntheticRule = { ...rule, ...tier, commissionType: payoutType };

  if (payoutType === "PERCENT_OF_SUPPLIER_COMMISSION" || payoutType === "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION" || payoutType === "PERCENT") {
    if (tier.sharePercent != null || tier.share_percent != null) {
      const share = asNumber(tier.sharePercent ?? tier.share_percent);
      if (share == null || share < 0) {
        return { status: "REVIEW_REQUIRED", reason: "invalid_tier_share_percent" };
      }
      syntheticRule.grossCommission = 100;
      syntheticRule.clientCommission = share;
    }
    return calculatePercentageOfSupplier(syntheticRule, context);
  }
  if (payoutType === "PERCENT_OF_ORDER_VALUE" || payoutType === "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE") {
    syntheticRule.orderValuePercent =
      tier.orderValuePercent ?? tier.order_value_percent ?? tier.sharePercent ?? tier.share_percent;
    return calculatePercentOfOrderValue(syntheticRule, context);
  }
  if (payoutType === "FIXED_AMOUNT" || payoutType === "FIXED" || payoutType === "FIXED_PER_ORDER") {
    syntheticRule.fixedAmount = tier.fixedAmount ?? tier.fixed_amount ?? tier.amount;
    return calculateFixed(syntheticRule);
  }

  return { status: "REVIEW_REQUIRED", reason: `unsupported_tier_payout_type:${payoutType || "MISSING"}` };
}

export function evaluateNegativeMarginProtection({
  clientPayable = null,
  networkActualCommission = null,
  supplierCurrency = null,
  clientCurrency = null,
  subsidyApproval = null,
} = {}) {
  const client = asNumber(clientPayable);
  const actual = asNumber(networkActualCommission);
  if (client == null) {
    return { status: "REVIEW_REQUIRED", reason: "client_payable_missing", margin: null };
  }
  if (actual == null) {
    return { status: "REVIEW_REQUIRED", reason: "network_actual_commission_missing", margin: null };
  }

  const supplierCcy = currency(supplierCurrency);
  const clientCcy = currency(clientCurrency);
  if (supplierCcy && clientCcy && supplierCcy !== clientCcy) {
    return {
      status: "REVIEW_REQUIRED",
      reason: "currency_mismatch_no_fx_guessing",
      margin: null,
      supplierCurrency: supplierCcy,
      clientCurrency: clientCcy,
    };
  }

  const margin = roundMoney(actual - client);
  if (margin >= 0) {
    return { status: "ALLOWED", reason: "non_negative_margin", margin };
  }

  if (!completeApproval(subsidyApproval)) {
    return {
      status: "BLOCKED_NEGATIVE_MARGIN",
      reason: "client_payable_exceeds_supplier_commission",
      margin,
    };
  }

  return {
    status: "ALLOWED_WITH_APPROVED_SUBSIDY",
    reason: "approved_subsidy_override",
    margin,
    approvalRef: subsidyApproval.approvalRef,
    approvedAt: subsidyApproval.approvedAt,
    approvedBy: subsidyApproval.approvedBy,
  };
}

/**
 * Calculate one already-matched client commercial rule.
 * Calculation never makes an order payable by itself; finance/reconciliation remains the payable gate.
 */
export function calculateClientCommercialPayout({
  rule = {},
  context = {},
  requireAgreementLineage = true,
  subsidyApproval = null,
} = {}) {
  const type = ruleType(rule);
  const lineage = validateClientCommercialLineage(rule);
  if (requireAgreementLineage && lineage.status !== "COMPLETE") {
    return {
      status: "REVIEW_REQUIRED",
      reason: "commercial_agreement_lineage_incomplete",
      clientPayable: null,
      mboMargin: null,
      payable: false,
      lineage,
    };
  }

  let calculation;
  let tierSelection = null;

  if (
    type === "PERCENT" ||
    type === "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION" ||
    type === "DISPLAY_RANGE_WITH_ACTUAL_SPLIT"
  ) {
    calculation = calculatePercentageOfSupplier(rule, context);
  } else if (type === "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE") {
    calculation = calculatePercentOfOrderValue(rule, context);
  } else if (type === "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER" || type === "FIXED") {
    calculation = calculateFixed(rule);
  } else if (type === "MANUAL_APPROVED_CLIENT_COMMISSION") {
    calculation = calculateManual(rule);
  } else if (type === "TIERED") {
    tierSelection = selectClientCommercialTier({ rule, context });
    if (tierSelection.status !== "MATCHED") {
      return {
        status: tierSelection.status === "NO_MATCH" ? "NO_MATCH" : "REVIEW_REQUIRED",
        reason: tierSelection.reason,
        clientPayable: null,
        mboMargin: null,
        payable: false,
        tierSelection,
        lineage,
      };
    }
    calculation = calculateTierPayout(tierSelection.selectedTier, rule, context);
  } else {
    calculation = { status: "REVIEW_REQUIRED", reason: `unsupported_client_commission_type:${type}` };
  }

  if (calculation.status !== "CALCULATED") {
    return {
      status: "REVIEW_REQUIRED",
      reason: calculation.reason,
      clientPayable: null,
      mboMargin: null,
      payable: false,
      calculation,
      tierSelection,
      lineage,
    };
  }

  const margin = evaluateNegativeMarginProtection({
    clientPayable: calculation.amount,
    networkActualCommission: context.networkActualCommission,
    supplierCurrency: context.networkActualCurrency ?? context.supplierCurrency,
    clientCurrency: rule.currency ?? context.clientCurrency,
    subsidyApproval,
  });

  if (calculation.provisional) {
    return {
      status: "PROVISIONAL",
      reason: "network_actual_commission_not_yet_available",
      clientPayable: calculation.amount,
      mboMargin: null,
      payable: false,
      payoutBasis: calculation.payoutBasis,
      tierSelection,
      lineage,
      marginProtection: margin,
    };
  }

  if (margin.status === "BLOCKED_NEGATIVE_MARGIN") {
    return {
      status: "BLOCKED_NEGATIVE_MARGIN",
      reason: margin.reason,
      clientPayable: calculation.amount,
      mboMargin: margin.margin,
      payable: false,
      payoutBasis: calculation.payoutBasis,
      tierSelection,
      lineage,
      marginProtection: margin,
    };
  }

  if (margin.status === "REVIEW_REQUIRED") {
    return {
      status: "REVIEW_REQUIRED",
      reason: margin.reason,
      clientPayable: calculation.amount,
      mboMargin: margin.margin,
      payable: false,
      payoutBasis: calculation.payoutBasis,
      tierSelection,
      lineage,
      marginProtection: margin,
    };
  }

  return {
    status: "CALCULATED",
    reason: margin.reason,
    clientPayable: calculation.amount,
    mboMargin: margin.margin,
    payable: false,
    payoutBasis: calculation.payoutBasis,
    tierSelection,
    lineage,
    marginProtection: margin,
  };
}
