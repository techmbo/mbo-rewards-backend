import { CommissionRuleRepository } from "../repositories/commercial.repository.js";
import {
  buildClientCommercialFacts,
  matchClientCommercialRule,
} from "../clientCommercialMatcher.js";
import { calculateClientCommercialPayout } from "../clientCommercialCalculation.js";

function firstDefined(...values) {
  return values.find((value) => value != null && value !== "");
}

function persistedSubsidyApproval(rule = {}) {
  if (rule.subsidyApproved !== true) return null;
  return {
    allowed: true,
    approvalRef: rule.subsidyApprovalRef ?? null,
    approvedAt: rule.subsidyApprovedAt ?? null,
    approvedBy: rule.subsidyApprovedBy ?? null,
  };
}

function transactionDate({ order = null, conversion = null, overrides = {} } = {}) {
  return firstDefined(overrides.date, order?.orderDate, conversion?.conversionDate, new Date());
}

function jsonSafe(value) {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object") {
    if (typeof value.toJSON === "function") return jsonSafe(value.toJSON());
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  }
  return value;
}

function snapshotClientCommercialRule(rule = {}) {
  const keys = [
    "id",
    "assignmentId",
    "commissionType",
    "grossCommission",
    "clientCommission",
    "mboCommission",
    "currency",
    "orderValuePercent",
    "fixedAmount",
    "manualAmount",
    "manualApproved",
    "manualApprovedAt",
    "manualApprovedBy",
    "displayRangeMin",
    "displayRangeMax",
    "displayLabel",
    "priority",
    "priorityVerified",
    "agreementRef",
    "agreementApprovedAt",
    "agreementApprovedBy",
    "subsidyApproved",
    "subsidyApprovalRef",
    "subsidyApprovedAt",
    "subsidyApprovedBy",
    "tierMetric",
    "tierPeriod",
    "effectiveFrom",
    "effectiveUntil",
    "status",
    "conditions",
    "tiers",
  ];
  return Object.fromEntries(
    keys.filter((key) => rule[key] !== undefined).map((key) => [key, jsonSafe(rule[key])]),
  );
}

/**
 * Runtime bridge from persisted ClientCommissionRule graphs to deterministic matching/calculation.
 * This service calculates the commercial amount only. Finance/reconciliation remains responsible
 * for deciding whether the amount is payable to the client.
 */
export class ClientCommercialRuntimeService {
  constructor(deps = {}) {
    this.commissionRepo = deps.commissionRepo ?? new CommissionRuleRepository();
  }

  async evaluate({
    assignmentId,
    attributionResolved = false,
    attributionStatus = null,
    order = null,
    conversion = null,
    item = null,
    assignment = null,
    campaign = null,
    factOverrides = {},
    networkActualCommission = null,
    networkActualCurrency = null,
    expectedSupplierCommission = null,
    validatedSupplierCommission = null,
    orderCount = null,
    clientRevenue = null,
    provisionalAllowed = false,
    requireAgreementLineage = true,
  } = {}, client = null) {
    if (!assignmentId) {
      return {
        status: "REVIEW_REQUIRED",
        reason: "assignment_id_missing",
        matchedClientCommissionRuleId: null,
        clientPayable: null,
        mboMargin: null,
        payable: false,
      };
    }

    const at = transactionDate({ order, conversion, overrides: factOverrides });
    const rules = await this.commissionRepo.findEffectiveRulesForAssignment(
      assignmentId,
      new Date(at),
      client,
    );

    const facts = buildClientCommercialFacts({
      order,
      conversion,
      item,
      assignment,
      campaign,
      overrides: factOverrides,
    });

    const match = matchClientCommercialRule({
      rules,
      facts,
      attributionResolved,
      attributionStatus,
      assignmentId,
      at,
    });

    if (match.status !== "MATCHED") {
      return {
        ...match,
        clientPayable: null,
        mboMargin: null,
        payable: false,
      };
    }

    const rule = match.matchedRule;
    const calculation = calculateClientCommercialPayout({
      rule,
      context: {
        networkActualCommission,
        networkActualCurrency,
        expectedSupplierCommission,
        validatedSupplierCommission,
        orderValue: facts.orderValue,
        orderCount,
        clientRevenue,
        provisionalAllowed,
        clientCurrency: rule.currency ?? null,
      },
      requireAgreementLineage,
      subsidyApproval: persistedSubsidyApproval(rule),
    });

    return {
      status: calculation.status,
      reason: calculation.reason,
      matchedClientCommissionRuleId: match.matchedClientCommissionRuleId,
      matchedRuleSnapshot: snapshotClientCommercialRule(rule),
      ruleKind: rule.commissionType ?? null,
      displayCommission:
        String(rule.commissionType || "").toUpperCase() === "DISPLAY_RANGE_WITH_ACTUAL_SPLIT"
          ? {
              displayRangeMin: rule.displayRangeMin ?? null,
              displayRangeMax: rule.displayRangeMax ?? null,
              displayLabel: rule.displayLabel ?? null,
              financialBasis: calculation.payoutBasis ?? null,
            }
          : null,
      ruleSelectionStatus: match.status,
      clientPayable: calculation.clientPayable,
      mboMargin: calculation.mboMargin,
      payoutBasis: calculation.payoutBasis ?? null,
      provisional: calculation.status === "PROVISIONAL",
      // Calculation alone never releases money. Finance/reconciliation owns payable eligibility.
      payable: false,
      tierSelection: calculation.tierSelection ?? null,
      lineage: calculation.lineage ?? null,
      marginProtection: calculation.marginProtection ?? null,
      facts,
    };
  }
}
