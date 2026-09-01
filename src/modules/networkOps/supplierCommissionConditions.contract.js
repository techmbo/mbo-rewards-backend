/**
 * Pointer 39 — Conditions belonging to one commission must stay together.
 * Flatten payable outcomes (P38), not the AND-conditions that jointly define one outcome.
 */
import { CANONICAL_RULE_ID_FIELD } from "./supplierCommissionFlattening.contract.js";

export const CONTRACT_POINTER = 39;

export const COMMISSION_CONDITIONS_SUMMARY = Object.freeze({
  flattenOutcomesNotConditions:
    "Flatten payable outcomes, not the conditions that jointly produce one outcome.",
  oneConditionalOutcome:
    "If a supplier rule is 15% only when Category = Shoes AND Country = UAE AND Customer Type = New, that is one SupplierCommissionRule, not three separate 15% rules.",
  sharedRuleId:
    "Store all related conditions against the same commission_rule_id.",
  extensibleDimensions:
    "Do not limit the data model to only the dimensions seen in the first network.",
});

/** Generic SupplierCommissionCondition field shape. */
export const SUPPLIER_COMMISSION_CONDITION_FIELDS = Object.freeze([
  "condition_type",
  "operator",
  "normalized_value",
  "source_condition_type",
  "source_condition_value",
  "commission_rule_id",
]);

export const CONDITION_OPERATORS = Object.freeze([
  "EQUALS",
  "NOT_EQUALS",
  "IN",
  "NOT_IN",
  "GTE",
  "LTE",
  "BETWEEN",
  "CONTAINS",
  "MATCHES",
]);

/** Supported condition dimensions — extensible; not limited to first network. */
export const SUPPORTED_CONDITION_DIMENSIONS = Object.freeze([
  "DEFAULT",
  "CATEGORY",
  "PRODUCT",
  "SKU",
  "COUNTRY",
  "REGION",
  "CUSTOMER_TYPE",
  "COUPON_VOUCHER",
  "ORDER_VALUE",
  "QUANTITY",
  "ACTION",
  "DEVICE",
  "DATE",
  "PUBLISHER",
  "PERFORMANCE_TIER",
  "CUSTOM",
]);

