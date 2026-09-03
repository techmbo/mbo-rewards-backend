function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function present(value) {
  return value !== null && value !== undefined && value !== "";
}

function text(value) {
  return present(value) ? String(value) : null;
}

function numberOrNull(value) {
  if (!present(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sourceFieldCondition(rule = {}) {
  const listId = text(rule.list_id);
  const listName = text(rule.list_name);
  const operand = present(rule.operand) ? rule.operand : null;
  return {
    conditionType: "OTHER_SOURCE_CONDITION",
    operator: text(rule.operation) || "UNKNOWN",
    value: JSON.stringify({
      transactionFieldId: rule.transaction_field_id ?? null,
      transactionFieldName: text(rule.transaction_field_name),
      operand,
      listId,
      listName,
      categoryLevel: rule.category_level ?? null,
    }),
    sourceConditionType: text(rule.transaction_field_name) || text(rule.transaction_field_id) || "RAKUTEN_DYNAMIC_RULE",
    sourceConditionValue: operand ?? listId ?? listName,
    metadata: {
      transactionFieldId: rule.transaction_field_id ?? null,
      transactionFieldName: text(rule.transaction_field_name),
      sourceOperation: text(rule.operation),
      operand,
      listId,
      listName,
      listDetailsLink: text(rule.list_details_link),
      categoryLevel: rule.category_level ?? null,
      matcherReady: false,
      reason: "rakuten_transaction_field_fact_not_yet_verified",
    },
  };
}

function tierEvidenceCondition(tier = {}, commissionType) {
  return {
    conditionType: "COMMISSION_TIER",
    operator: "SOURCE_RANGE",
    value: JSON.stringify({
      threshold: tier.threshold ?? null,
      upperThreshold: tier.upper_threshold ?? null,
    }),
    sourceConditionType: `RAKUTEN_${String(commissionType || "UNKNOWN").toUpperCase()}_TIER`,
    sourceConditionValue: `${tier.threshold ?? ""}|${tier.upper_threshold ?? ""}`,
    metadata: {
      threshold: tier.threshold ?? null,
      upperThreshold: tier.upper_threshold ?? null,
      matcherReady: false,
      reason: "rakuten_tier_boundary_semantics_preserved_until_transaction_fact_mapping_is_verified",
    },
  };
}

function economicsFor(commission = {}, tier = {}) {
  const type = String(commission.commission_type || "").toLowerCase();
  const amount = numberOrNull(tier.commission);

  if (type === "sale") {
    return {
      supplierRuleType: "SALE",
      commissionModel: "CPS",
      commissionType: "PERCENTAGE",
      basis: "PERCENT_OF_SALE",
      ratePercent: amount,
      fixedAmount: null,
      actionType: "SALE",
    };
  }

  if (type === "flat") {
    return {
      supplierRuleType: "FLAT",
      commissionModel: "CPA",
      commissionType: "FIXED",
      basis: "FIXED_PER_ACTION_OR_ITEM",
      ratePercent: null,
      fixedAmount: amount,
      actionType: "ACTION_OR_ITEM",
    };
  }

  if (type === "cpc") {
    return {
      supplierRuleType: "CPC",
      commissionModel: "CPC",
      commissionType: "CPC",
      basis: "CPC",
      ratePercent: null,
      fixedAmount: amount,
      actionType: "CLICK",
    };
  }

  if (type === "cpm") {
    return {
      supplierRuleType: "CPM",
      commissionModel: "CPM",
      commissionType: "CPM",
      basis: "CPM",
      ratePercent: null,
      fixedAmount: amount,
      actionType: "IMPRESSION",
    };
  }

  return {
    supplierRuleType: text(commission.commission_type) || "UNKNOWN",
    commissionModel: "UNKNOWN",
    commissionType: "OTHER",
    basis: "UNKNOWN",
    ratePercent: null,
    fixedAmount: amount,
    actionType: null,
  };
}

function logicalOutcomeKey({ advertiserId, goid, oid, commissionIndex, tierIndex, commissionType }) {
  return [
    "rakuten",
    "offer",
    advertiserId ?? "unknown-advertiser",
    goid ?? "unknown-goid",
    oid ?? "unknown-oid",
    String(commissionType || "unknown").toLowerCase(),
    `commission-${commissionIndex}`,
    `tier-${tierIndex}`,
  ].join(":");
}

/**
 * Convert the documented Rakuten Offers JSON shape into SupplierCommissionRule
 * candidates without guessing transaction-field facts, tier boundary semantics,
 * or a missing fixed-payout currency.
 *
 * Safe auto-ready case today:
 * - commission_type=sale
 * - exactly one tier (threshold 0, no upper threshold)
 * - no dynamic_rules
 * This is an unconditional percentage-of-sale outcome.
 *
 * Everything else is preserved as a candidate with REVIEW_REQUIRED so it cannot
 * silently become financial truth before the missing source semantics are wired.
 */
export function mapRakutenOfferCommissionCandidates(offer = {}, context = {}) {
  const advertiserId =
    offer?.advertiser?.id ?? offer?.advertiser_id ?? context.supplierCampaignId ?? null;
  const goid = offer?.goid ?? null;
  const effectiveFrom = offer?.start_datetime ?? null;
  const effectiveUntil = offer?.end_datetime ?? null;
  const results = [];
  let sequence = 0;

  for (const [ruleIndex, rule] of asArray(offer.offer_rules).entries()) {
    const oid = rule?.oid ?? null;
    for (const [commissionIndex, commission] of asArray(rule?.commissions).entries()) {
      const dynamicRules = asArray(commission?.dynamic_rules);
      const tiers = asArray(commission?.tiers);

      for (const [tierIndex, tier] of tiers.entries()) {
        sequence += 1;
        const economics = economicsFor(commission, tier);
        const isBaseSingleSale =
          String(commission?.commission_type || "").toLowerCase() === "sale" &&
          tiers.length === 1 &&
          numberOrNull(tier?.threshold) === 0 &&
          !present(tier?.upper_threshold) &&
          dynamicRules.length === 0;

        const conditions = dynamicRules.map(sourceFieldCondition);
        const hasTierRestriction =
          tiers.length > 1 ||
          numberOrNull(tier?.threshold) !== 0 ||
          present(tier?.upper_threshold);
        if (hasTierRestriction) conditions.push(tierEvidenceCondition(tier, commission?.commission_type));

        const needsCurrency = economics.fixedAmount != null;
        const reviewReasons = [];
        if (dynamicRules.length) reviewReasons.push("dynamic_transaction_field_mapping_required");
        if (hasTierRestriction) reviewReasons.push("tier_boundary_fact_mapping_required");
        if (needsCurrency && !context.currency) reviewReasons.push("fixed_payout_currency_missing");
        if (economics.basis === "UNKNOWN") reviewReasons.push("unsupported_commission_type");

        const mappingStatus = isBaseSingleSale && reviewReasons.length === 0
          ? "VERIFIED"
          : "REVIEW_REQUIRED";

        results.push({
          supplier: "RAKUTEN",
          sourceAccountLabel: context.sourceAccountLabel ?? "default",
          campaignSourceId: context.campaignSourceId ?? null,
          supplierCampaignId: advertiserId != null ? String(advertiserId) : null,
          sourceGroupId: goid != null ? String(goid) : null,
          sourceGroupName: text(offer?.name),
          sourceRuleId: oid != null ? String(oid) : null,
          sourceRuleName: text(commission?.description),
          outcomeKey: logicalOutcomeKey({
            advertiserId,
            goid,
            oid,
            commissionIndex,
            tierIndex,
            commissionType: commission?.commission_type,
          }),
          commissionSequence: sequence,
          ...economics,
          currency: context.currency ?? null,
          effectiveFrom,
          effectiveUntil,
          networkSource: "rakuten",
          sourceObject: "offers",
          sourcePath: `offer_rules[${ruleIndex}].commissions[${commissionIndex}].tiers[${tierIndex}]`,
          mappingStatus,
          fieldMappingOutcome: mappingStatus === "VERIFIED" ? "MAPPED" : "REVIEW_REQUIRED",
          conditions,
          rawRuleReference: {
            advertiserId,
            goid,
            offerNumber: offer?.offer_number ?? null,
            oid,
            commissionType: commission?.commission_type ?? null,
            tierIndex,
          },
          metadata: {
            sourceOfferStatus: offer?.status ?? null,
            sourceOfferType: offer?.type ?? null,
            isBaseCommission: rule?.is_base_commission ?? null,
            isFirstClick: rule?.is_first_click ?? null,
            isDynamic: rule?.is_dynamic ?? null,
            skuListName: rule?.sku_list_name ?? null,
            tierThreshold: tier?.threshold ?? null,
            tierUpperThreshold: tier?.upper_threshold ?? null,
            commissionDescription: commission?.description ?? null,
            reviewReasons,
            financeReady: mappingStatus === "VERIFIED",
          },
        });
      }
    }
  }

  return results;
}
