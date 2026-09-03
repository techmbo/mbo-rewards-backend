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

function normalizedActionType(value) {
  return String(value || "").trim().toLowerCase();
}

function economicsFor(rate = {}, actionTracker = {}) {
  const type = String(rate?.type || "").trim().toUpperCase();
  const actionType = normalizedActionType(actionTracker?.type);
  const value = numberOrNull(rate?.value);
  const currency = text(rate?.currency)?.slice(0, 3).toUpperCase() ?? null;

  if (type === "PERCENT" && ["sim_sale", "item_sale"].includes(actionType)) {
    return {
      supplierRuleType: "PERCENT",
      commissionModel: "CPS",
      commissionType: "PERCENTAGE",
      basis: "PERCENT_OF_SALE",
      ratePercent: value,
      fixedAmount: null,
      currency: null,
      actionType: "SALE",
      calculationGrain: actionType === "item_sale" ? "ITEM" : "ORDER",
      financeSemanticsVerified: true,
    };
  }

  if (type === "FIXED_PER_ORDER") {
    return {
      supplierRuleType: "FIXED_PER_ORDER",
      commissionModel: "CPA",
      commissionType: "FIXED_PER_ORDER",
      basis: "FIXED_PER_ORDER",
      ratePercent: null,
      fixedAmount: value,
      currency,
      actionType: text(actionTracker?.type)?.toUpperCase() ?? null,
      calculationGrain: "ORDER",
      financeSemanticsVerified: true,
    };
  }

  // CJ documents FIXED as a fixed-per-item commission type. Keep it finance-ready
  // only when the action tracker itself is item-grained.
  if (type === "FIXED" && ["item_sale", "item_lead"].includes(actionType)) {
    return {
      supplierRuleType: "FIXED",
      commissionModel: actionType === "item_sale" ? "CPS" : "CPL",
      commissionType: "FIXED_PER_ITEM",
      basis: "FIXED_PER_ITEM",
      ratePercent: null,
      fixedAmount: value,
      currency,
      actionType: actionType === "item_sale" ? "SALE" : "LEAD",
      calculationGrain: "ITEM",
      financeSemanticsVerified: true,
    };
  }

  return {
    supplierRuleType: type || "UNKNOWN",
    commissionModel: "UNKNOWN",
    commissionType: type || "OTHER",
    basis: "UNKNOWN",
    ratePercent: type === "PERCENT" ? value : null,
    fixedAmount: type === "PERCENT" ? null : value,
    currency,
    actionType: text(actionTracker?.type)?.toUpperCase() ?? null,
    calculationGrain: null,
    financeSemanticsVerified: false,
  };
}

function sourceCondition({ type, id, name, metadata = {} }) {
  return {
    conditionType: "OTHER_SOURCE_CONDITION",
    operator: "EQ",
    value: text(id ?? name),
    sourceConditionType: type,
    sourceConditionValue: text(id ?? name),
    metadata: {
      sourceId: text(id),
      sourceName: text(name),
      matcherReady: false,
      ...metadata,
    },
  };
}

function commissionConditions(commission = {}) {
  const conditions = [];

  if (commission?.itemList) {
    conditions.push(sourceCondition({
      type: "CJ_ITEM_LIST_ID",
      id: commission.itemList.id,
      name: commission.itemList.name,
      metadata: { reason: "cj_item_list_transaction_fact_mapping_required" },
    }));
  }

  if (commission?.situation) {
    conditions.push(sourceCondition({
      type: "CJ_SITUATION_ID",
      id: commission.situation.id,
      name: commission.situation.name,
      metadata: { reason: "cj_situation_transaction_fact_mapping_required" },
    }));
  }

  for (const property of asArray(commission?.promotionalProperties)) {
    conditions.push(sourceCondition({
      type: "CJ_PROMOTIONAL_PROPERTY_ID",
      id: property?.id,
      name: property?.name,
      metadata: { reason: "cj_promotional_property_fact_mapping_required" },
    }));
  }

  if (commission?.isViewThrough === true) {
    conditions.push({
      conditionType: "TRAFFIC_TYPE",
      operator: "EQ",
      value: "VIEW_THROUGH",
      sourceConditionType: "CJ_IS_VIEW_THROUGH",
      sourceConditionValue: true,
      metadata: { matcherReady: true },
    });
  }

  return conditions;
}

function conditionSignature(commission = {}) {
  const itemList = commission?.itemList?.id ?? "*";
  const situation = commission?.situation?.id ?? "*";
  const properties = asArray(commission?.promotionalProperties)
    .map((property) => property?.id)
    .filter(present)
    .map(String)
    .sort()
    .join(",") || "*";
  const viewThrough = commission?.isViewThrough === true ? "view" : "standard";
  return `${itemList}|${situation}|${properties}|${viewThrough}`;
}

