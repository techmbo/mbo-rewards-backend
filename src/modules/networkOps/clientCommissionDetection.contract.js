/**
 * Pointer 43 — Client commission detection and calculation.
 * Supplier commission detection and Client Commercial Rule matching are separate stages.
 */
import { FIELD_MAPPING_OUTCOME } from "../mapping/mappingOutcome.contract.js";
import { ATTRIBUTION_UNRESOLVED_STATUSES } from "./commercialCalculationSequencing.contract.js";
import { DISPLAY_ONLY_SUMMARY_FIELDS } from "./campaignCommissionSummary.contract.js";

export const CONTRACT_POINTER = 43;

export const CLIENT_COMMISSION_DETECTION_SUMMARY = Object.freeze({
  separateStages:
    "Supplier commission detection and Client Commercial Rule matching are separate stages.",
  attributionGate:
    "Never select a client commercial rule before client attribution is resolved.",
  noCampaignSummary:
    "Never use Avg Commission, Min Commission, Max Commission or campaign commission summary to calculate client earnings.",
  networkActualBase:
    "If the network reports actual commission, use the network actual commission as the base financial fact unless the approved client commercial contract explicitly defines another calculation basis.",
  provisionalRule:
    "If actual commission is not yet available but provisional calculations are allowed by an approved MBO rule, mark the result clearly as provisional and do not make it payable until the required financial evidence is available.",
  adapterBoundary:
    "The adapter must never calculate Client Commission or MBO Margin. Those belong to the MBO commercial engine after attribution and client assignment.",
});

/** Required client commission calculation sequence. */
export const CLIENT_COMMISSION_CALCULATION_SEQUENCE = Object.freeze([
  { rank: 1, key: "conversion_order", label: "Conversion/Order" },
  { rank: 2, key: "client_attribution", label: "Client Attribution" },
  { rank: 3, key: "client_campaign_assignment", label: "Client Campaign Assignment" },
  { rank: 4, key: "matched_supplier_commission_rule", label: "Matched Supplier Commission Rule" },
  { rank: 5, key: "network_actual_commission", label: "Network Actual Commission" },
  { rank: 6, key: "client_commercial_rule", label: "Applicable Client Commercial Rule" },
  { rank: 7, key: "client_commission", label: "Client Commission" },
  { rank: 8, key: "mbo_commission_margin", label: "MBO Commission/Margin" },
]);

export const CLIENT_COMMERCIAL_CONDITION_DIMENSIONS = Object.freeze([
  "COUNTRY",
  "CATEGORY",
  "CUSTOMER_TYPE",
  "PRODUCT",
  "COUPON",
  "ACTION",
  "TIER",
  "CUSTOM",
]);

export const CLIENT_RULE_SELECTION_PRECEDENCE = Object.freeze([
  {
    rank: 1,
    key: "complete_condition_set",
    rule: "All client commercial rule conditions must match.",
  },
  {
    rank: 2,
    key: "source_priority_rank",
    rule: "Prefer explicit priority/rank when the source provides a defined precedence mechanism.",
  },
  {
    rank: 3,
    key: "most_specific_rule",
    rule: "Otherwise prefer the most specific valid rule over a broader default rule.",
  },
  {
    rank: 4,
    key: "review_required_on_tie",
    rule: "Ambiguous ties become REVIEW_REQUIRED. Do not guess.",
  },
]);

export const FORBIDDEN_CLIENT_EARNINGS_BASES = Object.freeze([
  ...DISPLAY_ONLY_SUMMARY_FIELDS,
  "avg_commission",
  "min_commission",
  "max_commission",
  "campaign_commission_summary",
]);

