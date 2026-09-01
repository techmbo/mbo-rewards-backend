/**
 * Epic 2 — single authoritative commercial calculation engine (v15 07A/07B).
 *
 * Display commission ≠ financial payable for DISPLAY_RANGE rules.
 * FinancialTransaction remains SoT via FinanceService recognition.
 */

import { applyCommissionRuleToGross } from "../reporting/attributionMath.js";

const ROUND = (n) => Number(Number(n).toFixed(4));
const FIXED4 = (n) => ROUND(n).toFixed(4);

export const V15_RULE_TYPES = Object.freeze({
  PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
  FIXED_CLIENT_PERCENT_OF_ORDER_VALUE: "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE",
  FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER: "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER",
  MANUAL_APPROVED_CLIENT_COMMISSION: "MANUAL_APPROVED_CLIENT_COMMISSION",
  DISPLAY_RANGE_WITH_ACTUAL_SPLIT: "DISPLAY_RANGE_WITH_ACTUAL_SPLIT",
});

export function resolveActualSupplierCommission(conversion, { order = null } = {}) {
  if (!conversion) {
    return { ok: false, reason: "missing_conversion", amount: null };
  }
  if (order?.validationStatus === "VALIDATION_REJECTED" || conversion.status === "REJECTED") {
    return { ok: false, reason: "rejected_transaction", amount: null };
  }
  const raw =
    conversion.approvedCommission != null && conversion.approvedCommission !== ""
      ? conversion.approvedCommission
      : conversion.supplierCommission;
  if (raw == null || raw === "") {
    return { ok: false, reason: "missing_supplier_commission", amount: null };
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount)) {
    return { ok: false, reason: "missing_supplier_commission", amount: null };
  }
  if (amount < 0) {
    return { ok: false, reason: "negative_supplier_commission", amount: null };
  }
  return { ok: true, amount, amountFixed: amount.toFixed(4) };
}

/** Normalize legacy Prisma enums → engine kind. */
export function resolveRuleKind(rule) {
  const t = String(rule?.commissionType || "UNKNOWN").toUpperCase();
  if (t === "PERCENT" || t === "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION") {
    return V15_RULE_TYPES.PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION;
  }
  if (t === "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE") {
    return V15_RULE_TYPES.FIXED_CLIENT_PERCENT_OF_ORDER_VALUE;
  }
  if (t === "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER") {
    return V15_RULE_TYPES.FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER;
  }
  if (t === "FIXED") {
    // Legacy FIXED only if fixedAmount configured — else unresolved
    if (rule?.fixedAmount != null && rule.fixedAmount !== "") {
      return V15_RULE_TYPES.FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER;
    }
    return "LEGACY_FIXED_UNMAPPED";
  }
  if (t === "MANUAL_APPROVED_CLIENT_COMMISSION") {
    return V15_RULE_TYPES.MANUAL_APPROVED_CLIENT_COMMISSION;
  }
  if (t === "DISPLAY_RANGE_WITH_ACTUAL_SPLIT") {
    return V15_RULE_TYPES.DISPLAY_RANGE_WITH_ACTUAL_SPLIT;
  }
  if (t === "TIERED") return "TIERED_NOT_IMPLEMENTED";
  if (t === "UNKNOWN") {
    // Prefer ratio if gross/client present
    if (Number(rule?.grossCommission) > 0 && rule?.clientCommission != null) {
      return V15_RULE_TYPES.PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION;
    }
    return "UNKNOWN_UNRESOLVED";
  }
  return t;
}

/**
 * Resolve order value for FIXED_CLIENT_PERCENT_OF_ORDER_VALUE.
 * Prefer Order.orderValue; fallback conversion metadata common keys.
 */
export function resolveOrderValue({ order, conversion }) {
  if (order?.orderValue != null && order.orderValue !== "") {
    const n = Number(order.orderValue);
    if (Number.isFinite(n) && n >= 0) return { ok: true, amount: n, source: "order.orderValue" };
  }
  const meta = conversion?.metadata && typeof conversion.metadata === "object" ? conversion.metadata : {};
  const candidates = [
    meta.orderValue,
    meta.order_value,
    meta.saleAmount,
    meta.sales_amount,
    meta.revenue,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return { ok: true, amount: n, source: "conversion.metadata" };
  }
  return { ok: false, reason: "missing_order_value", amount: null };
}

