/**
 * Persist Boostiny payouts[].groups[] into the canonical SupplierCommissionRule[] /
 * SupplierCommissionCondition[] architecture.
 *
 * RAW campaign row → Boostiny payout-group normalizer → SupplierCommissionRuleService
 * .upsertNormalizedFact (historical versioning, idempotent on identical economics).
 *
 * Precedence: a campaign whose row carries payouts[].groups[] is normalized here, one rule per
 * group, and its campaign-summary fan-out rules (the generic sourcePath "commission" rules that
 * read the same payouts through the flattening parser) are closed as superseded so the same
 * supplier payout is never represented twice. Campaigns without payout groups keep the existing
 * campaign-summary behaviour untouched.
 *
 * Nothing here selects a payable winner, computes client commission or touches settlement.
 */

import { prisma } from "../../database/prisma.js";
import { parseNetworkSource } from "../supplier/entityIdentity.js";
import {
  BOOSTINY_PAYOUT_GROUP_SOURCE_OBJECT,
  BOOSTINY_SUMMARY_FAN_OUT_SOURCE_PATH,
  boostinyCampaignId,
  campaignHasPayoutGroups,
  mapBoostinyPayoutGroupCandidates,
} from "./boostinyPayoutGroup.mapper.js";
import { SupplierCommissionRuleService, sameRuleEconomics } from "./services/supplierCommissionRule.service.js";

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameDate(a, b) {
  const left = validDate(a);
  const right = validDate(b);
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.getTime() === right.getTime();
}

function normalizeCurrency(value) {
  return value ? String(value).slice(0, 3).toUpperCase() : null;
}