function logicalOutcomeKey({ advertiserId, programTermsId, actionTermId, rank, commission }) {
  return [
    "cj",
    "program-terms",
    advertiserId ?? "unknown-advertiser",
    programTermsId ?? "unknown-program-terms",
    actionTermId ?? "unknown-action-term",
    `rank-${rank ?? "unknown"}`,
    conditionSignature(commission),
  ].join(":");
}

function incentiveOutcomeKey({ advertiserId, programTermsId, actionTermId, index, incentive }) {
  return [
    "cj",
    "program-terms",
    advertiserId ?? "unknown-advertiser",
    programTermsId ?? "unknown-program-terms",
    actionTermId ?? "unknown-action-term",
    "performance-incentive",
    index,
    incentive?.threshold?.type ?? "unknown-threshold",
  ].join(":");
}

function reviewReasonsForCommission({ economics, conditions, commission }) {
  const reasons = [];
  if (!economics.financeSemanticsVerified) reasons.push("unsupported_cj_action_rate_combination");
  if (economics.fixedAmount != null && !economics.currency) reasons.push("fixed_payout_currency_missing");
  if (conditions.some((condition) => condition?.metadata?.matcherReady === false)) {
    reasons.push("source_condition_fact_mapping_required");
  }
  if (numberOrNull(commission?.rate?.value) == null) reasons.push("commission_rate_missing");
  return reasons;
}

function mapPerformanceIncentive({ incentive, advertiserId, programTerms, actionTerm, index, context }) {
  const thresholdType = text(incentive?.threshold?.type);
  const thresholdValue = numberOrNull(incentive?.threshold?.value);
  const rewardType = text(incentive?.reward?.type);
  const rewardCommissionType = text(incentive?.reward?.commissionType);
  const rewardValue = numberOrNull(incentive?.reward?.value);
  const currency = text(incentive?.currency)?.slice(0, 3).toUpperCase() ?? null;

  return {
    supplier: "CJ",
    sourceAccountLabel: context.sourceAccountLabel ?? "default",
    campaignSourceId: context.campaignSourceId ?? null,
    supplierCampaignId: advertiserId != null ? String(advertiserId) : null,
    sourceGroupId: text(programTerms?.id),
    sourceGroupName: text(programTerms?.name),
    sourceRuleId: `${text(actionTerm?.id) ?? "action-term"}:performance:${index}`,
    sourceRuleName: `CJ performance incentive ${index + 1}`,
    outcomeKey: incentiveOutcomeKey({
      advertiserId,
      programTermsId: programTerms?.id,
      actionTermId: actionTerm?.id,
      index,
      incentive,
    }),
    commissionSequence: context.sequence,
    supplierRuleType: "PERFORMANCE_INCENTIVE",
    commissionModel: "TIERED",
    commissionType: rewardCommissionType === "PERCENT" ? "PERCENTAGE" : "FIXED",
    basis: "PERFORMANCE_THRESHOLD",
    ratePercent: rewardCommissionType === "PERCENT" ? rewardValue : null,
    fixedAmount: rewardCommissionType === "PERCENT" ? null : rewardValue,
    currency,
    actionType: text(actionTerm?.actionTracker?.type)?.toUpperCase() ?? null,
    priority: null,
    rank: null,
    effectiveFrom: context.effectiveFrom,
    effectiveUntil: context.effectiveUntil,
    networkSource: "cj",
    sourceObject: "program_terms",
    sourcePath: `programTerms.actionTerms[${context.actionTermIndex}].performanceIncentives[${index}]`,
    mappingStatus: "REVIEW_REQUIRED",
    fieldMappingOutcome: "REVIEW_REQUIRED",
    conditions: [{
      conditionType: "PERFORMANCE_THRESHOLD",
      operator: "GTE",
      value: thresholdValue,
      sourceConditionType: thresholdType ?? "CJ_PERFORMANCE_THRESHOLD",
      sourceConditionValue: thresholdValue,
      metadata: {
        matcherReady: false,
        reason: "cj_performance_threshold_period_semantics_required",
      },
    }],
    rawRuleReference: {
      advertiserId: text(advertiserId),
      programTermsId: text(programTerms?.id),
      actionTermId: text(actionTerm?.id),
      thresholdType,
      rewardType,
      rewardCommissionType,
    },
    metadata: {
      financeReady: false,
      sourcePrecedenceVerified: false,
      thresholdType,
      thresholdValue,
      rewardType,
      rewardCommissionType,
      rewardValue,
      reviewReasons: ["performance_incentive_period_semantics_required"],
    },
  };
}

