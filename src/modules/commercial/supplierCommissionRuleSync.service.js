/**
 * Pointer 12 — persist fan-out supplier commission rules after campaign sync.
 *
 * PR1/PR2 correction: one source rule may yield multiple payable outcomes. The sync
 * therefore persists by MBO outcomeKey, never by sourceRuleId alone.
 */

import { prisma } from "../../database/prisma.js";
import { parseNetworkSource, parseSourceAccountLabel } from "../supplier/entityIdentity.js";
import { enrichSupplierCommissionRuleRecord } from "./supplierCommissionRule.contract.js";
import { collectEmbeddedCommissionRulesFromCampaigns } from "./supplierCommissionRuleFanOut.js";
import { SupplierCommissionRuleService } from "./services/supplierCommissionRule.service.js";

function resolveCampaignId(raw = {}) {
  return raw.sourceCampaignId ?? raw.id ?? raw.campaignId ?? raw.campaign_id ?? raw.CampaignId ?? raw.campaignID ?? raw.productId ?? raw.product_id ?? null;
}

function asDateOrNull(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolveSourceEvidenceAt(record = {}) {
  return asDateOrNull(
    record.sourceEvidenceAt ??
      record.fetchedAt ??
      record.receivedAt ??
      record.syncedAt ??
      record.lastSyncedAt ??
      record.originalPayload?.fetchedAt ??
      record.originalPayload?.receivedAt ??
      null,
  );
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
  const preparedByCampaignId = new Map(
    preparedRecords
      .map((record) => [resolveCampaignId(record.originalPayload ?? {}), record])
      .filter(([campaignId]) => campaignId != null)
      .map(([campaignId, record]) => [String(campaignId), record]),
  );

  const ruleService = new SupplierCommissionRuleService();
  let upserted = 0;

  for (const rule of embedded) {
    const campaignId = resolveCampaignId(rule);
    const campaignKey = campaignId != null ? String(campaignId) : null;
    const sc = campaignKey ? campaignBySupplierId.get(campaignKey) : null;
    const preparedRecord = campaignKey ? preparedByCampaignId.get(campaignKey) : null;
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
        ruleVersion: "SCR-2",
      },
    );

    await ruleService.upsertNormalizedFact({
      campaignSourceId: cs?.id ?? null,
      supplierCampaignId: sc?.id ?? null,
      supplier,
      sourceAccountLabel,

      sourceGroupId: rule.sourceGroupId ?? null,
      sourceGroupName: rule.sourceGroupName ?? null,
      sourceRuleId: enriched.sourceRuleId,
      sourceRuleName: rule.sourceRuleName ?? null,
      outcomeKey: rule.outcomeKey,
      commissionSequence: rule.commissionSequence ?? null,
      commissionModel: rule.commissionModel ?? null,
      commissionType: rule.commissionType ?? null,

      supplierRuleType: enriched.supplierRuleType,
      basis: enriched.basis,
      ratePercent: enriched.ratePercent,
      fixedAmount: enriched.fixedAmount,
      currency: enriched.currency,
      actionType: rule.actionType ?? null,
      priority: rule.priority ?? null,
      rank: rule.rank ?? null,

      // Convenience/display fields only; child conditions are authoritative for matching.
      customerType: enriched.customerType,
      country: enriched.country,
      categoryProductGoal: enriched.categoryProductGoal,
      couponOrTier: enriched.couponOrTier,
      conditions: rule.conditions ?? [],

      networkSource: enriched.networkSource,
      sourceObject: enriched.sourceObject,
      sourcePath: enriched.sourcePath,
      mappingStatus: enriched.mappingStatus,
      fieldMappingOutcome: enriched.fieldMappingOutcome,
      ruleVersion: enriched.ruleVersion,
      // Missing supplier effective dates stay missing here. The persistence service
      // uses an existing open version for identical re-syncs and source evidence time
      // only when a new observed version genuinely has to be created.
      effectiveFrom: asDateOrNull(rule.effectiveFrom),
      effectiveUntil: asDateOrNull(rule.effectiveUntil),
      sourceEvidenceAt: resolveSourceEvidenceAt(preparedRecord ?? {}),
      rawPayloadId: rule.rawPayloadId ?? null,
      rawRuleReference: rule.rawRuleReference ?? null,
      metadata: {
        brandName: sc?.merchantNameRaw ?? null,
        campaignName: sc?.campaignName ?? null,
        sourceCampaignId: campaignKey,
        sourceEffectiveFromProvided: Boolean(rule.effectiveFrom),
      },
    });

    upserted += 1;
  }

  return { upserted };
}
