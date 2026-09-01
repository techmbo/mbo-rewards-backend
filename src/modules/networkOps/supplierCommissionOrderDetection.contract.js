/**
 * Pointer 41 — Supplier commission detection for an order.
 * Select applicable SupplierCommissionRule using canonical order facts and active conditions.
 */
import { FIELD_MAPPING_OUTCOME } from "../mapping/mappingOutcome.contract.js";
import { assignCommissionDisplaySequence } from "./supplierCommissionFlattening.contract.js";

export const CONTRACT_POINTER = 41;

export const ORDER_COMMISSION_DETECTION_SUMMARY = Object.freeze({
  detectionGoal:
    "The system must determine which SupplierCommissionRule applies to every order/conversion using canonical order facts and active commission conditions.",
  factEvidenceRule:
    "Only use a canonical fact when the source/canonical evidence supports it. Never fabricate a matching dimension.",
  ambiguousSelection:
    "If two equally specific rules match and no verified source precedence determines the winner, mark REVIEW_REQUIRED. Do not guess.",
});

/** Required detection sequence for every order/conversion. */
export const SUPPLIER_COMMISSION_DETECTION_SEQUENCE = Object.freeze([
  { rank: 1, key: "order_conversion", label: "Order/Conversion" },
  { rank: 2, key: "identify_mbo_campaign", label: "Identify MBO Campaign" },
  { rank: 3, key: "resolve_client_attribution", label: "Resolve Client Attribution" },
  { rank: 4, key: "read_canonical_order_facts", label: "Read canonical order facts" },
  { rank: 5, key: "find_active_rule_candidates", label: "Find active SupplierCommissionRule candidates for campaign and order date" },
  { rank: 6, key: "evaluate_rule_conditions", label: "Evaluate every condition for each candidate" },
  { rank: 7, key: "select_applicable_rule", label: "Select the applicable supplier rule" },
  { rank: 8, key: "record_matched_rule", label: "Record matched_commission_rule_id / Commission N" },
  { rank: 9, key: "calculate_expected_supplier_commission", label: "Calculate expected supplier commission when possible" },
  { rank: 10, key: "compare_network_actual", label: "Compare against network-reported actual commission" },
  { rank: 11, key: "continue_client_commercial_rule", label: "Continue to Client Commercial Rule matching" },
]);

/** Canonical facts usable for rule matching when evidence-supported. */
export const CANONICAL_ORDER_FACTS = Object.freeze([
  "country",
  "category",
  "product",
  "sku",
  "customerType",
  "couponVoucher",
  "actionType",
  "orderValue",
  "quantity",
  "device",
  "orderDate",
]);

export const RULE_SELECTION_PRECEDENCE = Object.freeze([
  {
    rank: 1,
    key: "complete_condition_set",
    rule: "A rule whose complete condition set matches is eligible.",
  },
  {
    rank: 2,
    key: "source_priority_rank",
    rule: "Prefer explicit supplier priority/rank when the source provides a defined precedence mechanism.",
  },
  {
    rank: 3,
    key: "most_specific_rule",
    rule: "Otherwise prefer the most specific valid rule: the matching rule with the stronger/more constrained condition set over a broader default rule.",
  },
  {
    rank: 4,
    key: "default_fallback",
    rule: "Use a valid DEFAULT rule only when no more-specific applicable rule wins.",
  },
  {
    rank: 5,
    key: "review_required_on_tie",
    rule: "If two equally specific rules match and no verified source precedence determines the winner, mark REVIEW_REQUIRED. Do not guess.",
  },
]);

const FACT_TO_DIMENSION = Object.freeze({
  country: "COUNTRY",
  category: "CATEGORY",
  product: "PRODUCT",
  sku: "SKU",
  customerType: "CUSTOMER_TYPE",
  couponVoucher: "COUPON_VOUCHER",
  actionType: "ACTION",
  orderValue: "ORDER_VALUE",
  quantity: "QUANTITY",
  device: "DEVICE",
  orderDate: "DATE",
});

