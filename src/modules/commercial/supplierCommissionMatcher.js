/**
 * PR3 — Supplier Commission Matcher.
 *
 * Purpose:
 * - choose the one effective SupplierCommissionRule that applies to a transaction;
 * - never fall back to a DEFAULT rule when a more-specific rule cannot be evaluated;
 * - apply supplier precedence only when its meaning is explicitly verified;
 * - calculate expected supplier commission without using campaign summary/average values;
 * - compare expected supplier commission with the network-reported actual commission.
 *
 * This module is intentionally pure. Database loading stays in SupplierCommissionRuleService.
 */

const SET_LIKE_CONDITION_TYPES = new Set([
  "COUNTRY",
  "REGION",
  "CATEGORY",
  "PRODUCT",
  "PRODUCT_ID",
  "SKU",
  "SKU_LIST",
  "CUSTOMER_TYPE",
  "COUPON",
  "VOUCHER",
  "ACTION_TYPE",
  "DEVICE",
  "PUBLISHER",
  "PUBLISHER_GROUP",
  "TRAFFIC_TYPE",
  "COMMISSION_TIER",
]);

const EVENT_FIXED_BASES = new Set([
  "FIXED_AMOUNT",
  "FIXED_PER_ORDER",
  "CPA",
  "CPL",
  "CPI",
  "CPS",
]);

function round4(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Number(Number(value).toFixed(4));
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeText(value) {
  if (value == null) return null;
  return String(value).trim().toUpperCase();
}

function toComparableArray(value) {
  if (value == null || value === "") return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((item) => {
      if (item == null || item === "") return [];
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            // Preserve source string when it is not valid JSON.
          }
        }
        return [trimmed];
      }
      return [item];
    });
}

function valuesEqual(left, right) {
  const leftNumber = asNumber(left);
  const rightNumber = asNumber(right);
  if (leftNumber != null && rightNumber != null) return leftNumber === rightNumber;

  const leftDate = asDate(left);
  const rightDate = asDate(right);
  if (leftDate && rightDate && /[-T:/]/.test(String(left)) && /[-T:/]/.test(String(right))) {
    return leftDate.getTime() === rightDate.getTime();
  }

  return normalizeText(left) === normalizeText(right);
}

function factValueForCondition(condition, facts = {}) {
  const type = normalizeText(condition?.conditionType) || "";
  const map = {
    COUNTRY: "country",
    REGION: "region",
    CATEGORY: "category",
    PRODUCT: "product",
    PRODUCT_ID: "productId",
    SKU: "sku",
    SKU_LIST: "sku",
    CUSTOMER_TYPE: "customerType",
    COUPON: "coupon",
    VOUCHER: "voucher",
    ORDER_VALUE: "orderValue",
    QUANTITY: "quantity",
    ACTION_TYPE: "actionType",
    DEVICE: "device",
    DATE: "date",
    PUBLISHER: "publisher",
    PUBLISHER_GROUP: "publisherGroup",
    TRAFFIC_TYPE: "trafficType",
    PERFORMANCE_THRESHOLD: "performanceThreshold",
    COMMISSION_TIER: "commissionTier",
  };

  if (type === "DEFAULT") return true;
  if (type === "CUSTOM_FIELD" || type === "OTHER_SOURCE_CONDITION") {
    const key = condition?.sourceConditionType;
    if (key && facts.customFields && typeof facts.customFields === "object") {
      return facts.customFields[key];
    }
    return undefined;
  }

  const field = map[type];
  return field ? facts[field] : undefined;
}

function splitConditionValues(condition) {
  const candidates = [];
  const source = condition?.sourceConditionValue;
  if (Array.isArray(source)) candidates.push(...source);
  else if (source && typeof source === "object" && Array.isArray(source.values)) {
    candidates.push(...source.values);
  }
  if (!candidates.length) candidates.push(...toComparableArray(condition?.value));
  return candidates;
}

