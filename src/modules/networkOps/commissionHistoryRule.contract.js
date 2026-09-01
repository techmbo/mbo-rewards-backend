/**
 * Pointer 45 — Commission-history rule.
 * Commission changes retain history; order matching uses the rule effective for the order/action date.
 */
import { DISPLAY_ONLY_SUMMARY_FIELDS } from "./campaignCommissionSummary.contract.js";
import { DISPLAY_LABEL_PREFIX } from "./supplierCommissionFlattening.contract.js";

export const CONTRACT_POINTER = 45;

export const COMMISSION_HISTORY_SUMMARY = Object.freeze({
  retainHistory:
    "Commission changes must retain history. Do not silently overwrite a previously active rule that may have applied to historical orders.",
  rateChangeHandling:
    "When a supplier changes a rate, preserve the previous rule/version with its effective period and create or update the succeeding active version according to source evidence.",
  orderDateMatching:
    "Order-level matching must use the rule that was effective for the relevant order/action date according to approved network/MBO logic.",
  explainHistoricalEarnings:
    "Retained history allows MBO to explain why a historical order earned a previous rate after the current campaign rate has changed.",
});

/** End-to-end commission implementation principle. */
export const COMMISSION_IMPLEMENTATION_PRINCIPLE = Object.freeze([
  {
    key: "retain_every_commission",
    rule: "Every network commission is retained.",
  },
  {
    key: "distinct_payable_outcomes",
    rule: "Every distinct payable outcome is visible separately as Commission 1...N.",
  },
  {
    key: "conditions_attached",
    rule: "Conditions remain attached to the commission they govern.",
  },
  {
    key: "summaries_only",
    rule: "Campaign averages/ranges are summaries only.",
  },
  {
    key: "order_calculation_inputs",
    rule: "Order calculations use the matched supplier commission rule and network actual commission, then apply the matched client commercial rule.",
  },
  {
    key: "payable_separate",
    rule: "Payment eligibility remains a separate finance decision.",
  },
]);

export const RULE_VERSION_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  SUPERSEDED: "SUPERSEDED",
  HISTORICAL: "HISTORICAL",
});

export const REQUIRED_HISTORY_FIELDS = Object.freeze([
  "id",
  "effectiveFrom",
  "effectiveUntil",
  "status",
  "supersededByRuleId",
  "sourceRuleId",
  "sourceEvidenceAt",
]);

