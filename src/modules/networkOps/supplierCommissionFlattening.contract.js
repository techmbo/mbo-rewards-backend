/**
 * Pointer 38 — Supplier commission flattening and Commission 1...N display.
 * Preserve source commission structures; display every distinct payable outcome separately.
 */

export const CONTRACT_POINTER = 38;

export const SUPPLIER_COMMISSION_FLATTENING_SUMMARY = Object.freeze({
  preserveSourceStructure:
    "Whatever commission structure a network returns must be preserved, but MBO Network Operations must display every distinct payable commission outcome separately.",
  noHiddenRates:
    "MBO must not hide individual payable rates inside source groups — regardless of whether the network calls them Commission Group, Payout Group, Offer Rule, Tariff, Tier, Action Term, Rate or another name.",
  displaySequenceRule:
    "For each campaign, assign an MBO display sequence: Commission 1, Commission 2, Commission 3, ... Commission N. The sequence is for Operations readability only.",
  canonicalIdentifier:
    "The true identifier is mbo_commission_rule_id. Do not create fixed database columns commission_1, commission_2, etc.",
  unlimitedRules:
    "A campaign must support an unlimited number of SupplierCommissionRule records.",
  oneOutcomeOneRecord:
    "One distinct percentage, fixed payout, tier rate or conditional payout outcome = one SupplierCommissionRule record.",
  lineageRule:
    "Preserve source_group_id, source_group_name, source_rule_id, source_rule_name and raw source rule as lineage metadata, but do not require grouped presentation in the Operations UI.",
});

/** Network labels for grouped commission structures — all flatten to individual rules. */
export const NETWORK_SOURCE_GROUP_LABELS = Object.freeze([
  "Commission Group",
  "Payout Group",
  "Offer Rule",
  "Tariff",
  "Tier",
  "Action Term",
  "Rate",
]);

export const LINEAGE_METADATA_FIELDS = Object.freeze([
  "source_group_id",
  "source_group_name",
  "source_rule_id",
  "source_rule_name",
  "raw_source_rule",
]);

/** Forbidden fixed-column patterns — unlimited SupplierCommissionRule rows instead. */
export const FORBIDDEN_FIXED_COMMISSION_COLUMN_PATTERN = /^commission_\d+$/i;

export const CANONICAL_RULE_ID_FIELD = "mbo_commission_rule_id";

export const DISPLAY_LABEL_PREFIX = "Commission";