/**
 * @returns {{state:"MATCH"|"NO_MATCH"|"UNKNOWN", reason?:string}}
 */
export function evaluateSupplierCommissionCondition(condition, facts = {}) {
  const type = normalizeText(condition?.conditionType) || "OTHER_SOURCE_CONDITION";
  if (type === "DEFAULT") return { state: "MATCH" };

  const operator = normalizeText(condition?.operator || "EQ");
  const factValue = factValueForCondition(condition, facts);

  if (operator === "EXISTS") {
    return factValue == null || factValue === "" ? { state: "NO_MATCH" } : { state: "MATCH" };
  }
  if (operator === "NOT_EXISTS") {
    return factValue == null || factValue === "" ? { state: "MATCH" } : { state: "NO_MATCH" };
  }

  if (factValue == null || factValue === "") {
    return { state: "UNKNOWN", reason: `missing_fact:${type}` };
  }

  const expectedValues = splitConditionValues(condition);
  if (!expectedValues.length) {
    return { state: "UNKNOWN", reason: `missing_condition_value:${type}` };
  }

  const factValues = toComparableArray(factValue);
  const anyEqual = () =>
    factValues.some((actual) => expectedValues.some((expected) => valuesEqual(actual, expected)));

  if (operator === "EQ" || operator === "IN") {
    return anyEqual() ? { state: "MATCH" } : { state: "NO_MATCH" };
  }
  if (operator === "NEQ" || operator === "NOT_IN") {
    return anyEqual() ? { state: "NO_MATCH" } : { state: "MATCH" };
  }
  if (operator === "CONTAINS") {
    const match = factValues.some((actual) =>
      expectedValues.some((expected) => normalizeText(actual)?.includes(normalizeText(expected))),
    );
    return match ? { state: "MATCH" } : { state: "NO_MATCH" };
  }
  if (operator === "STARTS_WITH") {
    const match = factValues.some((actual) =>
      expectedValues.some((expected) => normalizeText(actual)?.startsWith(normalizeText(expected))),
    );
    return match ? { state: "MATCH" } : { state: "NO_MATCH" };
  }

  const actualNumber = asNumber(factValues[0]);
  const expectedNumber = asNumber(expectedValues[0]);
  if (["GT", "GTE", "LT", "LTE"].includes(operator)) {
    if (actualNumber == null || expectedNumber == null) {
      return { state: "UNKNOWN", reason: `non_numeric_comparison:${type}` };
    }
    if (operator === "GT") return { state: actualNumber > expectedNumber ? "MATCH" : "NO_MATCH" };
    if (operator === "GTE") return { state: actualNumber >= expectedNumber ? "MATCH" : "NO_MATCH" };
    if (operator === "LT") return { state: actualNumber < expectedNumber ? "MATCH" : "NO_MATCH" };
    return { state: actualNumber <= expectedNumber ? "MATCH" : "NO_MATCH" };
  }

  if (operator === "BETWEEN") {
    const range = expectedValues.map(asNumber).filter((value) => value != null);
    if (actualNumber == null || range.length < 2) {
      return { state: "UNKNOWN", reason: `invalid_between:${type}` };
    }
    const [min, max] = range;
    return { state: actualNumber >= min && actualNumber <= max ? "MATCH" : "NO_MATCH" };
  }

  return { state: "UNKNOWN", reason: `unsupported_operator:${operator}` };
}

function conditionGroupKey(condition) {
  const type = normalizeText(condition?.conditionType) || "OTHER_SOURCE_CONDITION";
  if (type === "CUSTOM_FIELD" || type === "OTHER_SOURCE_CONDITION") {
    return `${type}:${condition?.sourceConditionType || "UNKNOWN"}`;
  }
  return type;
}

/**
 * Same-dimension source arrays (for example countries: [AE, SA, KW]) are alternatives,
 * not AE AND SA AND KW. Range/threshold rows remain AND conditions.
 */
