/**
 * Epic 5 — Finance cutover gates.
 * LEGACY remains default. No silent FINANCE switch.
 */

import {
  getFinanceConsumerMode,
  FINANCE_CONSUMER_MODES,
} from "./financeConsumer.service.js";

export function isFinanceCutoverExplicitlyApproved() {
  return String(process.env.FINANCE_CUTOVER_APPROVED || "").toLowerCase() === "true";
}

/**
 * Build cutover decision from technical readiness + explicit approval.
 */
export function evaluateFinanceCutoverGate({
  technicalReady = false,
  coverageComplete = false,
  unexplainedDifferences = 0,
  legacyOnly = 0,
  financeOnly = 0,
  openFxExceptions = 0,
  openCommissionRuleExceptions = 0,
  openTaxExceptions = 0,
  currencyConflicts = 0,
  mode = null,
} = {}) {
  const currentMode = mode ?? getFinanceConsumerMode();
  const explicitApproval = isFinanceCutoverExplicitlyApproved();
  const blockedReasons = [];

  if (!coverageComplete) blockedReasons.push("insufficient_financial_coverage");
  if (unexplainedDifferences > 0) blockedReasons.push("unexplained_shadow_discrepancies");
  if (legacyOnly > 0) blockedReasons.push("legacy_only_gaps");
  if (financeOnly > 0) blockedReasons.push("finance_only_gaps");
  if (openFxExceptions > 0) blockedReasons.push("open_fx_exceptions");
  if (openCommissionRuleExceptions > 0) blockedReasons.push("missing_commission_rules");
  if (openTaxExceptions > 0) blockedReasons.push("open_tax_exceptions");
  if (currencyConflicts > 0) blockedReasons.push("currency_conflicts");
  if (!explicitApproval) blockedReasons.push("explicit_operator_approval_required");

  const technicalOk =
    technicalReady &&
    coverageComplete &&
    unexplainedDifferences === 0 &&
    legacyOnly === 0 &&
    financeOnly === 0 &&
    openFxExceptions === 0 &&
    openCommissionRuleExceptions === 0 &&
    openTaxExceptions === 0 &&
    currencyConflicts === 0;

  return {
    mode: currentMode,
    defaultRemainsLegacy: currentMode === FINANCE_CONSUMER_MODES.LEGACY,
    readyForFinanceCutover: technicalOk,
    explicitOperatorApproval: explicitApproval,
    canEnableFinanceMode: technicalOk && explicitApproval,
    blockedReasons: technicalOk && explicitApproval ? [] : blockedReasons,
    path: [
      "Financial Coverage",
      "Shadow Comparison",
      "Discrepancy Classification",
      "Readiness Check",
      "Explicit Operator Approval (FINANCE_CUTOVER_APPROVED=true)",
      "FINANCE_CONSUMER_MODE=FINANCE",
    ],
  };
}