export class SupplierCommissionConditionsError extends Error {
  constructor(message, { code = "SUPPLIER_COMMISSION_CONDITIONS_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "SupplierCommissionConditionsError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function asString(value) {
  if (value == null || value === "") return null;
  return String(value).trim() || null;
}

function ruleIdFrom(record = {}) {
  return (
    record.commission_rule_id ??
    record.commissionRuleId ??
    record.mbo_commission_rule_id ??
    record.mboCommissionRuleId ??
    record.id ??
    null
  );
}

function normalizeDimension(value) {
  const text = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s/-]+/g, "_");
  if (text === "COUPON" || text === "VOUCHER") return "COUPON_VOUCHER";
  return text;
}

/**
 * Build a normalized SupplierCommissionCondition record.
 */
export function buildSupplierCommissionCondition({
  conditionType,
  operator = "EQUALS",
  normalizedValue = null,
  sourceConditionType = null,
  sourceConditionValue = null,
  commissionRuleId = null,
} = {}) {
  const dimension = normalizeDimension(conditionType);
  if (!SUPPORTED_CONDITION_DIMENSIONS.includes(dimension)) {
    throw new SupplierCommissionConditionsError(`Unsupported condition dimension: ${conditionType}`, {
      code: "UNKNOWN_CONDITION_DIMENSION",
      details: { conditionType, supported: [...SUPPORTED_CONDITION_DIMENSIONS] },
    });
  }

  return Object.freeze({
    condition_type: dimension,
    operator: String(operator || "EQUALS").toUpperCase(),
    normalized_value: normalizedValue,
    source_condition_type: sourceConditionType ?? conditionType ?? dimension,
    source_condition_value: sourceConditionValue ?? normalizedValue,
    commission_rule_id: commissionRuleId,
  });
}

/**
 * Group conditions by commission_rule_id.
 */
export function groupConditionsByRuleId(conditions = []) {
  const groups = new Map();
  for (const condition of conditions) {
    const ruleId = ruleIdFrom(condition);
    if (!ruleId) continue;
    if (!groups.has(ruleId)) groups.set(ruleId, []);
    groups.get(ruleId).push(condition);
  }
  return groups;
}

/**
 * Assert all conditions for one payable outcome share the same commission_rule_id.
 */
export function assertConditionsStayWithRule({
  rule = null,
  conditions = [],
} = {}) {
  const ruleId = ruleIdFrom(rule);
  const list = Array.isArray(conditions) ? conditions : [];

  if (!ruleId) {
    throw new SupplierCommissionConditionsError("SupplierCommissionRule requires a commission_rule_id.", {
      code: "COMMISSION_RULE_ID_MISSING",
      details: { rule },
    });
  }

  const mismatched = list.filter((condition) => {
    const conditionRuleId = ruleIdFrom(condition);
    return conditionRuleId != null && conditionRuleId !== ruleId;
  });

  if (mismatched.length) {
    throw new SupplierCommissionConditionsError(
      "All related conditions must be stored against the same commission_rule_id.",
      {
        code: "CONDITIONS_SPLIT_ACROSS_RULES",
        details: { ruleId, mismatched },
      },
    );
  }

  const missingRuleId = list.filter((condition) => ruleIdFrom(condition) == null);
  if (missingRuleId.length) {
    throw new SupplierCommissionConditionsError(
      "Each SupplierCommissionCondition must reference its commission_rule_id.",
      {
        code: "CONDITION_RULE_ID_MISSING",
        details: { ruleId, missingRuleId },
      },
    );
  }

  return true;
}

/**
 * Assert joint AND-conditions were not incorrectly split into separate payable rules.
 */
export function assertNoConditionSplitAcrossRules({
  rules = [],
  conditions = [],
} = {}) {
  const ruleList = Array.isArray(rules) ? rules : [];
  const conditionList = Array.isArray(conditions) ? conditions : [];

  if (ruleList.length > 1 && conditionList.length > 0) {
    const rates = ruleList.map((rule) => rule.ratePercent ?? rule.fixedAmount ?? rule.commissionValue);
    const uniqueRates = new Set(rates.filter((value) => value != null));
    const dimensions = new Set(
      conditionList.map((condition) => normalizeDimension(condition.condition_type ?? condition.conditionType)),
    );

    if (uniqueRates.size === 1 && dimensions.size === ruleList.length && ruleList.length > 1) {
      throw new SupplierCommissionConditionsError(
        "Do not split joint AND-conditions into separate SupplierCommissionRule records with the same payable outcome.",
        {
          code: "JOINT_CONDITIONS_SPLIT_INTO_RULES",
          details: { ruleCount: ruleList.length, conditionCount: conditionList.length, rate: [...uniqueRates][0] },
        },
      );
    }
  }

  const grouped = groupConditionsByRuleId(conditionList);
  for (const [ruleId, group] of grouped.entries()) {
    const matchingRules = ruleList.filter((rule) => ruleIdFrom(rule) === ruleId);
    if (group.length > 1 && matchingRules.length > 1) {
      throw new SupplierCommissionConditionsError(
        "Conditions belonging to one commission must stay together on one SupplierCommissionRule.",
        {
          code: "CONDITIONS_SPLIT_ACROSS_RULES",
          details: { ruleId, conditionCount: group.length, ruleMatches: matchingRules.length },
        },
      );
    }
  }

  return true;
}

/** Pointer exemplar — one 15% rule with three AND conditions. */
export const POINTER_39_EXAMPLE = Object.freeze({
  rule: Object.freeze({
    mbo_commission_rule_id: "scr-shoes-uae-new",
    ratePercent: 15,
    commission_rule_id: "scr-shoes-uae-new",
  }),
  conditions: Object.freeze([
    buildSupplierCommissionCondition({
      conditionType: "CATEGORY",
      normalizedValue: "Shoes",
      sourceConditionType: "Category",
      sourceConditionValue: "Shoes",
      commissionRuleId: "scr-shoes-uae-new",
    }),
    buildSupplierCommissionCondition({
      conditionType: "COUNTRY",
      normalizedValue: "UAE",
      sourceConditionType: "Country",
      sourceConditionValue: "UAE",
      commissionRuleId: "scr-shoes-uae-new",
    }),
    buildSupplierCommissionCondition({
      conditionType: "CUSTOMER_TYPE",
      normalizedValue: "New",
      sourceConditionType: "Customer Type",
      sourceConditionValue: "New",
      commissionRuleId: "scr-shoes-uae-new",
    }),
  ]),
});

export function buildSupplierCommissionConditionsGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...COMMISSION_CONDITIONS_SUMMARY },
    conditionFields: [...SUPPLIER_COMMISSION_CONDITION_FIELDS],
    supportedDimensions: [...SUPPORTED_CONDITION_DIMENSIONS],
    operators: [...CONDITION_OPERATORS],
    canonicalRuleIdField: CANONICAL_RULE_ID_FIELD,
    example: Object.freeze({
      rule: { ...POINTER_39_EXAMPLE.rule },
      conditions: POINTER_39_EXAMPLE.conditions.map((condition) => ({ ...condition })),
    }),
    runtimeRefs: Object.freeze({
      supplierCommissionFlattening: "networkOps/supplierCommissionFlattening.contract.js",
      supplierCommissionRuleContract: "commercial/supplierCommissionRule.contract.js",
      supplierCommissionRuleFanOut: "commercial/supplierCommissionRuleFanOut.js",
      prismaModel: "prisma/schema.prisma#SupplierCommissionRule",
    }),
    crossRefs: Object.freeze({
      pointer38FlattenOutcomes:
        "Pointer 38 flattens distinct payable outcomes — Pointer 39 keeps joint conditions on one outcome.",
      pointer38OneOutcomeOneRecord: "One distinct payable outcome = one SupplierCommissionRule record.",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      network: family,
      sourceObject: obj,
      commissionRulesApi: "networkPortal/networkPortal.service.js#listSupplierCommissionRules",
      fanOut: "commercial/supplierCommissionRuleFanOut.js",
    });
  }

  return guide;
}

export function applySupplierCommissionConditionsContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    supplierCommissionConditionsPointer: CONTRACT_POINTER,
    supplierCommissionConditionsNetwork: network || null,
    supplierCommissionConditionsSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
