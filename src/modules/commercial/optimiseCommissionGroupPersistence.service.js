/**
 * Persist Optimise detailed commission groups into the canonical
 * SupplierCommissionRule[] / SupplierCommissionCondition[] architecture.
 *
 * RAW (RawPayload / Entity commission_group) → SOURCE evidence → Optimise normalizer
 * → SupplierCommissionRuleService.upsertNormalizedFact (historical versioning).
 *
 * Precedence: once a campaign has detailed commission-group rules, its campaign-level
 * summary rules (sourceObject "campaigns", derived from commissionCost / first group)
 * are closed as superseded so the same supplier payout is never represented twice.
 * A failed commission-groups fetch never touches existing rules of any kind.
 */

import { prisma } from "../../database/prisma.js";
import { parseNetworkSource } from "../supplier/entityIdentity.js";
import { mapOptimiseCommissionGroupCandidates } from "./optimiseCommissionGroup.mapper.js";
import { SupplierCommissionRuleService } from "./services/supplierCommissionRule.service.js";

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function campaignCurrency(supplierCampaign = null) {
  const value = supplierCampaign?.commissionCurrency ?? supplierCampaign?.currencyCode ?? null;
  return value ? String(value).slice(0, 3).toUpperCase() : null;
}

export class OptimiseCommissionGroupPersistenceService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.ruleService = deps.ruleService ?? new SupplierCommissionRuleService({ prisma: this.db });
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Pure planning step (no DB): candidates per campaign from fetched groups.
   * Used before campaign staging to decide which campaigns get the detailed
   * precedence (campaign-summary fan-out skipped).
   *
   * @param {Map<string, {status:string, groups:object[]}>|object} byCampaign
   */
  planCandidates({ networkSource, sourceAccountLabel = "default", byCampaign, fetchedAt = null }) {
    const entries = byCampaign instanceof Map ? [...byCampaign.entries()] : Object.entries(byCampaign ?? {});
    const candidatesByCampaign = new Map();
    for (const [campaignId, outcome] of entries) {
      if (!outcome || outcome.status !== "SUCCESS") continue;
      const candidates = mapOptimiseCommissionGroupCandidates(outcome.groups ?? [], {
        sourceCampaignId: campaignId,
        networkSource,
        sourceAccountLabel,
        currency: outcome.currency ?? null,
        fetchedAt: fetchedAt ?? outcome.fetchedAt ?? null,
      });
      candidatesByCampaign.set(String(campaignId), candidates);
    }
    return candidatesByCampaign;
  }

  async resolveSupplierCampaign({ networkSource, sourceAccountLabel, sourceCampaignId }, client = null) {
    const db = client ?? this.db;
    if (!db?.supplierCampaign?.findFirst) return null;
    const { supplier, supplierRegion } = parseNetworkSource(networkSource);
    return db.supplierCampaign.findFirst({
      where: {
        supplier,
        supplierRegion,
        sourceAccountLabel,
        supplierCampaignId: String(sourceCampaignId),
        archivedAt: null,
      },
      include: {
        campaignSources: {
          where: { isActive: true },
          orderBy: [{ isPrimary: "desc" }, { priority: "asc" }, { createdAt: "asc" }],
          take: 1,
        },
      },
    });
  }

  /**
   * Persist the candidates of one campaign and close superseded campaign-summary rules.
   */
  async persistCampaign(
    { networkSource, sourceAccountLabel = "default", sourceCampaignId, groups, fetchedAt = null, currency = null, syncRunId = null, rawPayloadId = null },
    client = null,
  ) {
    const db = client ?? this.db;
    const evidenceAt = validDate(fetchedAt) ?? this.now();
    const supplierCampaign = await this.resolveSupplierCampaign(
      { networkSource, sourceAccountLabel, sourceCampaignId },
      db,
    );
    const campaignSourceId = supplierCampaign?.campaignSources?.[0]?.id ?? null;

    const candidates = mapOptimiseCommissionGroupCandidates(groups ?? [], {
      sourceCampaignId,
      networkSource,
      sourceAccountLabel,
      currency: currency ?? campaignCurrency(supplierCampaign),
      supplierCampaignId: supplierCampaign?.id ?? null,
      campaignSourceId,
      fetchedAt: evidenceAt,
    });

    let persisted = 0;
    let financeReady = 0;
    let reviewRequired = 0;
    const ruleIds = [];

    for (const candidate of candidates) {
      const row = await this.ruleService.upsertNormalizedFact(
        {
          ...candidate,
          supplierCampaignId: supplierCampaign?.id ?? null,
          campaignSourceId,
          sourceAccountLabel,
          sourceEvidenceAt: evidenceAt,
          rawPayloadId: rawPayloadId ?? null,
          metadata: {
            ...(candidate.metadata ?? {}),
            brandName: supplierCampaign?.merchantNameRaw ?? null,
            campaignName: supplierCampaign?.campaignName ?? null,
            supplierCampaignDbId: supplierCampaign?.id ?? null,
            campaignSourceId,
            syncRunId,
            promotionGate: "PERSIST_ALL_MARK_UNVERIFIED",
          },
        },
        db,
      );
      persisted += 1;
      if (candidate.mappingStatus === "VERIFIED") financeReady += 1;
      else reviewRequired += 1;
      if (row?.id) ruleIds.push(row.id);
    }

    let supersededSummaryRules = 0;
    if (persisted > 0) {
      supersededSummaryRules = await this.closeSupersededCampaignSummaryRules(
        { sourceAccountLabel, sourceCampaignId, closedAt: evidenceAt },
        db,
      );
    }

    return {
      sourceCampaignId: String(sourceCampaignId),
      supplierCampaignId: supplierCampaign?.id ?? null,
      campaignSourceId,
      candidateCount: candidates.length,
      persisted,
      financeReady,
      reviewRequired,
      supersededSummaryRules,
      ruleIds,
      linked: Boolean(campaignSourceId),
    };
  }

  /**
   * Close open campaign-level summary rules (sourceObject "campaigns") for a campaign
   * that now carries detailed commission-group rules. Closing (effectiveUntil) is the
   * versioning primitive — history is preserved, nothing is deleted or overwritten.
   */
  async closeSupersededCampaignSummaryRules({ sourceAccountLabel = "default", sourceCampaignId, closedAt }, client = null) {
    const db = client ?? this.db;
    if (!db?.supplierCommissionRule?.updateMany) return 0;
    const result = await db.supplierCommissionRule.updateMany({
      where: {
        supplier: "OPTIMISE",
        sourceAccountLabel,
        sourceObject: "campaigns",
        effectiveUntil: null,
        outcomeKey: { startsWith: `${String(sourceCampaignId)}::` },
        effectiveFrom: { lt: closedAt },
      },
      data: { effectiveUntil: closedAt },
    });
    return result?.count ?? 0;
  }

  /**
   * Persist every successfully fetched campaign. Failed campaigns are reported and
   * left untouched (their existing rules remain effective).
   */
  async persistFetchedGroups({ networkSource, sourceAccountLabel = "default", byCampaign, fetchedAt = null, syncRunId = null }) {
    const entries = byCampaign instanceof Map ? [...byCampaign.entries()] : Object.entries(byCampaign ?? {});
    const summary = {
      campaignsFetched: 0,
      campaignsFailed: 0,
      campaignsWithDetailedRules: 0,
      campaignsUnlinked: 0,
      rulesPersisted: 0,
      financeReady: 0,
      reviewRequired: 0,
      supersededSummaryRules: 0,
      persistErrors: [],
      campaigns: [],
    };

    for (const [campaignId, outcome] of entries) {
      if (!outcome || outcome.status !== "SUCCESS") {
        summary.campaignsFailed += 1;
        continue;
      }
      summary.campaignsFetched += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await this.persistCampaign({
          networkSource,
          sourceAccountLabel,
          sourceCampaignId: campaignId,
          groups: outcome.groups ?? [],
          fetchedAt: outcome.fetchedAt ?? fetchedAt,
          currency: outcome.currency ?? null,
          syncRunId,
        });
        summary.rulesPersisted += result.persisted;
        summary.financeReady += result.financeReady;
        summary.reviewRequired += result.reviewRequired;
        summary.supersededSummaryRules += result.supersededSummaryRules;
        if (result.persisted > 0) summary.campaignsWithDetailedRules += 1;
        if (result.persisted > 0 && !result.linked) summary.campaignsUnlinked += 1;
        summary.campaigns.push(result);
      } catch (error) {
        summary.persistErrors.push({ campaignId: String(campaignId), message: error?.message || String(error) });
      }
    }

    return summary;
  }
}
