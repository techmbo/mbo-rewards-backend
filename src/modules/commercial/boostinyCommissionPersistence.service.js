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
  boostinyCampaignOutcomeKeyPrefix,
  campaignHasPayoutGroups,
  mapBoostinyPayoutGroupCandidates,
} from "./boostinyPayoutGroup.mapper.js";
import { canonicalConditionSignature } from "./supplierCommissionReadiness.js";
import { SupplierCommissionRuleService, sameRuleEconomics } from "./services/supplierCommissionRule.service.js";

/** Every payout-group rule carries a sourcePath under payouts[]; the summary fan-out does not. */
const PAYOUT_GROUP_SOURCE_PATH_PREFIX = "payouts[";

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

/**
 * Whether two versions of one outcome describe the same supplier rule. Economics through the
 * rule service's own comparison; qualifiers (every child condition, the MBO gate included) and
 * supplier precedence on top, because the rule service does not version on those alone.
 */
export function sameBoostinyRuleVersion(row, candidate) {
  return (
    sameRuleEconomics(row, candidate, normalizeCurrency(candidate.currency)) &&
    canonicalConditionSignature(row.conditions ?? []) === canonicalConditionSignature(candidate.conditions ?? []) &&
    (row.priority == null ? null : Number(row.priority)) === (candidate.priority == null ? null : Number(candidate.priority))
  );
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
   * First version: the supplier's payout start_date (or, without one, the observation time the
   * rule service falls back to). Re-sync with nothing material changed: the open version's own
   * effectiveFrom, so the rule service finds that exact version and updates it in place —
   * idempotent. Material change (economics, any qualifier, priority): a successor versioned from
   * the observation time, strictly after the open version so the rule service closes that prior
   * version at the same instant — never two open versions, never an overwrite. The supplier's
   * own start_date stays in metadata either way.
   */
  async resolveVersionWindow(candidate, { sourceAccountLabel, evidenceAt }, client = null) {
    const db = client ?? this.db;
    const supplierStart = validDate(candidate.effectiveFrom);
    const firstVersion = { effectiveFrom: candidate.effectiveFrom, effectiveFromSource: supplierStart ? "SUPPLIER_START_DATE" : "OBSERVED" };
    if (!db?.supplierCommissionRule?.findMany) return firstVersion;
    const versions = await db.supplierCommissionRule.findMany({
      where: { supplier: "BOOSTINY", sourceAccountLabel, outcomeKey: candidate.outcomeKey },
      include: { conditions: true },
    });
    const open = (versions ?? []).find((row) => row.effectiveUntil == null);
    if (!open) return firstVersion;
    if (sameBoostinyRuleVersion(open, candidate)) {
      return {
        effectiveFrom: open.effectiveFrom,
        effectiveFromSource: open.metadata?.effectiveFromSource ?? (supplierStart ? "SUPPLIER_START_DATE" : "OBSERVED"),
      };
    }
    const openFrom = validDate(open.effectiveFrom)?.getTime() ?? 0;
    return {
      effectiveFrom: new Date(Math.max(evidenceAt.getTime(), openFrom + 1000)),
      effectiveFromSource: "OBSERVED_CHANGE",
    };
  }

  /**
   * Close open payout-group rules of one campaign whose outcome the supplier no longer lists.
   *
   * Closing (effectiveUntil) is the existing rule-history primitive; nothing is deleted. Only
   * rules of THIS campaign, carrying a payouts[] sourcePath, are candidates; summary fan-out rules
   * and other suppliers are never touched. A rule that had not yet become effective is closed at
   * its own effectiveFrom, so it never reads as having been active.
   */
  async closeStalePayoutGroupRules({ sourceAccountLabel = "default", sourceCampaignId, activeOutcomeKeys, closedAt }, client = null) {
    const db = client ?? this.db;
    if (!db?.supplierCommissionRule?.findMany || !db?.supplierCommissionRule?.update) return 0;
    const active = new Set(activeOutcomeKeys ?? []);
    const open = await db.supplierCommissionRule.findMany({
      where: {
        supplier: "BOOSTINY",
        sourceAccountLabel,
        sourceObject: BOOSTINY_PAYOUT_GROUP_SOURCE_OBJECT,
        sourcePath: { startsWith: PAYOUT_GROUP_SOURCE_PATH_PREFIX },
        effectiveUntil: null,
        outcomeKey: { startsWith: boostinyCampaignOutcomeKeyPrefix(sourceCampaignId) },
      },
    });
    let closed = 0;
    for (const row of open ?? []) {
      if (active.has(row.outcomeKey)) continue;
      const from = validDate(row.effectiveFrom);
      const effectiveUntil = from && from.getTime() > closedAt.getTime() ? from : closedAt;
      // eslint-disable-next-line no-await-in-loop
      await db.supplierCommissionRule.update({
        where: { id: row.id },
        data: {
          effectiveUntil,
          metadata: { ...(row.metadata ?? {}), closedReason: "supplier_payout_group_no_longer_listed", closedAt: closedAt.toISOString() },
        },
      });
      closed += 1;
    }
    return closed;
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
    const activeOutcomeKeys = candidates.map((candidate) => candidate.outcomeKey);

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
    let staleRulesClosed = 0;
    if (persisted > 0 && sourceCampaignId) {
      supersededSummaryRules = await this.closeSupersededCampaignSummaryRules(
        { sourceAccountLabel, sourceCampaignId, closedAt: evidenceAt },
        db,
      );
      staleRulesClosed = await this.closeStalePayoutGroupRules(
        { sourceAccountLabel, sourceCampaignId, activeOutcomeKeys, closedAt: evidenceAt },
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
      staleRulesClosed,
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
   * READ-ONLY plan for one campaign row: what a live persist would do, without doing it.
   *
   * The same candidates, the same version comparison and the same closure queries as
   * persistCampaign — but every write is replaced by a count. Nothing here calls the rule service,
   * update, updateMany or a transaction. Only aggregates leave: no campaign name, payout value,
   * commission value, condition, coupon or raw fragment.
   */
  async planCampaign({ networkSource = "boostiny", sourceAccountLabel = "default", raw, fetchedAt = null }, client = null) {
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

    const plan = { candidates: candidates.length, wouldCreate: 0, wouldReuse: 0, wouldVersion: 0, financeReady: 0, reviewRequired: 0 };
    for (const candidate of candidates) {
      if (candidate.mappingStatus === "VERIFIED") plan.financeReady += 1;
      else plan.reviewRequired += 1;
      // eslint-disable-next-line no-await-in-loop
      const versions = await db.supplierCommissionRule.findMany({
        where: { supplier: "BOOSTINY", sourceAccountLabel, outcomeKey: candidate.outcomeKey },
        include: { conditions: true },
      });
      const open = (versions ?? []).find((row) => row.effectiveUntil == null);
      if (!open) plan.wouldCreate += 1;
      else if (sameBoostinyRuleVersion(open, candidate)) plan.wouldReuse += 1;
      else plan.wouldVersion += 1;
    }

    let wouldCloseStale = 0;
    let wouldCloseSummary = 0;
    if (candidates.length && sourceCampaignId) {
      const active = new Set(candidates.map((candidate) => candidate.outcomeKey));
      const openGroupRules = await db.supplierCommissionRule.findMany({
        where: {
          supplier: "BOOSTINY",
          sourceAccountLabel,
          sourceObject: BOOSTINY_PAYOUT_GROUP_SOURCE_OBJECT,
          sourcePath: { startsWith: PAYOUT_GROUP_SOURCE_PATH_PREFIX },
          effectiveUntil: null,
          outcomeKey: { startsWith: boostinyCampaignOutcomeKeyPrefix(sourceCampaignId) },
        },
      });
      wouldCloseStale = (openGroupRules ?? []).filter((row) => !active.has(row.outcomeKey)).length;
      const openSummaryRules = await db.supplierCommissionRule.findMany({
        where: {
          supplier: "BOOSTINY",
          sourceAccountLabel,
          sourceObject: BOOSTINY_PAYOUT_GROUP_SOURCE_OBJECT,
          sourcePath: BOOSTINY_SUMMARY_FAN_OUT_SOURCE_PATH,
          effectiveUntil: null,
          outcomeKey: { startsWith: `${String(sourceCampaignId)}::` },
          effectiveFrom: { lt: evidenceAt },
        },
      });
      wouldCloseSummary = (openSummaryRules ?? []).length;
    }

    return {
      sourceCampaignId,
      linked: Boolean(campaignSourceId),
      ...plan,
      wouldCloseStale,
      wouldCloseSummary,
    };
  }

  /** READ-ONLY plan over campaign rows; the aggregate shape a dry run reports. */
  async planCampaigns({ networkSource = "boostiny", sourceAccountLabel = "default", campaigns = [], fetchedAt = null }) {
    const summary = {
      dryRun: true,
      campaignsSeen: 0,
      campaignsWithPayoutGroups: 0,
      campaignsWithoutPayoutGroups: 0,
      campaignsUnlinked: 0,
      candidates: 0,
      wouldCreate: 0,
      wouldReuse: 0,
      wouldVersion: 0,
      wouldCloseStale: 0,
      wouldCloseSummary: 0,
      financeReady: 0,
      reviewRequired: 0,
      persistErrors: [],
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
        const plan = await this.planCampaign({ networkSource, sourceAccountLabel, raw, fetchedAt });
        for (const key of ["candidates", "wouldCreate", "wouldReuse", "wouldVersion", "wouldCloseStale", "wouldCloseSummary", "financeReady", "reviewRequired"]) {
          summary[key] += plan[key];
        }
        if (plan.candidates > 0 && !plan.linked) summary.campaignsUnlinked += 1;
      } catch (error) {
        summary.persistErrors.push({ campaignId: boostinyCampaignId(raw), message: error?.message || String(error) });
      }
    }
    return summary;
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
      staleRulesClosed: 0,
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
        summary.staleRulesClosed += result.staleRulesClosed;
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
