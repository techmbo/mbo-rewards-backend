/**
 * Pointer 12 — persist fan-out supplier commission rules after campaign sync.
 */

import { prisma } from "../../database/prisma.js";
import { parseNetworkSource, parseSourceAccountLabel } from "../supplier/entityIdentity.js";
import { enrichSupplierCommissionRuleRecord } from "./supplierCommissionRule.contract.js";
import { collectEmbeddedCommissionRulesFromCampaigns } from "./supplierCommissionRuleFanOut.js";
import { SupplierCommissionRuleService } from "./services/supplierCommissionRule.service.js";

function resolveCampaignId(raw = {}) {
  return raw.id ?? raw.campaignId ?? raw.campaign_id ?? raw.productId ?? null;
}

export async function upsertCommissionRulesForPreparedCampaigns({
  networkSource,
  preparedRecords = [],
  sourceAccountKey,
}) {
  if (!preparedRecords.length) return { upserted: 0 };

  const { supplier, supplierRegion } = parseNetworkSource(networkSource);
  const { sourceAccountLabel } = parseSourceAccountLabel(sourceAccountKey ?? "default");
  const embedded = collectEmbeddedCommissionRulesFromCampaigns(
    preparedRecords.map((record) => ({ originalPayload: record.originalPayload })),
    { sourceObject: "campaigns" },
  );
  if (!embedded.length) return { upserted: 0 };

  const campaignIds = [
    ...new Set(
      preparedRecords
        .map((record) => resolveCampaignId(record.originalPayload ?? {}))
        .filter(Boolean)
        .map(String),
    ),
  ];

  const supplierCampaigns = campaignIds.length
    ? await prisma.supplierCampaign.findMany({
        where: {
          supplier,
          supplierRegion,
          sourceAccountLabel,
          supplierCampaignId: { in: campaignIds },
        },
        include: {
          campaignSources: { orderBy: { createdAt: "asc" }, take: 1 },
        },
      })
    : [];

  const campaignBySupplierId = new Map(
    supplierCampaigns.map((row) => [String(row.supplierCampaignId), row]),
  );

  const ruleService = new SupplierCommissionRuleService();
  let upserted = 0;

  for (const rule of embedded) {
    const campaignId = resolveCampaignId(rule);
    const sc = campaignId ? campaignBySupplierId.get(String(campaignId)) : null;
    const cs = sc?.campaignSources?.[0] ?? null;
    const enriched = enrichSupplierCommissionRuleRecord(
      {
        sourceRuleId: rule.sourceRuleId,
        supplierRuleType: rule.supplierRuleType,
        basis: rule.basis,
        ratePercent: rule.ratePercent,
        fixedAmount: rule.fixedAmount,
        currency: rule.currency,
        customerType: rule.customerType,
        country: rule.country,
        categoryProductGoal: rule.categoryProductGoal,
        couponOrTier: rule.couponOrTier,
        sourceObject: rule.sourceObject,
        sourcePath: rule.sourcePath,
      },
      {
        networkSource,
        sourceObject: rule.sourceObject,
        sourcePath: rule.sourcePath,
        ruleVersion: "SCR-1",
      },
    );

    const existing = await prisma.supplierCommissionRule.findFirst({
      where: {
        supplier,
        sourceAccountLabel,
        sourceRuleId: enriched.sourceRuleId,
        ...(sc?.id ? { supplierCampaignId: sc.id } : {}),
      },
    });

    const data = {
      campaignSourceId: cs?.id ?? null,
      supplierCampaignId: sc?.id ?? null,
      supplier,
      sourceAccountLabel,
      sourceRuleId: enriched.sourceRuleId,
      supplierRuleType: enriched.supplierRuleType,
      basis: enriched.basis,
      ratePercent: enriched.ratePercent,
      fixedAmount: enriched.fixedAmount,
      currency: enriched.currency,
      customerType: enriched.customerType,
      country: enriched.country,
      categoryProductGoal: enriched.categoryProductGoal,
      couponOrTier: enriched.couponOrTier,
      networkSource: enriched.networkSource,
      sourceObject: enriched.sourceObject,
      sourcePath: enriched.sourcePath,
      mappingStatus: enriched.mappingStatus,
      fieldMappingOutcome: enriched.fieldMappingOutcome,
      ruleVersion: enriched.ruleVersion,
      effectiveFrom: rule.effectiveFrom ? new Date(rule.effectiveFrom) : new Date(),
      effectiveUntil: rule.effectiveUntil ? new Date(rule.effectiveUntil) : null,
      metadata: {
        brandName: sc?.merchantNameRaw ?? null,
        campaignName: sc?.campaignName ?? null,
      },
    };

    if (existing) {
      await prisma.supplierCommissionRule.update({ where: { id: existing.id }, data });
    } else {
      await ruleService.upsertNormalizedFact({
        ...data,
        effectiveFrom: data.effectiveFrom,
      });
    }
    upserted += 1;
  }

  return { upserted };
}