export class BoostinyCommissionPersistenceService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.ruleService = deps.ruleService ?? new SupplierCommissionRuleService({ prisma: this.db });
    this.now = deps.now ?? (() => new Date());
  }

  /** Source campaign ids whose rows carry payouts[].groups[] — the campaigns normalized here. */
  campaignIdsWithPayoutGroups(campaigns = []) {
    const ids = new Set();
    for (const raw of Array.isArray(campaigns) ? campaigns : []) {
      const id = boostinyCampaignId(raw);
      if (id && campaignHasPayoutGroups(raw)) ids.add(id);
    }
    return ids;
  }

  async resolveSupplierCampaign({ networkSource = "boostiny", sourceAccountLabel, sourceCampaignId }, client = null) {
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
   * The effective window the rule service should version this candidate under.
   *
   * The supplier's payout start_date is the rule's effectiveFrom. When the supplier changes a
   * group's value WITHOUT moving start_date, the open version and the new economics would share
   * one (outcomeKey, effectiveFrom) — an identity the schema keeps unique. The successor is then
   * versioned from the observation time instead, the prior version is closed at that instant by
   * the rule service, and the supplier's own start_date stays in metadata. History is never
   * overwritten.
   */
  async resolveVersionWindow(candidate, { sourceAccountLabel, evidenceAt }, client = null) {
    const db = client ?? this.db;
    const supplierStart = validDate(candidate.effectiveFrom);
    if (!supplierStart || !db?.supplierCommissionRule?.findMany) {
      return { effectiveFrom: candidate.effectiveFrom, effectiveFromSource: supplierStart ? "SUPPLIER_START_DATE" : "OBSERVED" };
    }
    const versions = await db.supplierCommissionRule.findMany({
      where: { supplier: "BOOSTINY", sourceAccountLabel, outcomeKey: candidate.outcomeKey },
    });
    const openAtSupplierStart = (versions ?? []).find(
      (row) => row.effectiveUntil == null && sameDate(row.effectiveFrom, supplierStart),
    );
    if (
      openAtSupplierStart &&
      !sameRuleEconomics(openAtSupplierStart, candidate, normalizeCurrency(candidate.currency)) &&
      evidenceAt.getTime() > supplierStart.getTime()
    ) {
      return { effectiveFrom: evidenceAt, effectiveFromSource: "OBSERVED_CHANGE" };
    }
    return { effectiveFrom: candidate.effectiveFrom, effectiveFromSource: "SUPPLIER_START_DATE" };
  }

  /** Persist the candidates of one campaign row and close its superseded summary rules. */
  async persistCampaign(
    { networkSource = "boostiny", sourceAccountLabel = "default", raw, fetchedAt = null, syncRunId = null, rawPayloadId = null },
    client = null,
  ) {
    const db = client ?? this.db;
    const evidenceAt = validDate(fetchedAt) ?? this.now();
    const sourceCampaignId = boostinyCampaignId(raw);
    const supplierCampaign = sourceCampaignId
      ? await this.resolveSupplierCampaign({ networkSource, sourceAccountLabel, sourceCampaignId }, db)
      : null;
    const campaignSourceId = supplierCampaign?.campaignSources?.[0]?.id ?? null;

    const candidates = mapBoostinyPayoutGroupCandidates(raw, {
      networkSource,
      sourceAccountLabel,
      supplierCampaignId: supplierCampaign?.id ?? null,
      campaignSourceId,
      fetchedAt: evidenceAt,
    });

    let persisted = 0;
    let financeReady = 0;
    let reviewRequired = 0;
    const ruleIds = [];

    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const window = await this.resolveVersionWindow(candidate, { sourceAccountLabel, evidenceAt }, db);
      // eslint-disable-next-line no-await-in-loop
      const row = await this.ruleService.upsertNormalizedFact(
        {
          ...candidate,
          effectiveFrom: window.effectiveFrom,
          supplierCampaignId: supplierCampaign?.id ?? null,
          campaignSourceId,
          sourceAccountLabel,
          sourceEvidenceAt: evidenceAt,
          rawPayloadId: rawPayloadId ?? null,
          metadata: {
            ...(candidate.metadata ?? {}),
            effectiveFromSource: window.effectiveFromSource,
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
    if (persisted > 0 && sourceCampaignId) {
      supersededSummaryRules = await this.closeSupersededCampaignSummaryRules(
        { sourceAccountLabel, sourceCampaignId, closedAt: evidenceAt },
        db,
      );
    }

    return {
      sourceCampaignId,
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
   * Close open campaign-summary rules (generic fan-out, sourcePath "commission") for a campaign
   * that now carries payout-group rules. Closing (effectiveUntil) is the versioning primitive —
   * history is preserved, nothing is deleted or overwritten. Payout-group rules themselves are
   * never touched here: they carry a different sourcePath.
   */
  async closeSupersededCampaignSummaryRules({ sourceAccountLabel = "default", sourceCampaignId, closedAt }, client = null) {
    const db = client ?? this.db;
    if (!db?.supplierCommissionRule?.updateMany) return 0;
    const result = await db.supplierCommissionRule.updateMany({
      where: {
        supplier: "BOOSTINY",
        sourceAccountLabel,
        sourceObject: BOOSTINY_PAYOUT_GROUP_SOURCE_OBJECT,
        sourcePath: BOOSTINY_SUMMARY_FAN_OUT_SOURCE_PATH,
        effectiveUntil: null,
        outcomeKey: { startsWith: `${String(sourceCampaignId)}::` },
        effectiveFrom: { lt: closedAt },
      },
      data: { effectiveUntil: closedAt },
    });
    return result?.count ?? 0;
  }

  /**
   * Persist every campaign row that carries payout groups. Rows without them are counted and
   * left to the existing campaign-summary behaviour. A failure on one campaign is reported and
   * never blocks the others.
   */
  async persistCampaigns({ networkSource = "boostiny", sourceAccountLabel = "default", campaigns = [], fetchedAt = null, syncRunId = null }) {
    const summary = {
      campaignsSeen: 0,
      campaignsWithPayoutGroups: 0,
      campaignsWithoutPayoutGroups: 0,
      campaignsUnlinked: 0,
      rulesPersisted: 0,
      financeReady: 0,
      reviewRequired: 0,
      supersededSummaryRules: 0,
      persistErrors: [],
      campaigns: [],
    };

    for (const raw of Array.isArray(campaigns) ? campaigns : []) {
      if (!raw || typeof raw !== "object") continue;
      summary.campaignsSeen += 1;
      if (!campaignHasPayoutGroups(raw)) {
        summary.campaignsWithoutPayoutGroups += 1;
        continue;
      }
      summary.campaignsWithPayoutGroups += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await this.persistCampaign({ networkSource, sourceAccountLabel, raw, fetchedAt, syncRunId });
        summary.rulesPersisted += result.persisted;
        summary.financeReady += result.financeReady;
        summary.reviewRequired += result.reviewRequired;
        summary.supersededSummaryRules += result.supersededSummaryRules;
        if (result.persisted > 0 && !result.linked) summary.campaignsUnlinked += 1;
        summary.campaigns.push(result);
      } catch (error) {
        summary.persistErrors.push({
          campaignId: boostinyCampaignId(raw),
          message: error?.message || String(error),
        });
      }
    }

    return summary;
  }
}
