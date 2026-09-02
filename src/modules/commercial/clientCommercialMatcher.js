/**
 * Client Commercial Runtime — deterministic client-rule selection.
 *
 * Supplier commission matching and client commercial matching are separate stages.
 * This module selects the applicable client rule only after attribution is resolved.
 * It is intentionally pure; persistence/loading remains in the commercial repository.
 */

const SET_LIKE_DIMENSIONS = new Set([
  "COUNTRY",
  "REGION",
  "CATEGORY",
  "PRODUCT",
  "SKU",
  "CUSTOMER_TYPE",
  "COUPON",
  "ACTION_TYPE",
  "CAMPAIGN",
  "TRAFFIC_TYPE",
]);

const FORBIDDEN_CLIENT_EARNINGS_BASES = new Set([
  "AVG_COMMISSION",
  "MIN_COMMISSION",
  "MAX_COMMISSION",
  "CAMPAIGN_COMMISSION_SUMMARY",
  "COMMISSIONAVERAGEDISPLAY",
  "COMMISSIONDISPLAY",
]);

function normalize(value) {
  if (value == null) return null;
  return String(value).trim().toUpperCase();
}

function normalizeDimension(value) {
  return normalize(value)?.replace(/[\s/-]+/g, "_") ?? null;
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asDate(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toArray(value) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap((item) => toArray(item));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.flatMap((item) => toArray(item));
      } catch {
        // Preserve an invalid JSON-looking string as source evidence; do not guess.
      }
    }
    return [trimmed];
  }
  return [value];
}

function comparableEqual(left, right) {
  const leftNumber = asNumber(left);
  const rightNumber = asNumber(right);
  if (leftNumber != null && rightNumber != null) return leftNumber === rightNumber;
  return normalize(left) === normalize(right);
}

function conditionValues(condition = {}) {
  const source = condition.normalizedValue ?? condition.normalized_value ?? condition.value;
  return toArray(source);
}

function conditionDimension(condition = {}) {
  const raw = condition.conditionType ?? condition.condition_type ?? condition.dimension ?? condition.type;
  const dimension = normalizeDimension(raw);
  if (dimension === "ACTION") return "ACTION_TYPE";
  if (dimension === "CUSTOM") return "CUSTOM_FIELD";
  return dimension || "CUSTOM_FIELD";
}

function factValueForCondition(condition = {}, facts = {}) {
  const dimension = conditionDimension(condition);
  const map = {
    COUNTRY: "country",
    REGION: "region",
    CATEGORY: "category",
    PRODUCT: "product",
    SKU: "sku",
    CUSTOMER_TYPE: "customerType",
    COUPON: "coupon",
    ORDER_VALUE: "orderValue",
    QUANTITY: "quantity",
    ACTION_TYPE: "actionType",
    CAMPAIGN: "campaign",
    DATE: "date",
    TRAFFIC_TYPE: "trafficType",
  };

  if (dimension === "DEFAULT") return true;
  if (dimension === "CUSTOM_FIELD") {
    const key = condition.field ?? condition.key ?? condition.sourceConditionType ?? condition.source_condition_type;
    if (!key || !facts.customFields || typeof facts.customFields !== "object") return undefined;
    return facts.customFields[key];
  }

  const factKey = map[dimension];
  return factKey ? facts[factKey] : undefined;
}

function compareScalar(actual, expected, operator) {
  if (operator === "GT") return actual > expected;
  if (operator === "GTE") return actual >= expected;
  if (operator === "LT") return actual < expected;
  if (operator === "LTE") return actual <= expected;
  return false;
}

/**
 * @returns {{state:"MATCH"|"NO_MATCH"|"UNKNOWN", reason?:string}}
 */