/**
 * Map the documented CJ Publisher Program Terms schema into SupplierCommissionRule
 * candidates without flattening Commission 1..N into one headline percentage.
 *
 * Verified source semantics used here:
 * - Contract.startTime / endTime are the rule effective window.
 * - Commission.rank: higher rank = higher priority.
 * - PERCENT is percentage; FIXED is fixed per item; FIXED_PER_ORDER is fixed/order.
 * - ItemList, Situation and PromotionalProperty are real source conditions, but their
 *   transaction-fact joins remain REVIEW_REQUIRED until the corresponding CJ runtime
 *   data is connected.
 * - Performance incentives are preserved as review-required outcomes until period/
 *   aggregation semantics are proven at runtime.
 */
export function mapCjProgramTermsCommissionCandidates(contract = {}, context = {}) {
  const advertiserId = contract?.advertiserId ?? context.advertiserId ?? null;
  const programTerms = contract?.programTerms ?? {};
  const actionTerms = asArray(programTerms?.actionTerms);
  const effectiveFrom = contract?.startTime ?? null;
  const effectiveUntil = contract?.endTime ?? null;
  const contractStatus = text(contract?.status);
  const results = [];
  let sequence = 0;

  for (const [actionTermIndex, actionTerm] of actionTerms.entries()) {
    const actionTracker = actionTerm?.actionTracker ?? {};

    for (const commission of asArray(actionTerm?.commissions)) {
      sequence += 1;
      const economics = economicsFor(commission?.rate, actionTracker);
      const conditions = commissionConditions(commission);
      const reviewReasons = reviewReasonsForCommission({ economics, conditions, commission });
      if (contractStatus && contractStatus !== "ACTIVE") reviewReasons.push("contract_not_active");

      const mappingStatus = reviewReasons.length === 0 ? "VERIFIED" : "REVIEW_REQUIRED";
      const rank = numberOrNull(commission?.rank);

      results.push({
        supplier: "CJ",
        sourceAccountLabel: context.sourceAccountLabel ?? "default",
        campaignSourceId: context.campaignSourceId ?? null,
        supplierCampaignId: advertiserId != null ? String(advertiserId) : null,
        sourceGroupId: text(programTerms?.id),
        sourceGroupName: text(programTerms?.name),
        sourceRuleId: text(actionTerm?.id),
        sourceRuleName: text(actionTracker?.name) ?? text(actionTracker?.type),
        outcomeKey: logicalOutcomeKey({
          advertiserId,
          programTermsId: programTerms?.id,
          actionTermId: actionTerm?.id,
          rank,
          commission,
        }),
        commissionSequence: sequence,
        ...economics,
        priority: rank,
        rank,
        effectiveFrom,
        effectiveUntil,
        networkSource: "cj",
        sourceObject: "program_terms",
        sourcePath: `programTerms.actionTerms[${actionTermIndex}].commissions[rank=${rank ?? "unknown"}]`,
        mappingStatus,
        fieldMappingOutcome: mappingStatus === "VERIFIED" ? "MAPPED" : "REVIEW_REQUIRED",
        conditions,
        rawRuleReference: {
          advertiserId: text(advertiserId),
          programTermsId: text(programTerms?.id),
          actionTermId: text(actionTerm?.id),
          actionTrackerId: text(actionTracker?.id),
          actionTrackerType: text(actionTracker?.type),
          rank,
        },
        metadata: {
          financeReady: mappingStatus === "VERIFIED",
          sourcePrecedenceVerified: rank != null,
          sourcePrecedenceField: rank != null ? "RANK" : null,
          sourcePrecedenceDirection: rank != null ? "HIGHER_FIRST" : null,
          calculationGrain: economics.calculationGrain,
          contractStatus,
          programTermsIsDefault: programTerms?.isDefault ?? null,
          lockingMethod: actionTerm?.lockingMethod ?? null,
          referralOccurrences: actionTerm?.referralOccurrences ?? null,
          referralPeriod: actionTerm?.referralPeriod ?? null,
          reviewReasons,
        },
      });
    }

    for (const [index, incentive] of asArray(actionTerm?.performanceIncentives).entries()) {
      sequence += 1;
      results.push(mapPerformanceIncentive({
        incentive,
        advertiserId,
        programTerms,
        actionTerm,
        index,
        context: {
          ...context,
          sequence,
          effectiveFrom,
          effectiveUntil,
          actionTermIndex,
        },
      }));
    }
  }

  return results;
}
