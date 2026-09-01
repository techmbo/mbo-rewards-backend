/**
 * Epic 2 — normalized supplier commission facts (SupplierCommissionRule).
 * Pointer 12 — one row per rule; campaign commission stays summary-only.
 */

import { prisma } from "../../../database/prisma.js";

export class SupplierCommissionRuleService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  /**
   * Upsert a normalized supplier commission fact for a campaign source + effective window.
   */
  async upsertNormalizedFact(input, client = null) {
    const db = client ?? this.db;
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
    const existing = input.sourceRuleId
      ? await db.supplierCommissionRule.findFirst({
          where: {
            supplier: input.supplier,
            sourceAccountLabel: input.sourceAccountLabel ?? "default",
            sourceRuleId: input.sourceRuleId,
            ...(input.supplierCampaignId ? { supplierCampaignId: input.supplierCampaignId } : {}),
          },
        })
      : input.campaignSourceId
        ? await db.supplierCommissionRule.findFirst({
            where: {
              campaignSourceId: input.campaignSourceId,
              effectiveFrom,
            },
          })
        : null;

    const data = {
      campaignSourceId: input.campaignSourceId ?? null,
      supplierCampaignId: input.supplierCampaignId ?? null,
      supplier: input.supplier,
      sourceAccountLabel: input.sourceAccountLabel ?? "default",
      sourceRuleId: input.sourceRuleId ?? null,
      supplierRuleType: input.supplierRuleType ?? null,
      basis: input.basis ?? "UNKNOWN",
      ratePercent: input.ratePercent ?? null,
      fixedAmount: input.fixedAmount ?? null,
      currency: input.currency ? String(input.currency).slice(0, 3).toUpperCase() : null,
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
      effectiveUntil: input.effectiveUntil ? new Date(input.effectiveUntil) : null,
      rawPayloadId: input.rawPayloadId ?? null,
      metadata: input.metadata ?? null,
    };

    if (existing) {
      return db.supplierCommissionRule.update({
        where: { id: existing.id },
        data,
      });
    }
    return db.supplierCommissionRule.create({ data });
  }

  async findEffectiveForCampaignSource(campaignSourceId, at = new Date(), client = null) {
    const db = client ?? this.db;
    if (!campaignSourceId) return null;
    const atDate = at instanceof Date ? at : new Date(at);
    const rows = await db.supplierCommissionRule.findMany({
      where: {
        campaignSourceId,
        effectiveFrom: { lte: atDate },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: atDate } }],
      },
      orderBy: { effectiveFrom: "desc" },
      take: 1,
    });
    return rows[0] || null;
  }
}