function buildDisplay(rule, kind) {
  if (kind !== V15_RULE_TYPES.DISPLAY_RANGE_WITH_ACTUAL_SPLIT) {
    return null;
  }
  return {
    displayRangeMin: rule.displayRangeMin != null ? Number(rule.displayRangeMin) : null,
    displayRangeMax: rule.displayRangeMax != null ? Number(rule.displayRangeMax) : null,
    displayLabel: rule.displayLabel ?? null,
    note: "Display only — financial payable uses actual supplier commission × client share",
  };
}

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function succeed({
  supplierGross,
  clientCommission,
  mboMargin,
  currency,
  rule,
  kind,
  method,
  meta = {},
  allowClientExceedSupplier = false,
}) {
  const sg = ROUND(supplierGross);
  const cp = ROUND(clientCommission);
  const mm = ROUND(mboMargin);
  if (Math.abs(sg - cp - mm) > 0.00015) {
    return fail("margin_reconciliation_failed");
  }
  if (!allowClientExceedSupplier && cp - sg > 1e-9) {
    return fail("client_exceeds_supplier");
  }
  return {
    ok: true,
    supplierGross: FIXED4(sg),
    clientCommission: FIXED4(cp),
    mboMargin: FIXED4(mm),
    currency: currency ? String(currency).slice(0, 3).toUpperCase() : null,
    ruleId: rule?.id ?? null,
    ruleKind: kind,
    ruleSnapshot: {
      id: rule?.id ?? null,
      assignmentId: rule?.assignmentId ?? null,
      commissionType: rule?.commissionType ?? null,
      ruleKind: kind,
      grossCommission: rule?.grossCommission != null ? String(rule.grossCommission) : null,
      clientCommission: rule?.clientCommission != null ? String(rule.clientCommission) : null,
      mboCommission: rule?.mboCommission != null ? String(rule.mboCommission) : null,
      orderValuePercent: rule?.orderValuePercent != null ? String(rule.orderValuePercent) : null,
      fixedAmount: rule?.fixedAmount != null ? String(rule.fixedAmount) : null,
      manualAmount: rule?.manualAmount != null ? String(rule.manualAmount) : null,
      manualApproved: Boolean(rule?.manualApproved),
      displayRangeMin: rule?.displayRangeMin != null ? String(rule.displayRangeMin) : null,
      displayRangeMax: rule?.displayRangeMax != null ? String(rule.displayRangeMax) : null,
      displayLabel: rule?.displayLabel ?? null,
      status: rule?.status ?? null,
      effectiveFrom: rule?.effectiveFrom ?? null,
      effectiveUntil: rule?.effectiveUntil ?? null,
      currency: rule?.currency ?? null,
    },
    displayCommission: buildDisplay(rule, kind),
    calculationMetadata: {
      method,
      neverUsedCampaignSnapshot: true,
      ...meta,
    },
  };
}

/**
 * Authoritative commercial calculation.
 * Optional `approvedBasis` from resolveApprovedCommercialBasis (Epic 9 VAL-006).
 * When omitted / FULL_ORDER_LEGACY, preserves Epic 2 full-order behavior.
 */