function evaluateConditionGroup(conditions, facts) {
  const operators = new Set(conditions.map((c) => normalizeText(c?.operator || "EQ")));
  const type = normalizeText(conditions[0]?.conditionType) || "OTHER_SOURCE_CONDITION";
  const isAlternativeSet =
    SET_LIKE_CONDITION_TYPES.has(type) &&
    [...operators].every((operator) => operator === "EQ" || operator === "IN");

  const evaluations = conditions.map((condition) => evaluateSupplierCommissionCondition(condition, facts));

  if (isAlternativeSet) {
    if (evaluations.some((item) => item.state === "MATCH")) return { state: "MATCH" };
    if (evaluations.some((item) => item.state === "UNKNOWN")) {
      return {
        state: "UNKNOWN",
        reason: evaluations.find((item) => item.state === "UNKNOWN")?.reason,
      };
    }
    return { state: "NO_MATCH" };
  }

  if (evaluations.some((item) => item.state === "NO_MATCH")) return { state: "NO_MATCH" };
  const unknown = evaluations.find((item) => item.state === "UNKNOWN");
  if (unknown) return unknown;
  return { state: "MATCH" };
}

/**
 * @returns {{state:"MATCH"|"NO_MATCH"|"UNKNOWN", specificity:number, isDefault:boolean, reasons:string[]}}
 */
export function evaluateSupplierCommissionRule(rule, facts = {}) {
  const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
  const nonDefault = conditions.filter(
    (condition) => normalizeText(condition?.conditionType) !== "DEFAULT",
  );

  if (!nonDefault.length) {
    return { state: "MATCH", specificity: 0, isDefault: true, reasons: [] };
  }

  const groups = new Map();
  for (const condition of nonDefault) {
    const key = conditionGroupKey(condition);
    const list = groups.get(key) || [];
    list.push(condition);
    groups.set(key, list);
  }

  const reasons = [];
  let hasUnknown = false;
  for (const group of groups.values()) {
    const result = evaluateConditionGroup(group, facts);
    if (result.state === "NO_MATCH") {
      return {
        state: "NO_MATCH",
        specificity: groups.size,
        isDefault: false,
        reasons,
      };
    }
    if (result.state === "UNKNOWN") {
      hasUnknown = true;
      if (result.reason) reasons.push(result.reason);
    }
  }

  return {
    state: hasUnknown ? "UNKNOWN" : "MATCH",
    specificity: groups.size,
    isDefault: false,
    reasons,
  };
}

function verifiedPrecedence(rule) {
  const metadata = rule?.metadata && typeof rule.metadata === "object" ? rule.metadata : {};
  const verified =
    metadata.sourcePrecedenceVerified === true || metadata.verifiedSourcePrecedence === true;
  if (!verified) return null;

  const explicitField = normalizeText(metadata.sourcePrecedenceField || metadata.precedenceField);
  const field = explicitField === "RANK" ? "rank" : explicitField === "PRIORITY" ? "priority" : null;
  const resolvedField = field || (rule?.priority != null ? "priority" : rule?.rank != null ? "rank" : null);
  if (!resolvedField) return null;

  const value = asNumber(rule?.[resolvedField]);
  if (value == null) return null;

  const direction = normalizeText(
    metadata.sourcePrecedenceDirection || metadata.precedenceDirection,
  );
  if (direction !== "LOWER_FIRST" && direction !== "HIGHER_FIRST") return null;

  return {
    field: resolvedField,
    direction,
    rawValue: value,
    score: direction === "LOWER_FIRST" ? -value : value,
  };
}