export function evaluateClientCommercialCondition(condition = {}, facts = {}) {
  const dimension = conditionDimension(condition);
  if (dimension === "DEFAULT") return { state: "MATCH" };

  const operator = normalize(condition.operator || "EQ") || "EQ";
  const actual = factValueForCondition(condition, facts);

  if (operator === "EXISTS") {
    return actual == null || actual === "" ? { state: "NO_MATCH" } : { state: "MATCH" };
  }
  if (operator === "NOT_EXISTS") {
    return actual == null || actual === "" ? { state: "MATCH" } : { state: "NO_MATCH" };
  }

  if (actual == null || actual === "") {
    return { state: "UNKNOWN", reason: `missing_fact:${dimension}` };
  }

  const expectedValues = conditionValues(condition);
  if (!expectedValues.length) {
    return { state: "UNKNOWN", reason: `missing_condition_value:${dimension}` };
  }
  const actualValues = toArray(actual);
  const anyEqual = () =>
    actualValues.some((actualValue) =>
      expectedValues.some((expectedValue) => comparableEqual(actualValue, expectedValue)),
    );

  if (operator === "EQ" || operator === "IN") {
    return anyEqual() ? { state: "MATCH" } : { state: "NO_MATCH" };
  }
  if (operator === "NEQ" || operator === "NOT_IN") {
    return anyEqual() ? { state: "NO_MATCH" } : { state: "MATCH" };
  }
  if (operator === "CONTAINS") {
    const matched = actualValues.some((actualValue) =>
      expectedValues.some((expectedValue) =>
        normalize(actualValue)?.includes(normalize(expectedValue)),
      ),
    );
    return matched ? { state: "MATCH" } : { state: "NO_MATCH" };
  }
  if (operator === "STARTS_WITH") {
    const matched = actualValues.some((actualValue) =>
      expectedValues.some((expectedValue) =>
        normalize(actualValue)?.startsWith(normalize(expectedValue)),
      ),
    );
    return matched ? { state: "MATCH" } : { state: "NO_MATCH" };
  }

  if (dimension === "DATE" && ["GT", "GTE", "LT", "LTE"].includes(operator)) {
    const actualDate = asDate(actualValues[0]);
    const expectedDate = asDate(expectedValues[0]);
    if (!actualDate || !expectedDate) {
      return { state: "UNKNOWN", reason: "invalid_date_comparison:DATE" };
    }
    return {
      state: compareScalar(actualDate.getTime(), expectedDate.getTime(), operator)
        ? "MATCH"
        : "NO_MATCH",
    };
  }

  if (dimension === "DATE" && operator === "BETWEEN") {
    const actualDate = asDate(actualValues[0]);
    const minDate = asDate(expectedValues[0]);
    const maxDate = asDate(expectedValues[1]);
    if (!actualDate || !minDate || !maxDate) {
      return { state: "UNKNOWN", reason: "invalid_between:DATE" };
    }
    const time = actualDate.getTime();
    return {
      state:
        time >= minDate.getTime() && time <= maxDate.getTime() ? "MATCH" : "NO_MATCH",
    };
  }

  if (["GT", "GTE", "LT", "LTE"].includes(operator)) {
    const actualNumber = asNumber(actualValues[0]);
    const expectedNumber = asNumber(expectedValues[0]);
    if (actualNumber == null || expectedNumber == null) {
      return { state: "UNKNOWN", reason: `non_numeric_comparison:${dimension}` };
    }
    return {
      state: compareScalar(actualNumber, expectedNumber, operator) ? "MATCH" : "NO_MATCH",
    };
  }

  if (operator === "BETWEEN") {
    const actualNumber = asNumber(actualValues[0]);
    const min = asNumber(expectedValues[0]);
    const max = asNumber(expectedValues[1]);
    if (actualNumber == null || min == null || max == null) {
      return { state: "UNKNOWN", reason: `invalid_between:${dimension}` };
    }
    return { state: actualNumber >= min && actualNumber <= max ? "MATCH" : "NO_MATCH" };
  }

  return { state: "UNKNOWN", reason: `unsupported_operator:${operator}` };
}

