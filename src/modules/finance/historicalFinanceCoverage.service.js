/**
 * Epic 5 — Historical financial coverage dry-run classifier.
 * Never mutates production. Never invents commission / FX / GST / payment values.
 */

export const HISTORICAL_CLASS = Object.freeze({
  SAFE_TO_BACKFILL: "SAFE_TO_BACKFILL",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  INSUFFICIENT_DATA: "INSUFFICIENT_DATA",
  ALREADY_RECOGNIZED: "ALREADY_RECOGNIZED",
});

/**
 * Classify a single approved conversion for potential FT recognition backfill.
 * @param {object} conversion — Conversion row (+ optional order, assignment, rule, earnFt)
 */
export function classifyHistoricalConversion(conversion = {}) {
  const reasons = [];
  const status = String(conversion.status || "").toUpperCase();
  if (!["APPROVED", "PAID"].includes(status)) {
    return {
      class: HISTORICAL_CLASS.INSUFFICIENT_DATA,
      reasons: ["conversion_not_approved"],
      autoBackfillAllowed: false,
    };
  }

  if (conversion.earnFinancialTransactionId || conversion.hasEarnFinancialTransaction) {
    return {
      class: HISTORICAL_CLASS.ALREADY_RECOGNIZED,
      reasons: ["earn_ft_present"],
      autoBackfillAllowed: false,
    };
  }

  const supplierCommission = conversion.supplierCommission;
  if (supplierCommission == null || supplierCommission === "" || Number(supplierCommission) < 0) {
    reasons.push("missing_or_invalid_supplier_commission");
  }

  const currency = conversion.currency || conversion.order?.currency;
  if (!currency || String(currency).length !== 3) {
    reasons.push("missing_currency");
  }

  const validation = String(conversion.order?.validationStatus || "").toUpperCase();
  if (validation && validation !== "VALIDATION_APPROVED") {
    reasons.push("order_not_validation_approved");
  }

  if (!conversion.clientAssignmentId && !conversion.clientId) {
    reasons.push("missing_client_assignment");
  }

  if (conversion.openFxException) {
    reasons.push("open_fx_exception");
  }
  if (conversion.openCommissionRuleException) {
    reasons.push("open_commission_rule_exception");
  }
  if (conversion.missingEffectiveRule) {
    reasons.push("missing_effective_commission_rule");
  }
  if (conversion.shadowDiscrepancy) {
    reasons.push("unexplained_shadow_discrepancy");
  }

  if (reasons.some((r) => r.startsWith("missing_") || r === "missing_or_invalid_supplier_commission" || r === "missing_currency" || r === "missing_client_assignment")) {
    return {
      class: HISTORICAL_CLASS.INSUFFICIENT_DATA,
      reasons,
      autoBackfillAllowed: false,
    };
  }

  if (
    reasons.includes("open_fx_exception") ||
    reasons.includes("open_commission_rule_exception") ||
    reasons.includes("missing_effective_commission_rule") ||
    reasons.includes("unexplained_shadow_discrepancy") ||
    reasons.includes("order_not_validation_approved")
  ) {
    return {
      class: HISTORICAL_CLASS.NEEDS_REVIEW,
      reasons,
      autoBackfillAllowed: false,
    };
  }

  return {
    class: HISTORICAL_CLASS.SAFE_TO_BACKFILL,
    reasons: ["eligible_inputs_present"],
    autoBackfillAllowed: false, // production mutation still requires explicit execution
  };
}

/**
 * Aggregate dry-run report from classification rows.
 */
export function summarizeHistoricalClassification(rows = []) {
  const counts = {
    SAFE_TO_BACKFILL: 0,
    NEEDS_REVIEW: 0,
    INSUFFICIENT_DATA: 0,
    ALREADY_RECOGNIZED: 0,
  };
  const reasonCounts = {};
  for (const row of rows) {
    counts[row.class] = (counts[row.class] || 0) + 1;
    for (const r of row.reasons || []) {
      reasonCounts[r] = (reasonCounts[r] || 0) + 1;
    }
  }
  return {
    counts,
    reasonCounts,
    total: rows.length,
    autoBackfill: false,
    productionMutation: false,
    note: "Dry-run only. Explicit operator execution required for any backfill. Never invent financial values.",
  };
}
