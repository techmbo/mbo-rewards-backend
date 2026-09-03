/**
 * Epic 2 — normalized supplier commission facts (SupplierCommissionRule).
 * Pointer 12 — one row per payable outcome; campaign commission stays summary-only.
 *
 * PR1 correction:
 * - outcomeKey is the normalized logical identity, not sourceRuleId alone;
 * - historical effective versions are retained;
 * - child SupplierCommissionCondition rows are replaced transactionally for the same outcome version.
 *
 * PR3:
 * - load all effective supplier rules with conditions;
 * - select the payable supplier rule through the pure Supplier Commission Matcher;
 * - expose expected-vs-actual comparison without replacing network actual commission truth.
 */

import { prisma } from "../../../database/prisma.js";
import {
  buildSupplierCommissionMatchFacts,
  matchSupplierCommissionRule,
} from "../supplierCommissionMatcher.js";

function asDate(value, fallback = null) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function normalizeCurrency(value) {
  if (!value) return null;
  return String(value).slice(0, 3).toUpperCase();
}

function normalizeConditions(input = []) {
  const seen = new Set();
  const rows = [];
  for (const condition of Array.isArray(input) ? input : []) {
    if (!condition?.conditionType || condition?.value == null || condition?.value === "") continue;
    const row = {
      conditionType: String(condition.conditionType),
      operator: condition.operator ? String(condition.operator) : "EQ",
      value: String(condition.value),
      sourceConditionType: condition.sourceConditionType
        ? String(condition.sourceConditionType)
        : null,
      sourceConditionValue: condition.sourceConditionValue ?? null,
      metadata: condition.metadata ?? null,
    };
    const key = `${row.conditionType}|${row.operator}|${row.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

function moneyOrNull(value) {
  // Explicit zero is real economics (10% -> 0% is a genuine change); blank input is absent.
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sameMoney(a, b) {
  const left = moneyOrNull(a);
  const right = moneyOrNull(b);
  if (left == null && right == null) return true;
  return left != null && right != null && left === right;
}

function sameDate(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

function sameRuleEconomics(row, input, currency) {
  return (
    sameMoney(row.ratePercent, input.ratePercent) &&
    sameMoney(row.fixedAmount, input.fixedAmount) &&
    (row.currency ?? null) === currency &&
    (row.supplierRuleType ?? null) === (input.supplierRuleType ?? null) &&
    (row.basis ?? "UNKNOWN") === (input.basis ?? "UNKNOWN") &&
    (row.commissionModel ?? null) === (input.commissionModel ?? null) &&
    (row.commissionType ?? null) === (input.commissionType ?? null) &&
    (row.actionType ?? null) === (input.actionType ?? null)
  );
}

function resolveObservedAt(input) {
  return asDate(input.sourceEvidenceAt, null) ?? new Date();
}

function versionData(input, {
  sourceAccountLabel,
  currency,
  effectiveFrom,
  effectiveUntil,
  includeIdentity = false,
} = {}) {
  const data = {
    campaignSourceId: input.campaignSourceId ?? null,
    supplierCampaignId: input.supplierCampaignId ?? null,
    sourceGroupId: input.sourceGroupId ?? null,
    sourceGroupName: input.sourceGroupName ?? null,
    sourceRuleId: input.sourceRuleId ?? null,
    sourceRuleName: input.sourceRuleName ?? null,
    outcomeKey: input.outcomeKey,
    commissionSequence: input.commissionSequence ?? null,
    commissionModel: input.commissionModel ?? null,
    commissionType: input.commissionType ?? null,
    supplierRuleType: input.supplierRuleType ?? null,
    basis: input.basis ?? "UNKNOWN",
    ratePercent: input.ratePercent ?? null,
    fixedAmount: input.fixedAmount ?? null,
    currency,
    actionType: input.actionType ?? null,
    priority: input.priority ?? null,
    rank: input.rank ?? null,
    customerType: input.customerType ?? null,
    country: input.country ?? null,
    categoryProductGoal: input.categoryProductGoal ?? null,
    couponOrTier: input.couponOrTier ?? null,
    networkSource: input.networkSource ?? null,
    sourceObject: input.sourceObject ?? null,
    sourcePath: input.sourcePath ?? null,
    mappingStatus: input.mappingStatus ?? null,
    fieldMappingOutcome: input.fieldMappingOutcome ?? null,
    ruleVersion: input.ruleVersion ?? null,
    effectiveUntil,
    rawPayloadId: input.rawPayloadId ?? null,
    rawRuleReference: input.rawRuleReference ?? null,
    metadata: input.metadata ?? null,
  };

  if (effectiveFrom) data.effectiveFrom = effectiveFrom;
  if (includeIdentity) {
    data.supplier = input.supplier;
    data.sourceAccountLabel = sourceAccountLabel;
  }
  return data;
}

export class SupplierCommissionRuleService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  /**
   * Persist one normalized supplier payable outcome.
   *
   * `outcomeKey` is a logical lineage key and must not contain the payout value.
   * Re-syncing identical economics without a supplier effective date reuses the
   * current open version. A genuine economics change closes the prior open version
   * and creates a successor, using supplier effective date when present and otherwise
   * the first observed source-evidence time for that change.
   */
  async upsertNormalizedFact(input, client = null) {
    const db = client ?? this.db;
    if (!input?.supplier) throw new Error("supplier is required");
    if (!input?.outcomeKey) throw new Error("outcomeKey is required");

    const sourceAccountLabel = input.sourceAccountLabel ?? "default";
    const explicitEffectiveFrom = asDate(input.effectiveFrom, null);
    const effectiveUntil = asDate(input.effectiveUntil, null);
    const currency = normalizeCurrency(input.currency);
    const conditions = normalizeConditions(input.conditions);

    return db.$transaction(async (tx) => {
      const versions = await tx.supplierCommissionRule.findMany({
        where: {
          supplier: input.supplier,
          sourceAccountLabel,
          outcomeKey: input.outcomeKey,
        },
        include: { conditions: true },
        orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      });

      // Exact supplier-effective version: safe idempotent update when economics match.
      if (explicitEffectiveFrom) {
        const exactVersion = versions.find(
          (row) => sameDate(row.effectiveFrom, explicitEffectiveFrom) && sameRuleEconomics(row, input, currency),
        );
        if (exactVersion) {
          return tx.supplierCommissionRule.update({
            where: { id: exactVersion.id },
            data: {
              ...versionData(input, {
                sourceAccountLabel,
                currency,
                effectiveUntil,
              }),
              conditions: { deleteMany: {}, create: conditions },
            },
            include: { conditions: true },
          });
        }
      } else {
        // No source effective date: identical repeated payloads must reuse the open
        // version rather than manufacture a new timestamp/version on every sync.
        const identicalOpenVersion = versions.find(
          (row) => row.effectiveUntil == null && sameRuleEconomics(row, input, currency),
        );
        if (identicalOpenVersion) {
          return tx.supplierCommissionRule.update({
            where: { id: identicalOpenVersion.id },
            data: {
              ...versionData(input, {
                sourceAccountLabel,
                currency,
                effectiveUntil: effectiveUntil ?? identicalOpenVersion.effectiveUntil,
              }),
              conditions: { deleteMany: {}, create: conditions },
            },
            include: { conditions: true },
          });
        }
      }

      const effectiveFrom = explicitEffectiveFrom ?? resolveObservedAt(input);

      // If an identical historical version already exists at the resolved observation
      // timestamp, reuse it. This also protects retries that carry a stable fetchedAt.
      const existingAtResolvedTime = versions.find(
        (row) => sameDate(row.effectiveFrom, effectiveFrom) && sameRuleEconomics(row, input, currency),
      );
      if (existingAtResolvedTime) {
        return tx.supplierCommissionRule.update({
          where: { id: existingAtResolvedTime.id },
          data: {
            ...versionData(input, {
              sourceAccountLabel,
              currency,
              effectiveUntil,
            }),
            conditions: { deleteMany: {}, create: conditions },
          },
          include: { conditions: true },
        });
      }

      // Close only the predecessor that is open before this version starts. Never
      // destructively overwrite historical economics.
      const priorOpen = versions.find(
        (row) => row.effectiveUntil == null && new Date(row.effectiveFrom).getTime() < effectiveFrom.getTime(),
      );
      if (priorOpen) {
        await tx.supplierCommissionRule.update({
          where: { id: priorOpen.id },
          data: { effectiveUntil: effectiveFrom },
        });
      }

      return tx.supplierCommissionRule.create({
        data: {
          ...versionData(input, {
            sourceAccountLabel,
            currency,
            effectiveFrom,
            effectiveUntil,
            includeIdentity: true,
          }),
          conditions: { create: conditions },
        },
        include: { conditions: true },
      });
    });
  }

  async listEffectiveForCampaignSource(campaignSourceId, at = new Date(), client = null) {
    const db = client ?? this.db;
    if (!campaignSourceId) return [];
    const atDate = at instanceof Date ? at : new Date(at);
    return db.supplierCommissionRule.findMany({
      where: {
        campaignSourceId,
        effectiveFrom: { lte: atDate },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: atDate } }],
      },
      include: { conditions: true },
      orderBy: [
        { commissionSequence: "asc" },
        { effectiveFrom: "desc" },
        { createdAt: "asc" },
      ],
    });
  }

  /**
   * PR3 authoritative supplier-rule selection for one transaction.
   * Matching time should be the verified source/MBO action date; callers must not silently use "now"
   * when a historical order/conversion date is available.
   */
  async matchForCampaignSource({
    campaignSourceId,
    at,
    order = null,
    conversion = null,
    item = null,
    click = null,
    facts = {},
    actualCommission = null,
    actualCurrency = null,
    client = null,
  } = {}) {
    if (!campaignSourceId) {
      return {
        status: "NO_MATCH",
        reason: "missing_campaign_source_id",
        matchedRule: null,
        matchedSupplierCommissionRuleId: null,
        matchedCommissionSequence: null,
        expectedSupplierCommission: null,
        expectedCurrency: null,
        expectedCalculationStatus: "NOT_CALCULATED",
        networkActualCommission: actualCommission == null ? null : Number(actualCommission),
        actualCurrency: actualCurrency ?? conversion?.currency ?? order?.currency ?? null,
        variance: null,
        comparisonStatus: "NOT_COMPARABLE",
        candidateRuleIds: [],
        reviewReasons: [],
      };
    }

    const matchAt = asDate(
      at ?? order?.orderDate ?? conversion?.conversionDate,
      null,
    );
    if (!matchAt) {
      return {
        status: "REVIEW_REQUIRED",
        reason: "missing_match_date",
        matchedRule: null,
        matchedSupplierCommissionRuleId: null,
        matchedCommissionSequence: null,
        expectedSupplierCommission: null,
        expectedCurrency: null,
        expectedCalculationStatus: "NOT_CALCULATED",
        networkActualCommission: actualCommission == null ? null : Number(actualCommission),
        actualCurrency: actualCurrency ?? conversion?.currency ?? order?.currency ?? null,
        variance: null,
        comparisonStatus: "NOT_COMPARABLE",
        candidateRuleIds: [],
        reviewReasons: ["No verified order/action date was supplied for historical rule matching."],
      };
    }

    const rules = await this.listEffectiveForCampaignSource(campaignSourceId, matchAt, client);
    const matcherFacts = buildSupplierCommissionMatchFacts({
      order,
      conversion,
      item,
      click,
      overrides: facts,
    });

    const networkActual =
      actualCommission ??
      conversion?.approvedCommission ??
      conversion?.supplierCommission ??
      null;

    return matchSupplierCommissionRule({
      rules,
      facts: matcherFacts,
      actualCommission: networkActual,
      actualCurrency: actualCurrency ?? conversion?.currency ?? order?.currency ?? null,
    });
  }

  /** Backward-compatible convenience only. New financial flows should use matchForCampaignSource. */
  async findEffectiveForCampaignSource(campaignSourceId, at = new Date(), client = null) {
    const rows = await this.listEffectiveForCampaignSource(campaignSourceId, at, client);
    return rows[0] || null;
  }
}
