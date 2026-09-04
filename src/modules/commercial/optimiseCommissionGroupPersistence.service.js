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
import {
  OPTIMISE_COMMISSION_GROUP_SOURCE_OBJECT,
  mapOptimiseCommissionGroupCandidates,
  sourceCampaignIdFromOutcomeKey,
} from "./optimiseCommissionGroup.mapper.js";
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

  /**
   * Source campaign ids that currently have OPEN canonical detailed rules
   * (sourceObject = commission_groups, effectiveUntil = null) for this Optimise
   * account/region. One bounded query; identity comes from the outcomeKey lineage
   * (metadata.sourceCampaignId / supplierCampaign.supplierCampaignId as fallbacks).
   *
   * @returns {Promise<Set<string>>}
   */
  async loadOpenDetailedCampaignIds({ networkSource, sourceAccountLabel = "default" }, client = null) {
    const db = client ?? this.db;
    const ids = new Set();
    if (!db?.supplierCommissionRule?.findMany) return ids;
    const { supplier } = parseNetworkSource(networkSource);
    const rows = await db.supplierCommissionRule.findMany({
      where: {
        supplier,
        sourceAccountLabel,
        networkSource,
        sourceObject: OPTIMISE_COMMISSION_GROUP_SOURCE_OBJECT,
        effectiveUntil: null,
      },
      select: {
        outcomeKey: true,
        metadata: true,
        supplierCampaign: { select: { supplierCampaignId: true } },
      },
    });
    for (const row of rows) {
      const campaignId =
        sourceCampaignIdFromOutcomeKey(row.outcomeKey) ??
        row.metadata?.sourceCampaignId ??
        row.supplierCampaign?.supplierCampaignId ??
        null;
      if (campaignId != null && campaignId !== "") ids.add(String(campaignId));
    }
    return ids;
  }

  /**
   * Detailed-rule precedence for one sync run.
   *
   * protectedCampaignIds = campaigns whose detailed groups succeeded now (with ≥1 outcome)
   *                        ∪ campaigns that already have open detailed rules in the DB.
   * The campaign-summary fan-out is suppressed for every protected campaign, so a
   * transient /commission-groups failure, a disabled/skipped detailed fetch, or an
   * unproven empty response can never reactivate campaign-summary economics next to
   * open detailed rules. First-ever failures (no detailed history) keep the existing
   * campaign-level fallback behaviour.
   */
  async resolveDetailedPrecedence({ networkSource, sourceAccountLabel = "default", byCampaign = new Map() }, client = null) {
    const candidatesByCampaign = this.planCandidates({ networkSource, sourceAccountLabel, byCampaign });
    const currentDetailedCampaignIds = new Set();
    const currentEmptyCampaignIds = new Set();
    for (const [campaignId, candidates] of candidatesByCampaign) {
      if (candidates.length) currentDetailedCampaignIds.add(String(campaignId));
      else currentEmptyCampaignIds.add(String(campaignId));
    }

    const existingOpenDetailedCampaignIds = await this.loadOpenDetailedCampaignIds(
      { networkSource, sourceAccountLabel },
      client,
    );

    const entries = byCampaign instanceof Map ? [...byCampaign.entries()] : Object.entries(byCampaign ?? {});
    const failedCampaignIds = new Set(
      entries.filter(([, outcome]) => outcome && outcome.status !== "SUCCESS").map(([campaignId]) => String(campaignId)),
    );

    const protectedCampaignIds = new Set([...currentDetailedCampaignIds, ...existingOpenDetailedCampaignIds]);
    const retryRequiredCampaignIds = [...failedCampaignIds].filter((id) => existingOpenDetailedCampaignIds.has(id));
    const firstEverFailureCampaignIds = [...failedCampaignIds].filter((id) => !existingOpenDetailedCampaignIds.has(id));
    const emptyWithOpenRulesCampaignIds = [...currentEmptyCampaignIds].filter((id) => existingOpenDetailedCampaignIds.has(id));

    return {
      candidatesByCampaign,
      currentDetailedCampaignIds,
      existingOpenDetailedCampaignIds,
      protectedCampaignIds,
      retryRequiredCampaignIds,
      firstEverFailureCampaignIds,
      emptyWithOpenRulesCampaignIds,
    };
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
  async persistFetchedGroups({
    networkSource,
    sourceAccountLabel = "default",
    byCampaign,
    fetchedAt = null,
    syncRunId = null,
    existingOpenDetailedCampaignIds = null,
  }) {
    const entries = byCampaign instanceof Map ? [...byCampaign.entries()] : Object.entries(byCampaign ?? {});
    const previouslyDetailed =
      existingOpenDetailedCampaignIds ??
      (await this.loadOpenDetailedCampaignIds({ networkSource, sourceAccountLabel }));
    const summary = {
      campaignsFetched: 0,
      campaignsFailed: 0,
      campaignsWithDetailedRules: 0,
      campaignsUnlinked: 0,
      /** Previously detailed campaigns whose fetch failed: detail incomplete, retry required. */
      campaignsDetailRetryRequired: [],
      /** Successful HTTP response with zero groups while open detailed rules exist: fail closed. */
      campaignsEmptyResponseVerifyLive: [],
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
        if (previouslyDetailed.has(String(campaignId))) {
          summary.campaignsDetailRetryRequired.push(String(campaignId));
        }
        continue;
      }
      summary.campaignsFetched += 1;
      const groups = Array.isArray(outcome.groups) ? outcome.groups : [];
      if (!groups.length && previouslyDetailed.has(String(campaignId))) {
        // Optimise's meaning of an empty commission-group list is not proven live. Keep the
        // open detailed rules untouched, record the evidence, and surface VERIFY_LIVE.
        summary.campaignsEmptyResponseVerifyLive.push(String(campaignId));
        summary.campaigns.push({
          sourceCampaignId: String(campaignId),
          status: "EMPTY_RESPONSE_VERIFY_LIVE",
          candidateCount: 0,
          persisted: 0,
          supersededSummaryRules: 0,
          reason: "empty_commission_group_response_with_open_detailed_rules",
        });
        continue;
      }
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