export class ClientCommissionDetectionError extends Error {
  constructor(message, { code = "CLIENT_COMMISSION_DETECTION_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "ClientCommissionDetectionError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundMoney(value) {
  if (value == null) return null;
  return Number(Number(value).toFixed(4));
}

function normalizeDimension(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s/-]+/g, "_");
}

function ruleIdFrom(rule = {}) {
  return rule.id ?? rule.clientCommercialRuleId ?? rule.client_commercial_rule_id ?? null;
}

function conditionSpecificity(conditions = []) {
  return conditions.filter((condition) => normalizeDimension(condition.condition_type ?? condition.conditionType) !== "DEFAULT").length;
}

function isDefaultRule(conditions = []) {
  return conditions.some((condition) => normalizeDimension(condition.condition_type ?? condition.conditionType) === "DEFAULT");
}

function evaluateClientCondition(condition = {}, orderFacts = {}) {
  const dimension = normalizeDimension(condition.condition_type ?? condition.conditionType);
  if (dimension === "DEFAULT") return true;

  const factMap = {
    COUNTRY: "country",
    CATEGORY: "category",
    CUSTOMER_TYPE: "customerType",
    PRODUCT: "product",
    COUPON: "coupon",
    ACTION: "actionType",
    TIER: "tier",
  };
  const factKey = factMap[dimension];
  if (!factKey) return Boolean(condition.normalized_value == null);

  const evidence = orderFacts._evidence ?? orderFacts.evidence ?? {};
  if (evidence[factKey] === false) return false;

  const actual = orderFacts[factKey];
  const expected = condition.normalized_value ?? condition.normalizedValue;
  if (actual == null || actual === "") return false;
  return String(actual).trim().toUpperCase() === String(expected).trim().toUpperCase();
}

export function clientRuleMatchesOrder({ conditions = [], orderFacts = {} } = {}) {
  const list = Array.isArray(conditions) ? conditions : [];
  if (!list.length) return isDefaultRule(list);
  return list.every((condition) => evaluateClientCondition(condition, orderFacts));
}

/**
 * Assert client commercial rule is not selected before attribution is resolved.
 */
export function assertAttributionBeforeClientRule({
  attributionResolved = false,
  attributionStatus = null,
  clientRuleSelected = false,
} = {}) {
  const status = String(attributionStatus || "").toUpperCase();
  const unresolved =
    !attributionResolved ||
    ATTRIBUTION_UNRESOLVED_STATUSES.includes(status) ||
    status === "REVIEW_REQUIRED";

  if (clientRuleSelected && unresolved) {
    throw new ClientCommissionDetectionError(
      "Never select a client commercial rule before client attribution is resolved.",
      {
        code: "CLIENT_RULE_BEFORE_ATTRIBUTION",
        details: { attributionResolved, attributionStatus: status, clientRuleSelected },
      },
    );
  }

  return true;
}

/**
 * Assert campaign summary fields are not used for client earnings calculation.
 */
export function assertNoCampaignSummaryForClientEarnings({
  calculationBasis = null,
} = {}) {
  const basis = String(calculationBasis || "").trim();
  if (FORBIDDEN_CLIENT_EARNINGS_BASES.includes(basis)) {
    throw new ClientCommissionDetectionError(
      "Never use Avg Commission, Min Commission, Max Commission or campaign commission summary to calculate client earnings.",
      {
        code: "CAMPAIGN_SUMMARY_USED_FOR_CLIENT_EARNINGS",
        details: { calculationBasis: basis },
      },
    );
  }
  return true;
}

/**
 * Assert network adapters do not calculate client commission or MBO margin.
 */
export function assertAdapterDoesNotCalculateClientCommission({
  inAdapter = false,
  clientCommissionCalculated = false,
  mboMarginCalculated = false,
} = {}) {
  if (inAdapter && (clientCommissionCalculated || mboMarginCalculated)) {
    throw new ClientCommissionDetectionError(
      "The adapter must never calculate Client Commission or MBO Margin.",
      {
        code: "CLIENT_COMMISSION_IN_ADAPTER",
        details: { inAdapter, clientCommissionCalculated, mboMarginCalculated },
      },
    );
  }
  return true;
}

/**
 * Resolve calculation basis — network actual unless approved alternate basis exists.
 */
export function resolveCalculationBasis({
  networkActualCommission = null,
  expectedSupplierCommission = null,
  approvedAlternateBasis = null,
} = {}) {
  if (approvedAlternateBasis) {
    return {
      basis: approvedAlternateBasis,
      baseAmount: asNumber(expectedSupplierCommission),
      source: "approved_contract_basis",
    };
  }
  if (networkActualCommission != null) {
    return {
      basis: "network_actual_commission",
      baseAmount: asNumber(networkActualCommission),
      source: "network_actual_commission",
    };
  }
  return {
    basis: null,
    baseAmount: null,
    source: null,
  };
}

export function calculateClientCommission({
  baseCommission = null,
  clientSharePercent = null,
  provisional = false,
  payableWithoutEvidence = false,
} = {}) {
  const base = asNumber(baseCommission);
  const share = asNumber(clientSharePercent);
  if (base == null || share == null) {
    return {
      clientCommission: null,
      provisional,
      payable: false,
    };
  }

  const clientCommission = roundMoney((base * share) / 100);
  return {
    clientCommission,
    provisional,
    payable: !provisional && !payableWithoutEvidence && baseCommission != null,
  };
}

export function calculateMboMargin({
  networkActualCommission = null,
  clientCommission = null,
} = {}) {
  const actual = asNumber(networkActualCommission);
  const client = asNumber(clientCommission);
  if (actual == null || client == null) return null;
  return roundMoney(actual - client);
}

export function selectClientCommercialRule({
  rules = [],
  conditionsByRuleId = {},
  orderFacts = {},
} = {}) {
  const eligible = (Array.isArray(rules) ? rules : [])
    .map((rule) => {
      const ruleId = ruleIdFrom(rule);
      const conditions = conditionsByRuleId[ruleId] ?? rule.conditions ?? [];
      return {
        rule,
        ruleId,
        conditions,
        matches: clientRuleMatchesOrder({ conditions, orderFacts }),
        specificity: conditionSpecificity(conditions),
        isDefault: isDefaultRule(conditions),
        sourcePriority: rule.sourcePriority ?? rule.source_priority ?? null,
      };
    })
    .filter((entry) => entry.matches);

  if (!eligible.length) {
    return {
      status: "NO_MATCH",
      matchedClientCommercialRuleId: null,
      fieldMappingOutcome: FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED,
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
      matchedClientCommercialRuleId: null,
      fieldMappingOutcome: FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED,
      tiedRuleIds: [winner.ruleId, ...tied.map((entry) => entry.ruleId)],
    };
  }

  return {
    status: "MATCHED",
    matchedClientCommercialRuleId: winner.ruleId,
    selectedRule: winner.rule,
    fieldMappingOutcome: FIELD_MAPPING_OUTCOME.MAPPED,
    specificity: winner.specificity,
  };
}

/** Pointer exemplar — INR 1,150 actual, 70% client share. */
export const POINTER_43_EXAMPLE = Object.freeze({
  networkActualCommission: 1150,
  currency: "INR",
  clientSharePercent: 70,
  clientCommission: 805,
  mboCommissionMargin: 345,
});

/**
 * End-to-end client commission detection and calculation.
 */
export function detectAndCalculateClientCommission({
  attributionResolved = true,
  attributionStatus = "ATTRIBUTED",
  orderFacts = {},
  clientRules = [],
  conditionsByRuleId = {},
  networkActualCommission = POINTER_43_EXAMPLE.networkActualCommission,
  clientSharePercent = POINTER_43_EXAMPLE.clientSharePercent,
  approvedAlternateBasis = null,
  provisionalAllowed = false,
  inAdapter = false,
  calculationBasis = "network_actual_commission",
} = {}) {
  assertAdapterDoesNotCalculateClientCommission({ inAdapter, clientCommissionCalculated: false, mboMarginCalculated: false });
  assertNoCampaignSummaryForClientEarnings({ calculationBasis });

  const ruleSelection = selectClientCommercialRule({
    rules: clientRules,
    conditionsByRuleId,
    orderFacts,
  });

  assertAttributionBeforeClientRule({
    attributionResolved,
    attributionStatus,
    clientRuleSelected: ruleSelection.status === "MATCHED",
  });

  const basis = resolveCalculationBasis({
    networkActualCommission,
    approvedAlternateBasis,
  });

  const provisional = basis.baseAmount == null && provisionalAllowed;
  const clientCalc = calculateClientCommission({
    baseCommission: basis.baseAmount,
    clientSharePercent,
    provisional,
    payableWithoutEvidence: false,
  });
  const mboCommissionMargin = calculateMboMargin({
    networkActualCommission: basis.baseAmount,
    clientCommission: clientCalc.clientCommission,
  });

  return {
    sequenceCompleteThrough: "mbo_commission_margin",
    matchedClientCommercialRuleId: ruleSelection.matchedClientCommercialRuleId,
    ruleSelectionStatus: ruleSelection.status,
    calculationBasis: basis.basis,
    baseCommission: basis.baseAmount,
    clientSharePercent,
    clientCommission: clientCalc.clientCommission,
    mboCommissionMargin,
    provisional: clientCalc.provisional,
    payable: clientCalc.payable,
    currency: POINTER_43_EXAMPLE.currency,
  };
}

export function buildClientCommissionDetectionGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...CLIENT_COMMISSION_DETECTION_SUMMARY },
    calculationSequence: CLIENT_COMMISSION_CALCULATION_SEQUENCE.map((step) => ({ ...step })),
    commercialConditionDimensions: [...CLIENT_COMMERCIAL_CONDITION_DIMENSIONS],
    selectionPrecedence: CLIENT_RULE_SELECTION_PRECEDENCE.map((item) => ({ ...item })),
    forbiddenEarningsBases: [...FORBIDDEN_CLIENT_EARNINGS_BASES],
    example: Object.freeze({
      ...POINTER_43_EXAMPLE,
      result: detectAndCalculateClientCommission({
        clientRules: [{ id: "client-rule-70", clientSharePercent: 70 }],
        conditionsByRuleId: {
          "client-rule-70": [{ condition_type: "DEFAULT", normalized_value: null }],
        },
      }),
    }),
    runtimeRefs: Object.freeze({
      commercialCalculationSequencing: "networkOps/commercialCalculationSequencing.contract.js",
      commercialRuleEngine: "commercial/commercialRuleEngine.js",
      attributionService: "reporting/services/attribution.service.js",
      expectedVsActualSupplierCommission: "networkOps/expectedVsActualSupplierCommission.contract.js",
      financialTransactionService: "finance/financialTransaction.service.js",
    }),
    crossRefs: Object.freeze({
      pointer32CommercialSequencing: "Client commission follows supplier detection and network actual commission.",
      pointer40CampaignSummary: "Campaign averages remain display-only.",
      pointer42ExpectedVsActual: "Network actual commission is the default financial base fact.",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      network: family,
      sourceObject: obj,
      commercialRuleEngine: "commercial/commercialRuleEngine.js",
      attributionService: "reporting/services/attribution.service.js",
    });
  }

  return guide;
}

export function applyClientCommissionDetectionContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    clientCommissionDetectionPointer: CONTRACT_POINTER,
    clientCommissionDetectionNetwork: network || null,
    clientCommissionDetectionSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