export class SupplierCommissionOrderDetectionError extends Error {
  constructor(message, { code = "SUPPLIER_COMMISSION_ORDER_DETECTION_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "SupplierCommissionOrderDetectionError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function asString(value) {
  if (value == null || value === "") return null;
  return String(value).trim() || null;
}

function normalizeDimension(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s/-]+/g, "_");
}

function ruleIdFrom(rule = {}) {
  return rule.mbo_commission_rule_id ?? rule.mboCommissionRuleId ?? rule.id ?? rule.sourceRuleId ?? null;
}

function isRuleActiveForOrderDate(rule = {}, orderDate = null) {
  const when = orderDate ? new Date(orderDate) : new Date();
  const from = rule.effectiveFrom ?? rule.effective_from;
  const until = rule.effectiveUntil ?? rule.effective_until;
  if (from && new Date(from) > when) return false;
  if (until && new Date(until) < when) return false;
  if (rule.active === false || rule.inactive === true) return false;
  return true;
}

function conditionSpecificity(conditions = []) {
  return conditions.filter((condition) => normalizeDimension(condition.condition_type ?? condition.conditionType) !== "DEFAULT").length;
}

function isDefaultRule(conditions = []) {
  return conditions.some((condition) => normalizeDimension(condition.condition_type ?? condition.conditionType) === "DEFAULT");
}

function getSupportedFactValue(orderFacts = {}, factKey) {
  const evidence = orderFacts._evidence ?? orderFacts.evidence ?? {};
  const supported = evidence[factKey] ?? orderFacts[`${factKey}Supported`];
  if (supported === false) return { supported: false, value: null };
  const value = orderFacts[factKey] ?? orderFacts[factKey.replace(/([A-Z])/g, "_$1").toLowerCase()];
  if (value == null || value === "") return { supported: false, value: null };
  return { supported: true, value };
}

/**
 * Assert a canonical fact is only used when evidence supports it.
 */
export function assertCanonicalFactSupported({ fact = null, supported = true, fabricated = false } = {}) {
  if (fabricated || (supported === false && fact != null)) {
    throw new SupplierCommissionOrderDetectionError(
      "Only use a canonical order fact when source/canonical evidence supports it. Never fabricate a matching dimension.",
      {
        code: "FABRICATED_ORDER_FACT",
        details: { fact, supported, fabricated },
      },
    );
  }
  return true;
}

function evaluateCondition(condition = {}, orderFacts = {}) {
  const dimension = normalizeDimension(condition.condition_type ?? condition.conditionType);
  if (dimension === "DEFAULT") return true;

  const factKey = Object.entries(FACT_TO_DIMENSION).find(([, dim]) => dim === dimension)?.[0];
  if (!factKey) {
    return condition.operator === "MATCHES" ? false : Boolean(condition.normalized_value == null);
  }

  const { supported, value } = getSupportedFactValue(orderFacts, factKey);
  if (!supported) return false;

  const expected = condition.normalized_value ?? condition.normalizedValue;
  const operator = String(condition.operator || "EQUALS").toUpperCase();

  switch (operator) {
    case "EQUALS":
      return asString(value)?.toUpperCase() === asString(expected)?.toUpperCase();
    case "IN":
      return Array.isArray(expected)
        ? expected.map((item) => asString(item)?.toUpperCase()).includes(asString(value)?.toUpperCase())
        : false;
    case "GTE":
      return Number(value) >= Number(expected);
    case "LTE":
      return Number(value) <= Number(expected);
    default:
      return asString(value)?.toUpperCase() === asString(expected)?.toUpperCase();
  }
}

/**
 * Evaluate whether all conditions for a rule match the order facts.
 */
export function ruleMatchesOrder({ conditions = [], orderFacts = {} } = {}) {
  const list = Array.isArray(conditions) ? conditions : [];
  if (!list.length) return isDefaultRule(list);
  return list.every((condition) => evaluateCondition(condition, orderFacts));
}

/**
 * Select applicable supplier commission rule using Pointer 41 precedence.
 */
export function selectSupplierCommissionRule({
  rules = [],
  conditionsByRuleId = {},
  orderFacts = {},
  orderDate = null,
} = {}) {
  const activeRules = (Array.isArray(rules) ? rules : []).filter((rule) => isRuleActiveForOrderDate(rule, orderDate));
  const sequenced = assignCommissionDisplaySequence(activeRules);

  const eligible = sequenced
    .map((rule) => {
      const ruleId = ruleIdFrom(rule);
      const conditions = conditionsByRuleId[ruleId] ?? rule.conditions ?? [];
      const matches = ruleMatchesOrder({ conditions, orderFacts });
      return {
        rule,
        ruleId,
        conditions,
        matches,
        specificity: conditionSpecificity(conditions),
        isDefault: isDefaultRule(conditions),
        sourcePriority: rule.sourcePriority ?? rule.source_priority ?? null,
      };
    })
    .filter((entry) => entry.matches);

  if (!eligible.length) {
    return {
      status: "NO_MATCH",
      matched_commission_rule_id: null,
      displaySequence: null,
      displayLabel: null,
      fieldMappingOutcome: FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED,
      eligibleCount: 0,
    };
  }

  eligible.sort((a, b) => {
    const rankA = a.sourcePriority != null ? Number(a.sourcePriority) : Number.MAX_SAFE_INTEGER;
    const rankB = b.sourcePriority != null ? Number(b.sourcePriority) : Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    if (a.isDefault !== b.isDefault) return a.isDefault ? 1 : -1;
    return b.specificity - a.specificity;
  });

  const winner = eligible[0];
  const tied = eligible.filter(
    (entry) =>
      entry.specificity === winner.specificity &&
      (entry.sourcePriority ?? null) === (winner.sourcePriority ?? null) &&
      entry.ruleId !== winner.ruleId,
  );

  if (tied.length > 0 && winner.sourcePriority == null) {
    return {
      status: "REVIEW_REQUIRED",
      matched_commission_rule_id: null,
      displaySequence: null,
      displayLabel: null,
      fieldMappingOutcome: FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED,
      eligibleCount: eligible.length,
      tiedRuleIds: [winner.ruleId, ...tied.map((entry) => entry.ruleId)],
    };
  }

  return {
    status: "MATCHED",
    matched_commission_rule_id: winner.ruleId,
    displaySequence: winner.rule.displaySequence ?? null,
    displayLabel: winner.rule.displayLabel ?? null,
    fieldMappingOutcome: FIELD_MAPPING_OUTCOME.MAPPED,
    eligibleCount: eligible.length,
    selectedRule: winner.rule,
    specificity: winner.specificity,
  };
}

/** Pointer exemplar rules for precedence testing. */
export const POINTER_41_EXAMPLE = Object.freeze({
  rules: Object.freeze([
    { id: "scr-default", ratePercent: 8, displaySequence: 1, displayLabel: "Commission 1" },
    { id: "scr-uae", ratePercent: 10, displaySequence: 2, displayLabel: "Commission 2" },
    { id: "scr-uae-shoes", ratePercent: 15, displaySequence: 3, displayLabel: "Commission 3" },
  ]),
  conditionsByRuleId: Object.freeze({
    "scr-default": [{ condition_type: "DEFAULT", operator: "EQUALS", normalized_value: null }],
    "scr-uae": [{ condition_type: "COUNTRY", operator: "EQUALS", normalized_value: "UAE" }],
    "scr-uae-shoes": [
      { condition_type: "COUNTRY", operator: "EQUALS", normalized_value: "UAE" },
      { condition_type: "CATEGORY", operator: "EQUALS", normalized_value: "Shoes" },
    ],
  }),
});

/**
 * End-to-end detection wrapper for an order/conversion.
 */
export function detectSupplierCommissionForOrder({
  orderFacts = {},
  rules = POINTER_41_EXAMPLE.rules,
  conditionsByRuleId = POINTER_41_EXAMPLE.conditionsByRuleId,
  orderDate = null,
  networkReportedCommission = null,
} = {}) {
  const selection = selectSupplierCommissionRule({ rules, conditionsByRuleId, orderFacts, orderDate });
  const expectedSupplierCommission =
    selection.status === "MATCHED" && selection.selectedRule?.ratePercent != null
      ? Number(selection.selectedRule.ratePercent)
      : selection.selectedRule?.fixedAmount != null
        ? Number(selection.selectedRule.fixedAmount)
        : null;

  return {
    ...selection,
    expectedSupplierCommission,
    networkReportedCommission,
    commissionVariance:
      expectedSupplierCommission != null && networkReportedCommission != null
        ? Number(networkReportedCommission) - expectedSupplierCommission
        : null,
    continueToClientCommercialRule: selection.status === "MATCHED",
  };
}

export function buildSupplierCommissionOrderDetectionGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...ORDER_COMMISSION_DETECTION_SUMMARY },
    detectionSequence: SUPPLIER_COMMISSION_DETECTION_SEQUENCE.map((step) => ({ ...step })),
    canonicalOrderFacts: [...CANONICAL_ORDER_FACTS],
    selectionPrecedence: RULE_SELECTION_PRECEDENCE.map((item) => ({ ...item })),
    example: Object.freeze({
      rules: POINTER_41_EXAMPLE.rules.map((rule) => ({ ...rule })),
      uaeShoesOrder: detectSupplierCommissionForOrder({
        orderFacts: { country: "UAE", category: "Shoes", _evidence: { country: true, category: true } },
      }),
      uaeElectronicsOrder: detectSupplierCommissionForOrder({
        orderFacts: { country: "UAE", category: "Electronics", _evidence: { country: true, category: true } },
      }),
      indiaOrder: detectSupplierCommissionForOrder({
        orderFacts: { country: "IN", category: "Shoes", _evidence: { country: true, category: true } },
      }),
    }),
    runtimeRefs: Object.freeze({
      supplierCommissionRuleContract: "commercial/supplierCommissionRule.contract.js",
      supplierCommissionConditions: "networkOps/supplierCommissionConditions.contract.js",
      commercialSequencing: "networkOps/commercialCalculationSequencing.contract.js",
      attributionService: "reporting/services/attribution.service.js",
      financialTransactionService: "finance/financialTransaction.service.js",
    }),
    crossRefs: Object.freeze({
      pointer32CommercialSequencing: "Supplier rule selection precedes client commercial rule matching.",
      pointer39JointConditions: "Every condition on a rule must match for eligibility.",
      pointer37GoldenRule: "Never fabricate canonical facts to force a rule match.",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      network: family,
      sourceObject: obj,
      orderIngestion: "order/orderIngestion.service.js",
      attributionService: "reporting/services/attribution.service.js",
    });
  }

  return guide;
}

export function applySupplierCommissionOrderDetectionContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    supplierCommissionOrderDetectionPointer: CONTRACT_POINTER,
    supplierCommissionOrderDetectionNetwork: network || null,
    supplierCommissionOrderDetectionSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
