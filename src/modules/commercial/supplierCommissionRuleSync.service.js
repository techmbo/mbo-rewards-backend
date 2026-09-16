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
import { runWithConcurrency } from "../../core/concurrency.js";

/**
 * How many commission-rule outcomes may be persisted at once.
 *
 * upsertNormalizedFact opens an interactive transaction whose reads and writes are filtered to a
 * single (supplier, sourceAccountLabel, outcomeKey). Two outcomes therefore never touch the same
 * rows, so persisting different outcomes concurrently cannot change any of them. Rules that share
 * an outcomeKey ARE each other's version history and stay strictly ordered.
 *
 * The bound is small because each in-flight transaction holds one pooled connection for its whole
 * span — a findMany plus one or two writes — and production runs a connection limit of 5. The
 * ceiling leaves headroom for the work that shares that pool during a sync: JobRun orchestration
 * writes, raw payload and entity persistence, account timestamp and lock queries, and logging.
 */
const RULE_CONCURRENCY_DEFAULT = 3;
const RULE_CONCURRENCY_CEILING = 4;

/**
 * Resolve a requested concurrency to a pool-safe one. An unset or unparseable value falls back to
 * the default, so the safe behaviour needs no environment variable; anything above the ceiling is
 * clamped rather than honoured, and anything below one becomes one.
 */
export function resolveRuleConcurrency(requested) {
  if (requested === undefined || requested === null || requested === "") {
    return RULE_CONCURRENCY_DEFAULT;
  }
  const value = Number(requested);
  if (!Number.isFinite(value)) return RULE_CONCURRENCY_DEFAULT;
  return Math.min(Math.max(Math.floor(value), 1), RULE_CONCURRENCY_CEILING);
}

export const SUPPLIER_COMMISSION_RULE_CONCURRENCY = resolveRuleConcurrency(
  process.env.SUPPLIER_COMMISSION_RULE_CONCURRENCY,
);

/**
 * A fixed number of permits, handed straight to the next waiter on release.
 *
 * A per-call limit would not bound the pool: a full sync runs three Optimise regions at once and
 * up to SYNC_ACCOUNT_CONCURRENCY accounts inside each, so several fan-outs can be in flight
 * together. The permits are module state, so the cap is what the whole process may hold at once.
 */
export function createPermitPool(size) {
  let available = Math.max(1, Math.floor(size));
  const waiting = [];
  return {
    async acquire() {
      if (available > 0) {
        available -= 1;
        return;
      }
      await new Promise((resolve) => waiting.push(resolve));
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else available += 1;
    },
    available: () => available,
  };
}

const rulePermits = createPermitPool(SUPPLIER_COMMISSION_RULE_CONCURRENCY);

/** Group rules by outcomeKey, preserving the order rules were fanned out in. */
export function groupRulesByOutcomeKey(rules) {
  const groups = new Map();
  for (const rule of rules) {
    const key = String(rule?.outcomeKey ?? "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rule);
  }
  return [...groups.values()];
}

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

export async function upsertCommissionRulesForPreparedCampaigns(
  {
    networkSource,
    preparedRecords = [],
    sourceAccountKey,
    /**
     * Campaign ids whose detailed supplier commission structure was ingested from a
     * dedicated endpoint (e.g. Optimise GET /campaigns/{id}/commission-groups) in this
     * sync. Their campaign-level summary commission (commissionCost, first group) stays
     * display evidence and must not be fanned out into duplicate canonical rules.
     */
    skipCampaignIds = null,
  },
  deps = {},
) {
  const db = deps.prisma ?? prisma;
  if (!preparedRecords.length) return { upserted: 0, skippedDetailedCampaigns: 0 };

  const { supplier, supplierRegion } = parseNetworkSource(networkSource);
  const { sourceAccountLabel } = parseSourceAccountLabel(sourceAccountKey ?? "default");
  const skip = new Set([...(skipCampaignIds ?? [])].map(String));
  const eligibleRecords = skip.size
    ? preparedRecords.filter((record) => {
        const campaignId = resolveCampaignId(record.originalPayload ?? {});
        return campaignId == null || !skip.has(String(campaignId));
      })
    : preparedRecords;
  const skippedDetailedCampaigns = preparedRecords.length - eligibleRecords.length;
  const embedded = collectEmbeddedCommissionRulesFromCampaigns(
    eligibleRecords.map((record) => ({ originalPayload: record.originalPayload })),
    { sourceObject: "campaigns" },
  );
  if (!embedded.length) return { upserted: 0, skippedDetailedCampaigns };

  const campaignIds = [
    ...new Set(
      eligibleRecords
        .map((record) => resolveCampaignId(record.originalPayload ?? {}))
        .filter(Boolean)
        .map(String),
    ),
  ];

  const supplierCampaigns = campaignIds.length
    ? await db.supplierCampaign.findMany({
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
    eligibleRecords
      .map((record) => [resolveCampaignId(record.originalPayload ?? {}), record])
      .filter(([campaignId]) => campaignId != null)
      .map(([campaignId, record]) => [String(campaignId), record]),
  );

  const ruleService = deps.ruleService ?? new SupplierCommissionRuleService({ prisma: db });
  let upserted = 0;

  const persistRule = async (rule) => {
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
        conditions: rule.conditions ?? [],
        outcomeKey: rule.outcomeKey,
        sourceObject: rule.sourceObject,
        sourcePath: rule.sourcePath,
        // Fan-out already assessed readiness (with source text); keep its decision.
        mappingStatus: rule.mappingStatus ?? null,
        fieldMappingOutcome: rule.fieldMappingOutcome ?? null,
        metadata: rule.metadata ?? null,
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
        ...(enriched.metadata ?? {}),
        brandName: sc?.merchantNameRaw ?? null,
        campaignName: sc?.campaignName ?? null,
        sourceCampaignId: campaignKey,
        sourceEffectiveFromProvided: Boolean(rule.effectiveFrom),
      },
    });

    upserted += 1;
  };

  // Independent outcomes run side by side; one outcome's versions stay in order. The permit pool
  // is what actually bounds pooled connections, because it is shared by every concurrent fan-out.
  const permits = deps.permits ?? rulePermits;
  await runWithConcurrency(
    groupRulesByOutcomeKey(embedded),
    resolveRuleConcurrency(deps.concurrency),
    async (group) => {
      await permits.acquire();
      try {
        for (const rule of group) {
          // eslint-disable-next-line no-await-in-loop
          await persistRule(rule);
        }
      } finally {
        permits.release();
      }
    },
  );

  return { upserted, skippedDetailedCampaigns };
}