function groupKey(condition = {}) {
  const dimension = conditionDimension(condition);
  if (dimension !== "CUSTOM_FIELD") return dimension;
  return `${dimension}:${condition.field ?? condition.key ?? condition.sourceConditionType ?? "UNKNOWN"}`;
}

function evaluateConditionGroup(conditions, facts) {
  const dimension = conditionDimension(conditions[0]);
  const operators = new Set(conditions.map((condition) => normalize(condition.operator || "EQ")));
  const alternatives =
    SET_LIKE_DIMENSIONS.has(dimension) &&
    [...operators].every((operator) => operator === "EQ" || operator === "IN");
  const evaluations = conditions.map((condition) =>
    evaluateClientCommercialCondition(condition, facts),
  );

  if (alternatives) {
    if (evaluations.some((evaluation) => evaluation.state === "MATCH")) return { state: "MATCH" };
    const unknown = evaluations.find((evaluation) => evaluation.state === "UNKNOWN");
    if (unknown) return unknown;
    return { state: "NO_MATCH" };
  }

  if (evaluations.some((evaluation) => evaluation.state === "NO_MATCH")) {
    return { state: "NO_MATCH" };
  }
  return evaluations.find((evaluation) => evaluation.state === "UNKNOWN") || { state: "MATCH" };
}

function ruleCalculationBasis(rule = {}) {
  return normalizeDimension(
    rule.calculationBasis ?? rule.calculation_basis ?? rule.payoutBasis ?? rule.payout_basis,
  );
}

function ruleHasForbiddenSummaryBasis(rule = {}) {
  const basis = ruleCalculationBasis(rule);
  return basis ? FORBIDDEN_CLIENT_EARNINGS_BASES.has(basis) : false;
}

export function evaluateClientCommercialRule(rule = {}, facts = {}) {
  if (ruleHasForbiddenSummaryBasis(rule)) {
    return {
      state: "UNKNOWN",
      specificity: 0,
      isDefault: false,
      reasons: [`forbidden_client_earnings_basis:${ruleCalculationBasis(rule)}`],
    };
  }

  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  const nonDefault = conditions.filter((condition) => conditionDimension(condition) !== "DEFAULT");
  if (!nonDefault.length) {
    return { state: "MATCH", specificity: 0, isDefault: true, reasons: [] };
  }

  const groups = new Map();
  for (const condition of nonDefault) {
    const key = groupKey(condition);
    const list = groups.get(key) || [];
    list.push(condition);
    groups.set(key, list);
  }

  const reasons = [];
  let unknown = false;
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
      unknown = true;
      if (result.reason) reasons.push(result.reason);
    }
  }

  return {
    state: unknown ? "UNKNOWN" : "MATCH",
    specificity: groups.size,
    isDefault: false,
    reasons,
  };
}

function classifyRuleWindow(rule = {}, at = new Date()) {
  const now = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(now.getTime())) return { state: "REVIEW_REQUIRED", reason: "invalid_match_date" };

  if (rule.status && normalize(rule.status) !== "EFFECTIVE") {
    return { state: "INACTIVE", reason: "rule_not_effective" };
  }

  const fromRaw = rule.effectiveFrom ?? rule.effective_from;
  const untilRaw = rule.effectiveUntil ?? rule.effective_until;
  const from = fromRaw ? asDate(fromRaw) : null;
  const until = untilRaw ? asDate(untilRaw) : null;
  if ((fromRaw && !from) || (untilRaw && !until)) {
    return { state: "REVIEW_REQUIRED", reason: "invalid_effective_window" };
  }
  if (from && until && until.getTime() <= from.getTime()) {
    return { state: "REVIEW_REQUIRED", reason: "invalid_effective_window" };
  }
  if (from && from.getTime() > now.getTime()) return { state: "INACTIVE", reason: "future_rule" };
  if (until && until.getTime() <= now.getTime()) return { state: "INACTIVE", reason: "expired_rule" };
  return { state: "ACTIVE" };
}