function chooseByVerifiedPrecedence(candidates) {
  if (candidates.length < 2) return candidates[0] || null;
  const resolved = candidates.map((candidate) => ({
    candidate,
    precedence: verifiedPrecedence(candidate.rule),
  }));
  if (resolved.some((item) => !item.precedence)) return null;

  const signature = `${resolved[0].precedence.field}|${resolved[0].precedence.direction}`;
  if (
    resolved.some(
      (item) => `${item.precedence.field}|${item.precedence.direction}` !== signature,
    )
  ) {
    return null;
  }

  const maxScore = Math.max(...resolved.map((item) => item.precedence.score));
  const winners = resolved.filter((item) => item.precedence.score === maxScore);
  return winners.length === 1 ? winners[0].candidate : null;
}

function chooseBySpecificity(candidates) {
  if (!candidates.length) return null;
  const maxSpecificity = Math.max(...candidates.map((item) => item.evaluation.specificity));
  const winners = candidates.filter((item) => item.evaluation.specificity === maxSpecificity);
  return winners.length === 1 ? winners[0] : null;
}

export function calculateExpectedSupplierCommission(rule, facts = {}) {
  if (!rule) {
    return {
      status: "NO_RULE",
      amount: null,
      currency: null,
      basis: null,
    };
  }

  const basis = normalizeText(rule.basis || "UNKNOWN");
  const ruleCurrency = rule.currency ? normalizeText(rule.currency).slice(0, 3) : null;
  const transactionCurrency = facts.currency ? normalizeText(facts.currency).slice(0, 3) : null;
  const expectedCurrency = ruleCurrency || transactionCurrency || null;

  const ratePercent = asNumber(rule.ratePercent);
  if (ratePercent != null) {
    const commissionableValue = asNumber(
      facts.commissionableValue != null ? facts.commissionableValue : facts.orderValue,
    );
    if (commissionableValue == null) {
      return {
        status: "SOURCE_DATA_MISSING",
        amount: null,
        currency: expectedCurrency,
        basis,
        reason: "missing_commissionable_value",
      };
    }
    if (basis !== "PERCENT_OF_SALE" && basis !== "CPS") {
      return {
        status: "BASIS_NOT_SUPPORTED",
        amount: null,
        currency: expectedCurrency,
        basis,
        reason: `percentage_basis_not_supported:${basis}`,
      };
    }
    return {
      status: "CALCULATED",
      amount: round4((commissionableValue * ratePercent) / 100),
      currency: expectedCurrency,
      basis,
      ratePercent,
      commissionableValue,
    };
  }

  const fixedAmount = asNumber(rule.fixedAmount);
  if (fixedAmount == null) {
    return {
      status: "SOURCE_DATA_MISSING",
      amount: null,
      currency: expectedCurrency,
      basis,
      reason: "missing_rule_amount",
    };
  }

  if (EVENT_FIXED_BASES.has(basis)) {
    return {
      status: "CALCULATED",
      amount: round4(fixedAmount),
      currency: expectedCurrency,
      basis,
      unitAmount: fixedAmount,
      units: 1,
    };
  }

  if (basis === "FIXED_PER_ITEM") {
    const quantity = asNumber(facts.quantity);
    if (quantity == null) {
      return {
        status: "SOURCE_DATA_MISSING",
        amount: null,
        currency: expectedCurrency,
        basis,
        reason: "missing_quantity",
      };
    }
    return {
      status: "CALCULATED",
      amount: round4(fixedAmount * quantity),
      currency: expectedCurrency,
      basis,
      unitAmount: fixedAmount,
      units: quantity,
    };
  }

  if (basis === "CPC") {
    const clicks = asNumber(facts.clicks);
    if (clicks == null) {
      return {
        status: "SOURCE_DATA_MISSING",
        amount: null,
        currency: expectedCurrency,
        basis,
        reason: "missing_clicks",
      };
    }
    return {
      status: "CALCULATED",
      amount: round4(fixedAmount * clicks),
      currency: expectedCurrency,
      basis,
      unitAmount: fixedAmount,
      units: clicks,
    };
  }

  if (basis === "CPM") {
    const impressions = asNumber(facts.impressions);
    if (impressions == null) {
      return {
        status: "SOURCE_DATA_MISSING",
        amount: null,
        currency: expectedCurrency,
        basis,
        reason: "missing_impressions",
      };
    }
    return {
      status: "CALCULATED",
      amount: round4(fixedAmount * (impressions / 1000)),
      currency: expectedCurrency,
      basis,
      unitAmount: fixedAmount,
      units: impressions,
    };
  }

  return {
    status: "BASIS_NOT_SUPPORTED",
    amount: null,
    currency: expectedCurrency,
    basis,
    reason: `fixed_basis_not_supported:${basis}`,
  };
}