export function calculateCommercial({
  order,
  conversion,
  clientCommissionRule,
  currency = null,
  supplierCommissionRule = null,
  approvedBasis = null,
} = {}) {
  if (order && order.validationStatus !== "VALIDATION_APPROVED") {
    return fail(
      order.validationStatus === "VALIDATION_REJECTED"
        ? "validation_rejected"
        : "validation_not_approved",
    );
  }

  if (!clientCommissionRule) {
    return fail("missing_effective_commission_rule");
  }
  if (clientCommissionRule.status && clientCommissionRule.status !== "EFFECTIVE") {
    return fail("rule_not_effective");
  }

  const kind = resolveRuleKind(clientCommissionRule);
  const resolvedCurrency =
    currency ||
    conversion?.currency ||
    order?.currency ||
    clientCommissionRule.currency ||
    approvedBasis?.currency ||
    null;

  // Currency mismatch: rule currency vs order/conversion when both set
  const ruleCur = clientCommissionRule.currency
    ? String(clientCommissionRule.currency).toUpperCase()
    : null;
  const txnCur = (conversion?.currency || order?.currency)
    ? String(conversion?.currency || order?.currency).toUpperCase()
    : null;
  if (ruleCur && txnCur && ruleCur !== txnCur) {
    return fail("currency_mismatch", {
      calculationMetadata: { ruleCurrency: ruleCur, transactionCurrency: txnCur },
    });
  }

  if (kind === "LEGACY_FIXED_UNMAPPED") {
    return fail("legacy_fixed_unmapped");
  }
  if (kind === "TIERED_NOT_IMPLEMENTED") {
    return fail("tiered_not_implemented");
  }
  if (kind === "UNKNOWN_UNRESOLVED") {
    return fail("unknown_rule_unresolved");
  }

  const itemLevel = approvedBasis?.basisMode === "ITEM_LEVEL";

  // FIXED amount per confirmed order: fail closed on partial item approval (v15 does not define prorating).
  if (kind === V15_RULE_TYPES.FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER && itemLevel) {
    if (!approvedBasis.allItemsApproved || approvedBasis.approvedItemCount < 1) {
      return fail("partial_approval_fixed_amount_unresolved", {
        calculationMetadata: {
          basisMode: approvedBasis.basisMode,
          approvedItemCount: approvedBasis.approvedItemCount,
          rejectedItemCount: approvedBasis.rejectedItemCount,
          pendingItemCount: approvedBasis.pendingItemCount,
          note: "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER requires all items VALIDATION_APPROVED; no prorating invented.",
        },
      });
    }
  }

  let supplierGross;
  let supplierSource = "conversion";

  if (itemLevel) {
    if (!approvedBasis.approvedSupplierCommissionOk || approvedBasis.approvedSupplierCommission == null) {
      return fail("missing_approved_item_supplier_commission", {
        calculationMetadata: { basisMode: "ITEM_LEVEL", source: approvedBasis.source },
      });
    }
    supplierGross = Number(approvedBasis.approvedSupplierCommission);
    supplierSource = "sum_approved_order_item_commission";
  } else {
    const supplier = resolveActualSupplierCommission(conversion, { order });
    if (!supplier.ok) {
      return fail(supplier.reason);
    }
    supplierGross = supplier.amount;
  }

  const basisMeta = approvedBasis
    ? {
        basisMode: approvedBasis.basisMode,
        approvedItemCount: approvedBasis.approvedItemCount,
        rejectedItemCount: approvedBasis.rejectedItemCount,
        pendingItemCount: approvedBasis.pendingItemCount,
        needsReviewItemCount: approvedBasis.needsReviewItemCount,
        allItemsApproved: approvedBasis.allItemsApproved,
        supplierCommissionSource: supplierSource,
      }
    : { basisMode: "FULL_ORDER_LEGACY" };

  if (
    kind === V15_RULE_TYPES.PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION ||
    kind === V15_RULE_TYPES.DISPLAY_RANGE_WITH_ACTUAL_SPLIT
  ) {
    const split = applyCommissionRuleToGross(supplierGross, clientCommissionRule);
    if (split.ok === false) return fail(split.reason);
    return succeed({
      supplierGross,
      clientCommission: Number(split.clientCommission),
      mboMargin: Number(split.mboCommission),
      currency: resolvedCurrency,
      rule: clientCommissionRule,
      kind,
      method:
        kind === V15_RULE_TYPES.DISPLAY_RANGE_WITH_ACTUAL_SPLIT
          ? "display_range_with_actual_split"
          : "ratio_share_of_actual_supplier_commission",
      meta: {
        ratio:
          Number(clientCommissionRule.grossCommission) > 0
            ? Number(clientCommissionRule.clientCommission) /
              Number(clientCommissionRule.grossCommission)
            : null,
        usedApprovedCommission: conversion?.approvedCommission != null,
        supplierCommissionRuleId: supplierCommissionRule?.id ?? null,
        ...basisMeta,
      },
    });
  }

  if (kind === V15_RULE_TYPES.FIXED_CLIENT_PERCENT_OF_ORDER_VALUE) {
    const pct = Number(clientCommissionRule.orderValuePercent);
    if (!Number.isFinite(pct) || pct < 0) {
      return fail("missing_order_value_percent");
    }
    let orderValueAmount;
    let orderValueSource;
    if (itemLevel) {
      if (!approvedBasis.approvedOrderValueOk || approvedBasis.approvedOrderValue == null) {
        return fail("missing_approved_order_value", {
          calculationMetadata: { basisMode: "ITEM_LEVEL", source: approvedBasis.source },
        });
      }
      orderValueAmount = Number(approvedBasis.approvedOrderValue);
      orderValueSource = "sum_approved_order_item_itemValue";
    } else {
      const ov = resolveOrderValue({ order, conversion });
      if (!ov.ok) return fail(ov.reason);
      orderValueAmount = ov.amount;
      orderValueSource = ov.source;
    }
    const clientPayable = ROUND((orderValueAmount * pct) / 100);
    const mboMargin = ROUND(supplierGross - clientPayable);
    return succeed({
      supplierGross,
      clientCommission: clientPayable,
      mboMargin,
      currency: resolvedCurrency,
      rule: clientCommissionRule,
      kind,
      method: "fixed_client_percent_of_order_value",
      allowClientExceedSupplier: true,
      meta: {
        orderValue: orderValueAmount,
        orderValueSource,
        orderValuePercent: pct,
        rounding: "4dp",
        supplierCommissionRuleId: supplierCommissionRule?.id ?? null,
        ...basisMeta,
      },
    });
  }

  if (kind === V15_RULE_TYPES.FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER) {
    // Confirmed = order VALIDATION_APPROVED; with ITEM_LEVEL also requires allItemsApproved (gated above).
    const amt = Number(clientCommissionRule.fixedAmount);
    if (!Number.isFinite(amt) || amt < 0) {
      return fail("missing_fixed_amount");
    }
    const clientPayable = ROUND(amt);
    const mboMargin = ROUND(supplierGross - clientPayable);
    return succeed({
      supplierGross,
      clientCommission: clientPayable,
      mboMargin,
      currency: resolvedCurrency,
      rule: clientCommissionRule,
      kind,
      method: "fixed_client_amount_per_confirmed_order",
      allowClientExceedSupplier: true,
      meta: {
        fixedAmount: amt,
        confirmedOrderCount: 1,
        rounding: "4dp",
        supplierCommissionRuleId: supplierCommissionRule?.id ?? null,
        ...basisMeta,
      },
    });
  }

  if (kind === V15_RULE_TYPES.MANUAL_APPROVED_CLIENT_COMMISSION) {
    if (!clientCommissionRule.manualApproved) {
      return fail("manual_commission_not_approved");
    }
    const amt = Number(clientCommissionRule.manualAmount);
    if (!Number.isFinite(amt) || amt < 0) {
      return fail("missing_manual_amount");
    }
    const clientPayable = ROUND(amt);
    const mboMargin = ROUND(supplierGross - clientPayable);
    return succeed({
      supplierGross,
      clientCommission: clientPayable,
      mboMargin,
      currency: resolvedCurrency,
      rule: clientCommissionRule,
      kind,
      method: "manual_approved_client_commission",
      allowClientExceedSupplier: true,
      meta: {
        manualAmount: amt,
        manualApprovedAt: clientCommissionRule.manualApprovedAt ?? null,
        manualApprovedBy: clientCommissionRule.manualApprovedBy ?? null,
        rounding: "4dp",
        supplierCommissionRuleId: supplierCommissionRule?.id ?? null,
        ...basisMeta,
      },
    });
  }

  return fail("unsupported_rule_kind", { calculationMetadata: { kind } });
}

/**
 * Drop-in replacement used by finance recognition (same shape as calculateCommission).
 */
export function calculateCommissionViaEngine(args) {
  return calculateCommercial(args);
}

export class CommercialRuleEngine {
  calculate(args) {
    return calculateCommercial(args);
  }
}