function verifiedPriority(rule = {}) {
  const metadata = rule.metadata && typeof rule.metadata === "object" ? rule.metadata : {};
  const verified =
    metadata.clientPrecedenceVerified === true ||
    metadata.precedenceVerified === true ||
    rule.priorityVerified === true;
  if (!verified) return null;

  const priority = asNumber(rule.priority ?? metadata.priority);
  if (priority == null) return null;
  const direction = normalize(metadata.precedenceDirection ?? rule.precedenceDirection ?? "LOWER_FIRST");
  if (direction !== "LOWER_FIRST" && direction !== "HIGHER_FIRST") return null;
  return {
    direction,
    score: direction === "LOWER_FIRST" ? -priority : priority,
  };
}

function chooseByVerifiedPriority(candidates) {
  if (candidates.length < 2) return candidates[0] || null;
  const resolved = candidates.map((candidate) => ({
    candidate,
    precedence: verifiedPriority(candidate.rule),
  }));
  if (resolved.some((item) => !item.precedence)) return null;
  if (new Set(resolved.map((item) => item.precedence.direction)).size > 1) return null;
  const bestScore = Math.max(...resolved.map((item) => item.precedence.score));
  const winners = resolved.filter((item) => item.precedence.score === bestScore);
  return winners.length === 1 ? winners[0].candidate : null;
}

function chooseBySpecificity(candidates) {
  if (!candidates.length) return null;
  const max = Math.max(...candidates.map((candidate) => candidate.evaluation.specificity));
  const winners = candidates.filter((candidate) => candidate.evaluation.specificity === max);
  return winners.length === 1 ? winners[0] : null;
}

function reviewResult(reason, candidates = [], reviewReasons = []) {
  return {
    status: "REVIEW_REQUIRED",
    reason,
    matchedRule: null,
    matchedClientCommissionRuleId: null,
    candidateRuleIds: candidates.map((candidate) => candidate.rule?.id).filter(Boolean),
    reviewReasons: [...new Set(reviewReasons.filter(Boolean))],
  };
}

/**
 * Select one active/effective client commercial rule for an attributed assignment.
 * effectiveFrom is inclusive and effectiveUntil is exclusive.
 */
export function matchClientCommercialRule({
  rules = [],
  facts = {},
  attributionResolved = false,
  attributionStatus = null,
  assignmentId = null,
  at = facts.date ?? new Date(),
} = {}) {
  const attribution = normalize(attributionStatus);
  if (!attributionResolved || ["REVIEW_REQUIRED", "UNRESOLVED", "AMBIGUOUS", "NO_MATCH"].includes(attribution)) {
    return reviewResult("attribution_unresolved");
  }

  const scoped = (Array.isArray(rules) ? rules : []).filter((rule) => {
    if (!assignmentId) return true;
    return !rule.assignmentId || String(rule.assignmentId) === String(assignmentId);
  });

  const active = [];
  const invalidWindows = [];
  for (const rule of scoped) {
    const window = classifyRuleWindow(rule, at);
    if (window.state === "ACTIVE") active.push(rule);
    if (window.state === "REVIEW_REQUIRED") invalidWindows.push({ rule, reason: window.reason });
  }
  if (invalidWindows.length) {
    return reviewResult(
      "invalid_client_rule_window",
      invalidWindows.map((item) => ({ rule: item.rule })),
      invalidWindows.map((item) => item.reason),
    );
  }

  const evaluated = active.map((rule) => ({
    rule,
    evaluation: evaluateClientCommercialRule(rule, facts),
  }));
  const specificMatches = evaluated.filter(
    (candidate) => !candidate.evaluation.isDefault && candidate.evaluation.state === "MATCH",
  );
  const specificUnknown = evaluated.filter(
    (candidate) => !candidate.evaluation.isDefault && candidate.evaluation.state === "UNKNOWN",
  );
  const defaults = evaluated.filter(
    (candidate) => candidate.evaluation.isDefault && candidate.evaluation.state === "MATCH",
  );

  if (specificUnknown.length) {
    return reviewResult(
      "specific_client_rule_missing_or_unverified_facts",
      specificUnknown,
      specificUnknown.flatMap((candidate) => candidate.evaluation.reasons),
    );
  }

  let selected = null;
  if (specificMatches.length) {
    selected = chooseByVerifiedPriority(specificMatches) || chooseBySpecificity(specificMatches);
    if (!selected) {
      return reviewResult("ambiguous_client_commercial_rules", specificMatches);
    }
  } else if (defaults.length === 1) {
    selected = defaults[0];
  } else if (defaults.length > 1) {
    selected = chooseByVerifiedPriority(defaults);
    if (!selected) return reviewResult("ambiguous_default_client_rules", defaults);
  }

  if (!selected) {
    return {
      status: "NO_MATCH",
      reason: "no_client_commercial_rule_matched",
      matchedRule: null,
      matchedClientCommissionRuleId: null,
      candidateRuleIds: [],
      reviewReasons: [],
    };
  }

  return {
    status: "MATCHED",
    reason: selected.evaluation.isDefault ? "default_rule" : "specific_rule",
    matchedRule: selected.rule,
    matchedClientCommissionRuleId: selected.rule?.id ?? null,
    specificity: selected.evaluation.specificity,
    candidateRuleIds: [selected.rule?.id].filter(Boolean),
    reviewReasons: [],
  };
}