function resolveActual(actualCommission, actualCurrency, facts = {}) {
  const amount = asNumber(actualCommission);
  const currency = actualCurrency
    ? normalizeText(actualCurrency).slice(0, 3)
    : facts.actualCurrency
      ? normalizeText(facts.actualCurrency).slice(0, 3)
      : null;
  return { amount, currency };
}

function buildComparison(expected, actual) {
  if (expected.status !== "CALCULATED" || actual.amount == null) {
    return {
      networkActualCommission: actual.amount,
      actualCurrency: actual.currency,
      variance: null,
      comparisonStatus: "NOT_COMPARABLE",
    };
  }

  if (expected.currency && actual.currency && expected.currency !== actual.currency) {
    return {
      networkActualCommission: actual.amount,
      actualCurrency: actual.currency,
      variance: null,
      comparisonStatus: "CURRENCY_MISMATCH",
    };
  }

  const variance = round4(actual.amount - expected.amount);
  return {
    networkActualCommission: actual.amount,
    actualCurrency: actual.currency,
    variance,
    comparisonStatus: Math.abs(variance) <= 0.0001 ? "MATCH" : "VARIANCE",
  };
}

/**
 * Match one supplier commission rule from already-effective rules.
 *
 * Precedence:
 * 1. all conditions match;
 * 2. verified source precedence, when comparable across candidates;
 * 3. most specific valid rule;
 * 4. DEFAULT only when no more-specific rule can still win;
 * 5. unresolved tie or missing facts => REVIEW_REQUIRED.
 */