export class SupplierCommissionFlatteningError extends Error {
  constructor(message, { code = "SUPPLIER_COMMISSION_FLATTENING_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "SupplierCommissionFlatteningError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function asString(value) {
  if (value == null || value === "") return null;
  return String(value).trim() || null;
}

function formatCommissionValue(rule = {}) {
  const rate = rule.ratePercent ?? rule.rate_percent;
  if (rate != null && rate !== "") {
    const n = Number(rate);
    if (Number.isFinite(n)) return `${n}%`;
  }
  const fixed = rule.fixedAmount ?? rule.fixed_amount;
  if (fixed != null && fixed !== "") {
    const currency = asString(rule.currency);
    return currency ? `${currency} ${fixed}` : String(fixed);
  }
  return asString(rule.commissionValue ?? rule.commission_value);
}

function ruleOutcomeKey(rule = {}) {
  return [
    formatCommissionValue(rule),
    asString(rule.categoryProductGoal ?? rule.category_product_goal ?? rule.category),
    asString(rule.country),
    asString(rule.customerType ?? rule.customer_type),
    asString(rule.couponOrTier ?? rule.coupon_or_tier),
  ].join("|");
}

/**
 * Assert schema/UI does not use fixed commission_1..N columns.
 */
export function assertNoFixedCommissionColumns({ columnNames = [], schemaFields = [] } = {}) {
  const names = [...(Array.isArray(columnNames) ? columnNames : []), ...(Array.isArray(schemaFields) ? schemaFields : [])];
  const forbidden = names.filter((name) => FORBIDDEN_FIXED_COMMISSION_COLUMN_PATTERN.test(String(name || "")));

  if (forbidden.length) {
    throw new SupplierCommissionFlatteningError(
      "Do not create fixed database columns commission_1, commission_2, etc. Use unlimited SupplierCommissionRule records.",
      {
        code: "FIXED_COMMISSION_COLUMNS_FORBIDDEN",
        details: { forbidden },
      },
    );
  }

  return true;
}

/**
 * Assert one distinct payable outcome maps to one SupplierCommissionRule record.
 */
export function assertOneOutcomeOneRecord({ rules = [], mergedIntoGroup = false } = {}) {
  const list = Array.isArray(rules) ? rules : [];

  if (mergedIntoGroup) {
    throw new SupplierCommissionFlatteningError(
      "Do not hide individual payable rates inside source groups — one outcome per SupplierCommissionRule record.",
      {
        code: "RATES_HIDDEN_IN_SOURCE_GROUP",
        details: { ruleCount: list.length },
      },
    );
  }

  const seen = new Map();
  for (const rule of list) {
    const key = ruleOutcomeKey(rule);
    if (!key || key === "|||") continue;
    if (seen.has(key)) {
      throw new SupplierCommissionFlatteningError(
        "One distinct payable outcome must map to one SupplierCommissionRule record.",
        {
          code: "DUPLICATE_PAYABLE_OUTCOME",
          details: { key, ruleIds: [seen.get(key), rule.id ?? rule.mboCommissionRuleId] },
        },
      );
    }
    seen.set(key, rule.id ?? rule.mboCommissionRuleId ?? key);
  }

  return true;
}

/**
 * Assert source lineage metadata is preserved on flattened rules.
 */
export function assertLineageMetadataPreserved({ rule = null, requireRaw = false } = {}) {
  if (!rule || typeof rule !== "object") {
    throw new SupplierCommissionFlatteningError("SupplierCommissionRule lineage metadata is required.", {
      code: "LINEAGE_METADATA_MISSING",
      details: { rule },
    });
  }

  const metadata = rule.lineage ?? rule.metadata ?? rule;
  const hasRuleId = metadata.source_rule_id != null || metadata.sourceRuleId != null || rule.sourceRuleId != null;
  if (!hasRuleId) {
    throw new SupplierCommissionFlatteningError(
      "Preserve source_rule_id on flattened SupplierCommissionRule records.",
      {
        code: "SOURCE_RULE_ID_MISSING",
        details: { rule },
      },
    );
  }

  if (requireRaw && metadata.raw_source_rule == null && metadata.rawSourceRule == null && rule.rawSourceRule == null) {
    throw new SupplierCommissionFlatteningError("Preserve raw source rule as lineage metadata.", {
      code: "RAW_SOURCE_RULE_MISSING",
      details: { rule },
    });
  }

  return true;
}

/**
 * Format one Operations display line: "12% | Category Shoes | Country IN | Customer New"
 */
export function formatCommissionDisplayLabel(rule = {}, { sequence = null } = {}) {
  const parts = [];
  const value = formatCommissionValue(rule);
  if (value) parts.push(value);

  const category = asString(rule.categoryProductGoal ?? rule.category_product_goal ?? rule.category);
  if (category) parts.push(`Category ${category}`);

  const country = asString(rule.country);
  if (country) parts.push(`Country ${country}`);

  const customer = asString(rule.customerType ?? rule.customer_type);
  if (customer) parts.push(`Customer ${customer}`);

  const couponOrTier = asString(rule.couponOrTier ?? rule.coupon_or_tier);
  if (couponOrTier) parts.push(`Tier ${couponOrTier}`);

  const label = parts.join(" | ");
  if (sequence != null) {
    return `${DISPLAY_LABEL_PREFIX} ${sequence} = ${label}`;
  }
  return label;
}

/**
 * Assign Commission 1...N display sequence for Operations readability.
 * True identifier remains mbo_commission_rule_id on each rule.
 */
export function assignCommissionDisplaySequence(rules = []) {
  const list = Array.isArray(rules) ? [...rules] : [];
  return list.map((rule, index) => {
    const sequence = index + 1;
    const mboCommissionRuleId =
      rule.mboCommissionRuleId ??
      rule.mbo_commission_rule_id ??
      rule.id ??
      rule.sourceRuleId ??
      rule.source_rule_id ??
      null;

    return {
      ...rule,
      mboCommissionRuleId,
      mbo_commission_rule_id: mboCommissionRuleId,
      displaySequence: sequence,
      displayLabel: `${DISPLAY_LABEL_PREFIX} ${sequence}`,
      displayLine: formatCommissionDisplayLabel(rule, { sequence }),
      groupedPresentationRequired: false,
    };
  });
}

/** Pointer exemplar — Shoes/Accessories India customer-type rates. */
export const POINTER_38_EXAMPLE_RULES = Object.freeze([
  {
    ratePercent: 12,
    categoryProductGoal: "Shoes",
    country: "IN",
    customerType: "New",
    source_group_id: "grp-shoes-in",
    source_group_name: "Shoes India",
    source_rule_id: "rule-shoes-new",
    source_rule_name: "New Customer",
  },
  {
    ratePercent: 8,
    categoryProductGoal: "Shoes",
    country: "IN",
    customerType: "Existing",
    source_group_id: "grp-shoes-in",
    source_group_name: "Shoes India",
    source_rule_id: "rule-shoes-existing",
    source_rule_name: "Existing Customer",
  },
  {
    ratePercent: 6,
    categoryProductGoal: "Accessories",
    country: "IN",
    source_group_id: "grp-accessories-in",
    source_group_name: "Accessories India",
    source_rule_id: "rule-accessories",
    source_rule_name: "Accessories Default",
  },
]);

export function buildSupplierCommissionFlatteningGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...SUPPLIER_COMMISSION_FLATTENING_SUMMARY },
    networkSourceGroupLabels: [...NETWORK_SOURCE_GROUP_LABELS],
    lineageMetadataFields: [...LINEAGE_METADATA_FIELDS],
    canonicalRuleIdField: CANONICAL_RULE_ID_FIELD,
    displayLabelPrefix: DISPLAY_LABEL_PREFIX,
    example: Object.freeze({
      sourceRules: POINTER_38_EXAMPLE_RULES.map((rule) => ({ ...rule })),
      mboDisplay: assignCommissionDisplaySequence(POINTER_38_EXAMPLE_RULES).map((row) => row.displayLine),
    }),
    runtimeRefs: Object.freeze({
      supplierCommissionRuleContract: "commercial/supplierCommissionRule.contract.js",
      supplierCommissionRuleFanOut: "commercial/supplierCommissionRuleFanOut.js",
      campaignCommissions: "ops/campaignCommissions.js",
      prismaModel: "prisma/schema.prisma#SupplierCommissionRule",
    }),
    crossRefs: Object.freeze({
      pointer12SupplierCommissionRule: "One rule per advertised rate structure — not order payout truth.",
      pointer34InspectionLayer: "All Network Data shows flattened rules — not grouped source presentation.",
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
      mappingFile: `platform_backend/src/network-mappings/${family}/${obj}.mapping.json`,
    });
  }

  return guide;
}

export function applySupplierCommissionFlatteningContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    supplierCommissionFlatteningPointer: CONTRACT_POINTER,
    supplierCommissionFlatteningNetwork: network || null,
    supplierCommissionFlatteningSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