export class CommissionHistoryRuleError extends Error {
  constructor(message, { code = "COMMISSION_HISTORY_RULE_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "CommissionHistoryRuleError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function ruleIdFrom(rule = {}) {
  return rule.id ?? rule.mboCommissionRuleId ?? rule.mbo_commission_rule_id ?? null;
}

function parseDate(value) {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDate(value) {
  const d = parseDate(value);
  return d ? d.toISOString() : null;
}

/**
 * Assert commission rules are not silently overwritten without history retention.
 */
export function assertNoSilentCommissionOverwrite({
  previousRule = null,
  incomingRule = null,
  historyRetained = false,
  inPlaceOverwrite = false,
} = {}) {
  if (previousRule && inPlaceOverwrite && !historyRetained) {
    throw new CommissionHistoryRuleError(
      "Do not silently overwrite a previously active commission rule that may have applied to historical orders.",
      {
        code: "SILENT_COMMISSION_OVERWRITE",
        details: {
          previousRuleId: ruleIdFrom(previousRule),
          incomingRuleId: ruleIdFrom(incomingRule),
        },
      },
    );
  }
  return true;
}

/**
 * Determine whether a rule was effective for an order/action date.
 */
export function isRuleEffectiveForOrderDate(rule = {}, orderDate = null) {
  const when = parseDate(orderDate) ?? new Date();
  const from = parseDate(rule.effectiveFrom ?? rule.effective_from);
  const until = parseDate(rule.effectiveUntil ?? rule.effective_until);
  if (from && from > when) return false;
  if (until && until < when) return false;
  if (rule.active === false || rule.inactive === true) return false;
  const status = String(rule.status || RULE_VERSION_STATUS.ACTIVE).toUpperCase();
  if (status === RULE_VERSION_STATUS.SUPERSEDED && until == null) return false;
  return true;
}

/**
 * Apply a supplier rate change while preserving the previous version and effective window.
 */
export function applyCommissionRateChange({
  existingRules = [],
  incomingRule = {},
  changeEffectiveFrom = null,
  sourceEvidenceAt = null,
} = {}) {
  const effectiveFrom = parseDate(changeEffectiveFrom ?? incomingRule.effectiveFrom ?? incomingRule.effective_from) ?? new Date();
  const lineageKey =
    incomingRule.sourceRuleId ??
    incomingRule.source_rule_id ??
    incomingRule.lineageKey ??
    incomingRule.displayLabel ??
    null;

  const sameLineage = (Array.isArray(existingRules) ? existingRules : []).filter((rule) => {
    const key =
      rule.sourceRuleId ??
      rule.source_rule_id ??
      rule.lineageKey ??
      rule.displayLabel ??
      null;
    return lineageKey != null && key === lineageKey;
  });

  const activePredecessors = sameLineage.filter(
    (rule) =>
      isRuleEffectiveForOrderDate(rule, effectiveFrom) ||
      String(rule.status || RULE_VERSION_STATUS.ACTIVE).toUpperCase() === RULE_VERSION_STATUS.ACTIVE,
  );

  const predecessor = activePredecessors.sort((a, b) => {
    const fromA = parseDate(a.effectiveFrom ?? a.effective_from)?.getTime() ?? 0;
    const fromB = parseDate(b.effectiveFrom ?? b.effective_from)?.getTime() ?? 0;
    return fromB - fromA;
  })[0];

  assertNoSilentCommissionOverwrite({
    previousRule: predecessor,
    incomingRule,
    historyRetained: true,
    inPlaceOverwrite: predecessor && ruleIdFrom(predecessor) === ruleIdFrom(incomingRule),
  });

  const preserved = (Array.isArray(existingRules) ? existingRules : []).map((rule) => {
    if (!predecessor || ruleIdFrom(rule) !== ruleIdFrom(predecessor)) return { ...rule };
    return {
      ...rule,
      effectiveUntil: isoDate(effectiveFrom),
      status: RULE_VERSION_STATUS.SUPERSEDED,
      supersededAt: isoDate(sourceEvidenceAt ?? effectiveFrom),
    };
  });

  const newRuleId =
    incomingRule.id ??
    incomingRule.mboCommissionRuleId ??
    `${ruleIdFrom(predecessor) || lineageKey || "commission"}-v${sameLineage.length + 1}`;

  const successor = {
    ...incomingRule,
    id: newRuleId,
    effectiveFrom: isoDate(effectiveFrom),
    effectiveUntil: incomingRule.effectiveUntil ?? incomingRule.effective_until ?? null,
    status: RULE_VERSION_STATUS.ACTIVE,
    supersededByRuleId: null,
    predecessorRuleId: predecessor ? ruleIdFrom(predecessor) : null,
    sourceEvidenceAt: isoDate(sourceEvidenceAt ?? effectiveFrom),
    displayLabel:
      incomingRule.displayLabel ??
      `${DISPLAY_LABEL_PREFIX} ${sameLineage.length + 1}`,
  };

  return {
    rules: [...preserved.filter((rule) => ruleIdFrom(rule) !== ruleIdFrom(predecessor)), predecessor ? preserved.find((rule) => ruleIdFrom(rule) === ruleIdFrom(predecessor)) : null, successor].filter(Boolean),
    predecessorRuleId: predecessor ? ruleIdFrom(predecessor) : null,
    successorRuleId: ruleIdFrom(successor),
    changeEffectiveFrom: isoDate(effectiveFrom),
  };
}

/**
 * Select the commission rule effective for a historical order/action date.
 */
export function selectCommissionRuleForOrderDate({
  rules = [],
  orderDate = null,
  orderFacts = {},
  conditionsByRuleId = {},
} = {}) {
  const when = orderDate ?? orderFacts.orderDate ?? orderFacts.actionDate ?? orderFacts.conversionDate ?? null;
  const eligible = (Array.isArray(rules) ? rules : [])
    .filter((rule) => isRuleEffectiveForOrderDate(rule, when))
    .map((rule) => ({
      rule,
      ruleId: ruleIdFrom(rule),
      effectiveFrom: isoDate(rule.effectiveFrom ?? rule.effective_from),
      conditions: conditionsByRuleId[ruleIdFrom(rule)] ?? rule.conditions ?? [],
    }));

  if (!eligible.length) {
    return {
      status: "NO_MATCH",
      matchedRuleId: null,
      orderDate: isoDate(when),
      reason: "No commission rule effective for order/action date",
    };
  }

  eligible.sort((a, b) => {
    const fromA = parseDate(a.effectiveFrom)?.getTime() ?? 0;
    const fromB = parseDate(b.effectiveFrom)?.getTime() ?? 0;
    return fromB - fromA;
  });

  const winner = eligible[0];
  return {
    status: "MATCHED",
    matchedRuleId: winner.ruleId,
    orderDate: isoDate(when),
    selectedRule: winner.rule,
    effectiveFrom: winner.effectiveFrom,
    effectiveUntil: isoDate(winner.rule.effectiveUntil ?? winner.rule.effective_until),
    historicalExplanation:
      winner.rule.ratePercent != null
        ? `Order on ${isoDate(when)?.slice(0, 10)} matched ${winner.rule.displayLabel || winner.ruleId} at ${winner.rule.ratePercent}%`
        : null,
  };
}

/** Pointer exemplar — rate change with historical order matching. */
export const POINTER_45_EXAMPLE = Object.freeze({
  orderDateHistorical: "2026-05-15T12:00:00.000Z",
  orderDateCurrent: "2026-08-01T12:00:00.000Z",
  rateChangeEffectiveFrom: "2026-07-01T00:00:00.000Z",
  previousRatePercent: 10,
  currentRatePercent: 15,
});

export function buildCommissionHistoryExample() {
  const initialRules = [
    {
      id: "scr-rate-v1",
      sourceRuleId: "network-rate-1",
      ratePercent: POINTER_45_EXAMPLE.previousRatePercent,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
      displayLabel: "Commission 1",
      status: RULE_VERSION_STATUS.ACTIVE,
    },
  ];

  const afterChange = applyCommissionRateChange({
    existingRules: initialRules,
    incomingRule: {
      sourceRuleId: "network-rate-1",
      ratePercent: POINTER_45_EXAMPLE.currentRatePercent,
      displayLabel: "Commission 1",
    },
    changeEffectiveFrom: POINTER_45_EXAMPLE.rateChangeEffectiveFrom,
    sourceEvidenceAt: POINTER_45_EXAMPLE.rateChangeEffectiveFrom,
  });

  return {
    afterChange,
    historicalOrder: selectCommissionRuleForOrderDate({
      rules: afterChange.rules,
      orderDate: POINTER_45_EXAMPLE.orderDateHistorical,
    }),
    currentOrder: selectCommissionRuleForOrderDate({
      rules: afterChange.rules,
      orderDate: POINTER_45_EXAMPLE.orderDateCurrent,
    }),
  };
}

export function buildCommissionHistoryRuleGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...COMMISSION_HISTORY_SUMMARY },
    implementationPrinciple: COMMISSION_IMPLEMENTATION_PRINCIPLE.map((item) => ({ ...item })),
    forbiddenSummaryBases: [...DISPLAY_ONLY_SUMMARY_FIELDS],
    requiredHistoryFields: [...REQUIRED_HISTORY_FIELDS],
    ruleVersionStatuses: Object.freeze({ ...RULE_VERSION_STATUS }),
    example: Object.freeze(buildCommissionHistoryExample()),
    runtimeRefs: Object.freeze({
      supplierCommissionRuleService: "commercial/services/supplierCommissionRule.service.js",
      supplierCommissionRuleSync: "commercial/supplierCommissionRuleSync.service.js",
      supplierCommissionOrderDetection: "networkOps/supplierCommissionOrderDetection.contract.js",
      supplierCommissionFlattening: "networkOps/supplierCommissionFlattening.contract.js",
      clientCommissionDetection: "networkOps/clientCommissionDetection.contract.js",
      payableEligibilitySeparation: "networkOps/payableEligibilitySeparation.contract.js",
    }),
    crossRefs: Object.freeze({
      pointer31ManualChangeAudit: "Mappings are versioned — commission rules follow the same non-destructive history principle.",
      pointer38Flattening: "Every distinct payable outcome remains visible as Commission 1...N.",
      pointer41OrderDetection: "Order detection respects effective windows for the order/action date.",
      pointer43ClientCommission: "Client commercial rule applies after matched supplier rule and network actual commission.",
      pointer44PayableEligibility: "Payment eligibility remains separate from commission calculation/history.",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      network: family,
      sourceObject: obj,
      supplierCommissionRuleService: "commercial/services/supplierCommissionRule.service.js",
      supplierCommissionOrderDetection: "networkOps/supplierCommissionOrderDetection.contract.js",
    });
  }

  return guide;
}

export function applyCommissionHistoryRuleContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    commissionHistoryRulePointer: CONTRACT_POINTER,
    commissionHistoryRuleNetwork: network || null,
    commissionHistoryRuleSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