export function matchSupplierCommissionRule({
  rules = [],
  facts = {},
  actualCommission = null,
  actualCurrency = null,
} = {}) {
  const evaluated = (Array.isArray(rules) ? rules : []).map((rule) => ({
    rule,
    evaluation: evaluateSupplierCommissionRule(rule, facts),
  }));

  const specificMatches = evaluated.filter(
    (item) => !item.evaluation.isDefault && item.evaluation.state === "MATCH",
  );
  const specificUnknown = evaluated.filter(
    (item) => !item.evaluation.isDefault && item.evaluation.state === "UNKNOWN",
  );
  const defaults = evaluated.filter(
    (item) => item.evaluation.isDefault && item.evaluation.state === "MATCH",
  );

  // Fail closed: an incompletely evaluated specific rule could still outrank a known match/default.
  if (specificUnknown.length) {
    return {
      status: "REVIEW_REQUIRED",
      reason: "specific_rule_missing_facts",
      matchedRule: null,
      matchedSupplierCommissionRuleId: null,
      matchedCommissionSequence: null,
      expectedSupplierCommission: null,
      expectedCurrency: null,
      expectedCalculationStatus: "NOT_CALCULATED",
      networkActualCommission: asNumber(actualCommission),
      actualCurrency: actualCurrency ? normalizeText(actualCurrency).slice(0, 3) : null,
      variance: null,
      comparisonStatus: "NOT_COMPARABLE",
      candidateRuleIds: specificUnknown.map((item) => item.rule?.id).filter(Boolean),
      reviewReasons: [...new Set(specificUnknown.flatMap((item) => item.evaluation.reasons))],
    };
  }

  let selected = null;
  if (specificMatches.length) {
    selected = chooseByVerifiedPrecedence(specificMatches) || chooseBySpecificity(specificMatches);
    if (!selected) {
      return {
        status: "REVIEW_REQUIRED",
        reason: "ambiguous_specific_rules",
        matchedRule: null,
        matchedSupplierCommissionRuleId: null,
        matchedCommissionSequence: null,
        expectedSupplierCommission: null,
        expectedCurrency: null,
        expectedCalculationStatus: "NOT_CALCULATED",
        networkActualCommission: asNumber(actualCommission),
        actualCurrency: actualCurrency ? normalizeText(actualCurrency).slice(0, 3) : null,
        variance: null,
        comparisonStatus: "NOT_COMPARABLE",
        candidateRuleIds: specificMatches.map((item) => item.rule?.id).filter(Boolean),
        reviewReasons: [],
      };
    }
  } else if (defaults.length) {
    selected = chooseByVerifiedPrecedence(defaults);
    if (!selected && defaults.length === 1) selected = defaults[0];
    if (!selected) {
      return {
        status: "REVIEW_REQUIRED",
        reason: "ambiguous_default_rules",
        matchedRule: null,
        matchedSupplierCommissionRuleId: null,
        matchedCommissionSequence: null,
        expectedSupplierCommission: null,
        expectedCurrency: null,
        expectedCalculationStatus: "NOT_CALCULATED",
        networkActualCommission: asNumber(actualCommission),
        actualCurrency: actualCurrency ? normalizeText(actualCurrency).slice(0, 3) : null,
        variance: null,
        comparisonStatus: "NOT_COMPARABLE",
        candidateRuleIds: defaults.map((item) => item.rule?.id).filter(Boolean),
        reviewReasons: [],
      };
    }
  }

  if (!selected) {
    return {
      status: "NO_MATCH",
      reason: "no_supplier_commission_rule_matched",
      matchedRule: null,
      matchedSupplierCommissionRuleId: null,
      matchedCommissionSequence: null,
      expectedSupplierCommission: null,
      expectedCurrency: null,
      expectedCalculationStatus: "NOT_CALCULATED",
      networkActualCommission: asNumber(actualCommission),
      actualCurrency: actualCurrency ? normalizeText(actualCurrency).slice(0, 3) : null,
      variance: null,
      comparisonStatus: "NOT_COMPARABLE",
      candidateRuleIds: [],
      reviewReasons: [],
    };
  }

  const expected = calculateExpectedSupplierCommission(selected.rule, facts);
  const actual = resolveActual(actualCommission, actualCurrency, facts);
  const comparison = buildComparison(expected, actual);

  return {
    status: "MATCHED",
    reason: selected.evaluation.isDefault ? "default_rule" : "specific_rule",
    matchedRule: selected.rule,
    matchedSupplierCommissionRuleId: selected.rule?.id ?? null,
    matchedCommissionSequence: selected.rule?.commissionSequence ?? null,
    expectedSupplierCommission: expected.amount,
    expectedCurrency: expected.currency,
    expectedCalculationStatus: expected.status,
    expectedCalculationReason: expected.reason ?? null,
    expectedBasis: expected.basis ?? null,
    ...comparison,
    candidateRuleIds: [selected.rule?.id].filter(Boolean),
    reviewReasons: [],
  };
}

function firstDefined(...values) {
  return values.find((value) => value != null && value !== "");
}

function objectMeta(record) {
  return record?.metadata && typeof record.metadata === "object" ? record.metadata : {};
}

/**
 * Build canonical matcher facts from Order/Conversion/OrderItem/Click records.
 * Callers may override any fact explicitly. No missing fact is manufactured.
 */
