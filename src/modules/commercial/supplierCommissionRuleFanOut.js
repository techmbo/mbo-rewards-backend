/**
 * Pointer 12 — explode embedded commission payloads into individual payable outcomes.
 *
 * MBO rule: every distinct supplier payout outcome becomes one SupplierCommissionRule.
 * Source rule/group IDs are lineage only and must not collapse multiple outcomes.
 */

import {
  collectSourceEntries,
  listCampaignCommissionFacts,
} from "../ops/campaignCommissions.js";

function campaignIdFromRaw(raw = {}) {
  return raw.id ?? raw.campaignId ?? raw.campaign_id ?? raw.CampaignId ?? raw.campaignID ?? raw.productId ?? raw.product_id ?? null;
}

function asString(value) {
  if (value == null || value === "") return null;
  return String(value).trim() || null;
}

function asNumber(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asValues(value) {
  if (value == null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(asString).filter(Boolean);
}

function pushCondition(list, conditionType, value, {
  operator = "EQ",
  sourceConditionType = null,
  sourceConditionValue = value,
  metadata = null,
} = {}) {
  for (const item of asValues(value)) {
    const key = `${conditionType}|${operator ?? ""}|${item}`;
    if (list.some((existing) => existing._key === key)) continue;
    list.push({
      _key: key,
      conditionType,
      operator,
      value: item,
      sourceConditionType,
      sourceConditionValue,
      metadata,
    });
  }
}

const SOURCE_CONDITION_TYPE_MAP = Object.freeze({
  category: "CATEGORY",
  product_category: "CATEGORY",
  product: "PRODUCT",
  product_id: "PRODUCT_ID",
  productid: "PRODUCT_ID",
  sku: "SKU",
  sku_list: "SKU_LIST",
  skus: "SKU_LIST",
  country: "COUNTRY",
  country_code: "COUNTRY",
  countries: "COUNTRY",
  region: "REGION",
  customer_type: "CUSTOMER_TYPE",
  customertype: "CUSTOMER_TYPE",
  audience: "CUSTOMER_TYPE",
  coupon: "COUPON",
  coupon_code: "COUPON",
  couponcode: "COUPON",
  voucher: "VOUCHER",
  voucher_code: "VOUCHER",
  order_value: "ORDER_VALUE",
  ordervalue: "ORDER_VALUE",
  quantity: "QUANTITY",
  action_type: "ACTION_TYPE",
  actiontype: "ACTION_TYPE",
  device: "DEVICE",
  date: "DATE",
  publisher: "PUBLISHER",
  publisher_group: "PUBLISHER_GROUP",
  traffic_type: "TRAFFIC_TYPE",
  performance_threshold: "PERFORMANCE_THRESHOLD",
  tier: "COMMISSION_TIER",
  commission_tier: "COMMISSION_TIER",
});

function normalizeConditionType(value) {
  const source = asString(value);
  if (!source) return "OTHER_SOURCE_CONDITION";
  const key = source.toLowerCase().replace(/[\s-]+/g, "_");
  return SOURCE_CONDITION_TYPE_MAP[key] ?? "OTHER_SOURCE_CONDITION";
}

/**
 * Public alias for network-specific mappers (e.g. Optimise commission groups) so
 * source condition structures normalize through one shared dimension map.
 */
export function conditionsFromSourceEntry(entry = {}) {
  return conditionsFromEntry(entry);
}

function conditionsFromEntry(entry = {}) {
  const conditions = [];

  // Deterministic canonical ordering for common dimensions.
  pushCondition(conditions, "CATEGORY", entry.category ?? entry.product_category, {
    sourceConditionType: entry.category != null ? "category" : "product_category",
  });
  pushCondition(conditions, "PRODUCT", entry.product, { sourceConditionType: "product" });
  pushCondition(conditions, "PRODUCT_ID", entry.product_id ?? entry.productId, {
    sourceConditionType: entry.product_id != null ? "product_id" : "productId",
  });
  pushCondition(conditions, "SKU", entry.sku, { sourceConditionType: "sku" });
  pushCondition(conditions, "SKU_LIST", entry.sku_list ?? entry.skus, {
    sourceConditionType: entry.sku_list != null ? "sku_list" : "skus",
  });

  const countries = [
    ...asValues(entry.country),
    ...asValues(entry.country_code),
    ...asValues(entry.countries),
  ];
  pushCondition(conditions, "COUNTRY", countries, {
    sourceConditionType: entry.countries != null
      ? "countries"
      : entry.country_code != null
        ? "country_code"
        : "country",
    sourceConditionValue: entry.countries ?? entry.country_code ?? entry.country ?? null,
  });

  pushCondition(conditions, "REGION", entry.region, { sourceConditionType: "region" });
  pushCondition(conditions, "CUSTOMER_TYPE", entry.customer_type ?? entry.customerType ?? entry.audience, {
    sourceConditionType: entry.customer_type != null
      ? "customer_type"
      : entry.customerType != null
        ? "customerType"
        : "audience",
  });
  pushCondition(conditions, "COUPON", entry.coupon ?? entry.coupon_code ?? entry.couponCode, {
    sourceConditionType: entry.coupon != null
      ? "coupon"
      : entry.coupon_code != null
        ? "coupon_code"
        : "couponCode",
  });
  pushCondition(conditions, "VOUCHER", entry.voucher ?? entry.voucher_code, {
    sourceConditionType: entry.voucher != null ? "voucher" : "voucher_code",
  });
  pushCondition(conditions, "ORDER_VALUE", entry.order_value ?? entry.orderValue, {
    sourceConditionType: entry.order_value != null ? "order_value" : "orderValue",
  });
  pushCondition(conditions, "QUANTITY", entry.quantity, { sourceConditionType: "quantity" });
  pushCondition(conditions, "ACTION_TYPE", entry.action_type ?? entry.actionType ?? entry.action, {
    sourceConditionType: entry.action_type != null
      ? "action_type"
      : entry.actionType != null
        ? "actionType"
        : "action",
  });
  pushCondition(conditions, "DEVICE", entry.device, { sourceConditionType: "device" });
  pushCondition(conditions, "PUBLISHER", entry.publisher, { sourceConditionType: "publisher" });
  pushCondition(conditions, "PUBLISHER_GROUP", entry.publisher_group ?? entry.publisherGroup, {
    sourceConditionType: entry.publisher_group != null ? "publisher_group" : "publisherGroup",
  });
  pushCondition(conditions, "TRAFFIC_TYPE", entry.traffic_type ?? entry.trafficType, {
    sourceConditionType: entry.traffic_type != null ? "traffic_type" : "trafficType",
  });
  pushCondition(conditions, "PERFORMANCE_THRESHOLD", entry.performance_threshold ?? entry.performanceThreshold, {
    sourceConditionType: entry.performance_threshold != null
      ? "performance_threshold"
      : "performanceThreshold",
  });
  pushCondition(conditions, "COMMISSION_TIER", entry.tier ?? entry.commission_tier, {
    sourceConditionType: entry.tier != null ? "tier" : "commission_tier",
  });

  // Preserve explicit network condition structures. Unknown dimensions are not discarded.
  const sourceConditions = entry.conditions ?? entry.condition ?? null;
  if (Array.isArray(sourceConditions)) {
    for (const sourceCondition of sourceConditions) {
      if (sourceCondition == null) continue;
      if (typeof sourceCondition !== "object") {
        pushCondition(conditions, "OTHER_SOURCE_CONDITION", sourceCondition, {
          sourceConditionType: "conditions",
          sourceConditionValue: sourceCondition,
        });
        continue;
      }
      const sourceType =
        sourceCondition.type ??
        sourceCondition.condition_type ??
        sourceCondition.name ??
        sourceCondition.field ??
        "conditions";
      const value =
        sourceCondition.value ??
        sourceCondition.values ??
        sourceCondition.condition_value ??
        sourceCondition.target ??
        null;
      pushCondition(conditions, normalizeConditionType(sourceType), value, {
        operator: asString(sourceCondition.operator ?? sourceCondition.op) ?? "EQ",
        sourceConditionType: asString(sourceType),
        sourceConditionValue: sourceCondition,
        metadata: { sourceCondition },
      });
    }
  } else if (sourceConditions && typeof sourceConditions === "object") {
    for (const [sourceType, value] of Object.entries(sourceConditions)) {
      pushCondition(conditions, normalizeConditionType(sourceType), value, {
        sourceConditionType: sourceType,
        sourceConditionValue: value,
      });
    }
  }

  return conditions.map(({ _key, ...condition }) => condition);
}

function sourceRuleIdFromEntry(entry = {}) {
  return asString(
    entry.id ??
      entry.rule_id ??
      entry.ruleId ??
      entry.commission_id ??
      entry.commissionId,
  );
}

function sourceGroupIdFromEntry(entry = {}) {
  return asString(
    entry.group_id ??
      entry.groupId ??
      entry.commission_group_id ??
      entry.commissionGroupId ??
      entry.payout_group_id ??
      entry.payoutGroupId,
  );
}

function conditionSignature(conditions = []) {
  return conditions
    .map((condition) => `${condition.conditionType}:${condition.operator ?? ""}:${condition.value}`)
    .join("|");
}

/**
 * Stable logical payout identity.
 *
 * IMPORTANT: payout amount/rate is deliberately excluded. A supplier rate change
 * (for example 10% -> 12%) must create a new effective version of the same logical
 * outcome, not a brand-new lineage. `outcomeSlot` separates multiple otherwise
 * identical payout outcomes inside one source entry without making the value part
 * of identity. `sourceEntryIndex` is used only when the supplier provides no rule or
 * group ID, preventing anonymous commission groups from collapsing together.
 */
function stableOutcomeKey({
  campaignId,
  sourceObject,
  sourcePath,
  sourceRuleId,
  sourceGroupId,
  sourceEntryIndex,
  fact,
  conditions,
  outcomeSlot,
}) {
  const sourceIdentity = sourceRuleId ?? sourceGroupId ?? `ANON_SOURCE_ENTRY_${sourceEntryIndex ?? 1}`;
  const currency = fact?.currency ?? "";
  const basis = fact?.basis ?? (fact?.kind === "PERCENT" ? "PERCENT_OF_SALE" : fact?.kind === "FIXED" ? "FIXED_AMOUNT" : "UNKNOWN");
  const conditionPart = conditionSignature(conditions);
  return [
    campaignId ?? "NO_CAMPAIGN_ID",
    sourceObject ?? "campaigns",
    sourcePath ?? "commission",
    sourceIdentity,
    fact?.kind ?? "OTHER",
    basis,
    currency,
    `slot:${outcomeSlot ?? 1}`,
    conditionPart,
  ].join("::");
}

function normalizeRuleEntry(entry, {
  sourcePath,
  sourceObject,
  campaignId,
  fact,
  commissionSequence,
  outcomeSlot,
  sourceEntryIndex,
}) {
  if (!fact?.display) return null;

  const sourceRuleId = sourceRuleIdFromEntry(entry);
  const sourceGroupId = sourceGroupIdFromEntry(entry);
  const conditions = conditionsFromEntry(entry);
  const commissionModel = asString(
    entry.model ??
      entry.performance_model ??
      entry.performanceModel ??
      entry.pricing_model ??
      entry.pricingModel,
  );
  const commissionType =
    asString(entry.commission_type ?? entry.commissionType ?? entry.type) ??
    (fact.kind === "PERCENT" ? "PERCENTAGE" : fact.kind === "FIXED" ? "FIXED" : "OTHER");
  const basis = fact.basis ?? (fact.kind === "PERCENT" ? "PERCENT_OF_SALE" : fact.kind === "FIXED" ? "FIXED_AMOUNT" : "UNKNOWN");

  return {
    sourceCampaignId: campaignId != null ? String(campaignId) : null,
    sourceGroupId,
    sourceGroupName: asString(
      entry.group_name ?? entry.groupName ?? entry.commission_group_name ?? entry.commissionGroupName,
    ),
    sourceRuleId,
    sourceRuleName: asString(entry.rule_name ?? entry.ruleName ?? entry.name ?? entry.title),
    outcomeKey: stableOutcomeKey({
      campaignId,
      sourceObject,
      sourcePath,
      sourceRuleId,
      sourceGroupId,
      sourceEntryIndex,
      fact,
      conditions,
      outcomeSlot,
    }),
    outcomeSlot,
    commissionSequence,
    commissionModel,
    commissionType,
    supplierRuleType: fact.kind === "PERCENT" ? "PERCENT" : fact.kind === "FIXED" ? "FIXED" : "OTHER",
    basis,
    ratePercent: fact.kind === "PERCENT" ? fact.value : null,
    fixedAmount: fact.kind === "FIXED" ? fact.value : null,
    currency: fact.currency ?? null,
    actionType: asString(entry.action_type ?? entry.actionType ?? entry.action),
    priority: asNumber(entry.priority),
    rank: asNumber(entry.rank),

    // Convenience/display fields retained for backward compatibility only.
    customerType: asString(entry.customer_type ?? entry.customerType ?? entry.audience),
    country: asString(entry.country ?? entry.country_code),
    categoryProductGoal: asString(
      entry.category ??
        entry.product ??
        entry.goal ??
        entry.scope ??
        entry.vertical ??
        entry.product_category,
    ),
    couponOrTier: asString(
      entry.tier ?? entry.coupon ?? entry.coupon_code ?? entry.couponCode ?? entry.couponOrTier,
    ),

    conditions,
    effectiveFrom: entry.effective_from ?? entry.effectiveFrom ?? entry.start_date ?? null,
    effectiveUntil: entry.effective_until ?? entry.effectiveUntil ?? entry.end_date ?? null,
    sourceObject,
    sourcePath,
    _mboSourcePath: sourcePath,
    _mboSourceObject: sourceObject,
    rawRuleReference: entry,
    record_source: "commission_rule",
  };
}

export function extractCommissionRulesFromCampaignRaw(
  raw,
  { sourceObject = "campaigns", commissionGroups = null, commissionUnit = null, currency = null } = {},
) {
  if (!raw || typeof raw !== "object") return [];
  const campaignId = campaignIdFromRaw(raw);
  const dedupe = new Map();
  let commissionSequence = 1;
  const sourceEntries = collectSourceEntries({ groups: commissionGroups, raw });

  for (let sourceEntryIndex = 0; sourceEntryIndex < sourceEntries.length; sourceEntryIndex += 1) {
    const entry = sourceEntries[sourceEntryIndex];
    const { facts } = listCampaignCommissionFacts({
      groups: [entry],
      commissionUnit,
      currency,
      raw: {},
    });

    let outcomeSlot = 1;
    for (const fact of facts) {
      const normalized = normalizeRuleEntry(entry, {
        sourcePath: "commission",
        sourceObject,
        campaignId,
        fact,
        commissionSequence,
        outcomeSlot,
        sourceEntryIndex: sourceEntryIndex + 1,
      });
      outcomeSlot += 1;
      if (!normalized) continue;
      if (dedupe.has(normalized.outcomeKey)) continue;
      dedupe.set(normalized.outcomeKey, normalized);
      commissionSequence += 1;
    }
  }

  return [...dedupe.values()];
}

export function collectEmbeddedCommissionRulesFromCampaigns(
  campaigns = [],
  { sourceObject = "campaigns" } = {},
) {
  const all = [];
  for (const campaign of campaigns) {
    const raw = campaign?.rawData ?? campaign?.originalPayload ?? campaign;
    const extracted = extractCommissionRulesFromCampaignRaw(raw, {
      sourceObject,
      commissionGroups: campaign?.commissionGroups ?? raw?.commissionGroups,
    });
    for (const row of extracted) all.push(row);
  }
  return all;
}