function firstDefined(...values) {
  return values.find((value) => value != null && value !== "");
}

function metadata(record) {
  return record?.metadata && typeof record.metadata === "object" ? record.metadata : {};
}

/** Build only evidenced transaction facts; never manufacture missing commercial facts. */
export function buildClientCommercialFacts({
  order = null,
  conversion = null,
  item = null,
  assignment = null,
  campaign = null,
  overrides = {},
} = {}) {
  const orderMeta = metadata(order);
  const conversionMeta = metadata(conversion);
  const itemMeta = metadata(item);
  const assignmentMeta = metadata(assignment);
  const campaignMeta = metadata(campaign);

  return {
    country: firstDefined(overrides.country, orderMeta.country, conversionMeta.country, itemMeta.country),
    region: firstDefined(overrides.region, orderMeta.region, conversionMeta.region, itemMeta.region),
    category: firstDefined(
      overrides.category,
      item?.category,
      itemMeta.category,
      campaign?.category,
      campaignMeta.category,
      orderMeta.category,
      conversionMeta.category,
    ),
    product: firstDefined(
      overrides.product,
      item?.productName,
      itemMeta.product,
      conversionMeta.product,
      orderMeta.product,
    ),
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
      conversionMeta.coupon,
      conversionMeta.couponCode,
    ),
    orderValue: firstDefined(
      overrides.orderValue,
      order?.orderValue,
      conversionMeta.orderValue,
      conversionMeta.order_value,
      conversionMeta.saleAmount,
      conversionMeta.sales_amount,
    ),
    quantity: firstDefined(overrides.quantity, item?.quantity, itemMeta.quantity, orderMeta.quantity),
    actionType: firstDefined(
      overrides.actionType,
      conversionMeta.actionType,
      conversionMeta.action_type,
      conversionMeta.action,
      orderMeta.actionType,
    ),
    campaign: firstDefined(
      overrides.campaign,
      assignment?.canonicalCampaignId,
      campaign?.id,
      campaign?.displayName,
      assignmentMeta.campaign,
    ),
    date: firstDefined(overrides.date, order?.orderDate, conversion?.conversionDate),
    trafficType: firstDefined(
      overrides.trafficType,
      conversionMeta.trafficType,
      conversionMeta.traffic_type,
      orderMeta.trafficType,
    ),
    customFields: overrides.customFields ?? {},
  };
}
