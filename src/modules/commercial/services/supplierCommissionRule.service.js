/**
 * Epic 2 — normalized supplier commission facts (SupplierCommissionRule).
 * Pointer 12 — one row per payable outcome; campaign commission stays summary-only.
 *
 * PR1 correction:
 * - outcomeKey is the normalized identity, not sourceRuleId alone;
 * - historical effective versions are retained;
 * - child SupplierCommissionCondition rows are replaced transactionally for the same outcome version.
 *
 * PR3:
 * - load all effective supplier rules with conditions;
 * - select the payable supplier rule through the pure Supplier Commission Matcher;
 * - expose expected-vs-actual comparison without replacing network actual commission truth.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
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

function jsonParam(value) {
  return value == null ? null : JSON.stringify(value);
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

function sameMoney(a, b) {
  const left = a == null ? null : Number(a);
  const right = b == null ? null : Number(b);
  if (left == null && right == null) return true;
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

function sameDate(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

export class SupplierCommissionRuleService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  /**
   * Persist one normalized supplier payable outcome.
   *
   * Idempotency scope is supplier + sourceAccountLabel + outcomeKey + effectiveFrom.
   * If the same outcomeKey later changes its financial value or effective start, a new
   * historical version is created instead of overwriting the old rule.
   */
  async upsertNormalizedFact(input, client = null) {
    const db = client ?? this.db;
    if (!input?.supplier) throw new Error("supplier is required");
    if (!input?.outcomeKey) throw new Error("outcomeKey is required");

    const sourceAccountLabel = input.sourceAccountLabel ?? "default";
    const effectiveFrom = asDate(input.effectiveFrom, new Date());
    const effectiveUntil = asDate(input.effectiveUntil, null);
    const currency = normalizeCurrency(input.currency);
    const conditions = normalizeConditions(input.conditions);

    return db.$transaction(async (tx) => {
      const versions = await tx.$queryRaw(Prisma.sql`
        SELECT
          id,
          "effectiveFrom",
          "effectiveUntil",
          "ratePercent",
          "fixedAmount",
          currency,
          "supplierRuleType",
          basis
        FROM "supplier_commission_rules"
        WHERE supplier = ${input.supplier}::"SupplierKey"
          AND "sourceAccountLabel" = ${sourceAccountLabel}
          AND "outcomeKey" = ${input.outcomeKey}
        ORDER BY "effectiveFrom" DESC
      `);

      const exactVersion = versions.find((row) =>
        sameDate(row.effectiveFrom, effectiveFrom) &&
        sameMoney(row.ratePercent, input.ratePercent) &&
        sameMoney(row.fixedAmount, input.fixedAmount) &&
        (row.currency ?? null) === currency &&
        (row.supplierRuleType ?? null) === (input.supplierRuleType ?? null) &&
        (row.basis ?? "UNKNOWN") === (input.basis ?? "UNKNOWN"),
      );

      let rule;
      if (exactVersion) {
        rule = await tx.supplierCommissionRule.update({
          where: { id: exactVersion.id },
          data: {
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
            conditions: {
              deleteMany: {},
              create: conditions,
            },
          },
          include: { conditions: true },
        });
      } else {
        const priorOpen = versions.find(
          (row) => !row.effectiveUntil && new Date(row.effectiveFrom).getTime() < effectiveFrom.getTime(),
        );
        if (priorOpen) {
          await tx.supplierCommissionRule.update({
            where: { id: priorOpen.id },
            data: { effectiveUntil: effectiveFrom },
          });
        }

        rule = await tx.supplierCommissionRule.create({
          data: {
            campaignSourceId: input.campaignSourceId ?? null,
            supplierCampaignId: input.supplierCampaignId ?? null,
            supplier: input.supplier,
            sourceAccountLabel,
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
            effectiveFrom,
            effectiveUntil,
            rawPayloadId: input.rawPayloadId ?? null,
            rawRuleReference: input.rawRuleReference ?? null,
            metadata: input.metadata ?? null,
            conditions: {
              create: conditions,
            },
          },
          include: { conditions: true },
        });
      }

      return rule;
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
