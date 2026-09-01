/**
 * Epic 2 — normalized supplier commission facts (SupplierCommissionRule).
 * Pointer 12 — one row per payable outcome; campaign commission stays summary-only.
 *
 * PR1 correction:
 * - outcomeKey is the normalized identity, not sourceRuleId alone;
 * - historical effective versions are retained;
 * - child SupplierCommissionCondition rows are replaced transactionally for the same outcome version;
 * - new DB columns are written with parameterized raw SQL until Prisma schema regeneration is completed.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../../database/prisma.js";

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
            sourceRuleId: input.sourceRuleId ?? null,
            supplierRuleType: input.supplierRuleType ?? null,
            basis: input.basis ?? "UNKNOWN",
            ratePercent: input.ratePercent ?? null,
            fixedAmount: input.fixedAmount ?? null,
            currency,
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
            metadata: input.metadata ?? null,
          },
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
            sourceRuleId: input.sourceRuleId ?? null,
            supplierRuleType: input.supplierRuleType ?? null,
            basis: input.basis ?? "UNKNOWN",
            ratePercent: input.ratePercent ?? null,
            fixedAmount: input.fixedAmount ?? null,
            currency,
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
            metadata: input.metadata ?? null,
          },
        });
      }

      const rawRuleReferenceJson = jsonParam(input.rawRuleReference);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "supplier_commission_rules"
        SET
          "sourceGroupId" = ${input.sourceGroupId ?? null},
          "sourceGroupName" = ${input.sourceGroupName ?? null},
          "sourceRuleName" = ${input.sourceRuleName ?? null},
          "outcomeKey" = ${input.outcomeKey},
          "commissionSequence" = ${input.commissionSequence ?? null},
          "commissionModel" = ${input.commissionModel ?? null},
          "commissionType" = ${input.commissionType ?? null},
          "actionType" = ${input.actionType ?? null},
          priority = ${input.priority ?? null},
          rank = ${input.rank ?? null},
          "rawRuleReference" = CASE
            WHEN ${rawRuleReferenceJson}::text IS NULL THEN NULL
            ELSE ${rawRuleReferenceJson}::jsonb
          END
        WHERE id = ${rule.id}
      `);

      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "supplier_commission_conditions"
        WHERE "commissionRuleId" = ${rule.id}
      `);

      for (const condition of conditions) {
        const sourceConditionJson = jsonParam(condition.sourceConditionValue);
        const metadataJson = jsonParam(condition.metadata);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "supplier_commission_conditions" (
            id,
            "commissionRuleId",
            "conditionType",
            operator,
            value,
            "sourceConditionType",
            "sourceConditionValue",
            metadata,
            "createdAt",
            "updatedAt"
          ) VALUES (
            ${randomUUID()},
            ${rule.id},
            ${condition.conditionType},
            ${condition.operator},
            ${condition.value},
            ${condition.sourceConditionType},
            CASE
              WHEN ${sourceConditionJson}::text IS NULL THEN NULL
              ELSE ${sourceConditionJson}::jsonb
            END,
            CASE
              WHEN ${metadataJson}::text IS NULL THEN NULL
              ELSE ${metadataJson}::jsonb
            END,
            NOW(),
            NOW()
          )
        `);
      }

      return {
        ...rule,
        outcomeKey: input.outcomeKey,
        commissionSequence: input.commissionSequence ?? null,
        conditions,
      };
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
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "asc" }],
    });
  }

  /** Backward-compatible convenience only. PR3 matcher must select payable rules. */
  async findEffectiveForCampaignSource(campaignSourceId, at = new Date(), client = null) {
    const rows = await this.listEffectiveForCampaignSource(campaignSourceId, at, client);
    return rows[0] || null;
  }
}