export function buildSupplierCommissionMatchFacts({
  order = null,
  conversion = null,
  item = null,
  click = null,
  overrides = {},
} = {}) {
  const orderMeta = objectMeta(order);
  const conversionMeta = objectMeta(conversion);
  const itemMeta = objectMeta(item);
  const clickMeta = objectMeta(click);

  let quantity = firstDefined(overrides.quantity, item?.quantity);
  if (quantity == null && Array.isArray(order?.items) && order.items.length) {
    const quantities = order.items.map((row) => asNumber(row?.quantity));
    if (quantities.every((value) => value != null)) {
      quantity = quantities.reduce((sum, value) => sum + value, 0);
    }
  }

  const orderValue = firstDefined(
    overrides.orderValue,
    order?.orderValue,
    conversionMeta.orderValue,
    conversionMeta.order_value,
    conversionMeta.saleAmount,
    conversionMeta.sales_amount,
    conversionMeta.revenue,
  );

  return {
    country: firstDefined(
      overrides.country,
      click?.country,
      orderMeta.country,
      conversionMeta.country,
      itemMeta.country,
    ),
    region: firstDefined(overrides.region, orderMeta.region, conversionMeta.region, itemMeta.region),
    category: firstDefined(overrides.category, item?.category, itemMeta.category, orderMeta.category, conversionMeta.category),
    product: firstDefined(overrides.product, item?.productName, itemMeta.product, conversionMeta.product),
    productId: firstDefined(overrides.productId, item?.productId, itemMeta.productId, conversionMeta.productId),
    sku: firstDefined(overrides.sku, item?.sku, itemMeta.sku, conversionMeta.sku),
    customerType: firstDefined(
      overrides.customerType,
      orderMeta.customerType,
      orderMeta.customer_type,
      conversionMeta.customerType,
      conversionMeta.customer_type,
    ),
    coupon: firstDefined(
      overrides.coupon,
      orderMeta.coupon,
      orderMeta.couponCode,
      orderMeta.promoCode,
      conversionMeta.coupon,
      conversionMeta.couponCode,
      conversionMeta.promoCode,
    ),
    voucher: firstDefined(overrides.voucher, orderMeta.voucher, conversionMeta.voucher),
    orderValue,
    commissionableValue: firstDefined(
      overrides.commissionableValue,
      item?.itemValue,
      itemMeta.commissionableValue,
      orderMeta.commissionableValue,
      conversionMeta.commissionableValue,
      orderValue,
    ),
    quantity,
    actionType: firstDefined(
      overrides.actionType,
      conversionMeta.actionType,
      conversionMeta.action_type,
      conversionMeta.action,
      orderMeta.actionType,
    ),
    device: firstDefined(overrides.device, click?.device, clickMeta.device, conversionMeta.device),
    date: firstDefined(overrides.date, order?.orderDate, conversion?.conversionDate),
    publisher: firstDefined(overrides.publisher, conversionMeta.publisher, orderMeta.publisher),
    publisherGroup: firstDefined(
      overrides.publisherGroup,
      conversionMeta.publisherGroup,
      conversionMeta.publisher_group,
      orderMeta.publisherGroup,
    ),
    trafficType: firstDefined(
      overrides.trafficType,
      conversionMeta.trafficType,
      conversionMeta.traffic_type,
      orderMeta.trafficType,
    ),
    performanceThreshold: firstDefined(
      overrides.performanceThreshold,
      conversionMeta.performanceThreshold,
      conversionMeta.performance_threshold,
    ),
    commissionTier: firstDefined(
      overrides.commissionTier,
      conversionMeta.commissionTier,
      conversionMeta.commission_tier,
      conversionMeta.tier,
    ),
    currency: firstDefined(overrides.currency, order?.currency, conversion?.currency, item?.currency),
    clicks: firstDefined(overrides.clicks, conversionMeta.clicks, orderMeta.clicks),
    impressions: firstDefined(overrides.impressions, conversionMeta.impressions, orderMeta.impressions),
    customFields: overrides.customFields ?? {},
    actualCurrency: firstDefined(overrides.actualCurrency, conversion?.currency, order?.currency),
  };
}
