/**
 * Optimise detailed commission groups — campaign-scoped source object.
 *
 * GET /campaigns/{campaignId}/commission-groups is not a global paginated list: it is
 * one request per applicable campaign. Requests run sequentially through the shared
 * Optimise rate limiter (never an unbounded Promise.all). Every campaign's outcome is
 * kept (success/failure with campaignId) so the sync report can state campaigns
 * inspected, requests attempted/succeeded/failed, and groups fetched.
 */

import { prisma } from "../database/prisma.js";
import { mapOptimisePublisherRelationship } from "../modules/supplier/mappers/optimise.mapper.js";
import { extractUpstreamErrorMessage } from "../core/httpClient.js";
import { fetchOptimiseSourceObject } from "./sourceObjectRuns.js";

export const OPTIMISE_COMMISSION_GROUPS_RESOURCE = "commissionGroups";
export const OPTIMISE_COMMISSION_GROUPS_SOURCE_OBJECT = "commission_groups";

export function optimiseCommissionGroupSyncConfig(env = process.env) {
  const enabledRaw = String(env.OPTIMISE_COMMISSION_GROUPS_ENABLED ?? "true").trim().toLowerCase();
  const scopeRaw = String(env.OPTIMISE_COMMISSION_GROUPS_SCOPE ?? "joined").trim().toLowerCase();
  const maxRaw = Number(env.OPTIMISE_COMMISSION_GROUPS_MAX_CAMPAIGNS ?? 200);
  return {
    enabled: !["false", "0", "no", "off"].includes(enabledRaw),
    scope: scopeRaw === "all" ? "all" : "joined",
    maxCampaigns: Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 200,
  };
}

function campaignIdOf(raw = {}) {
  const value = raw?.id ?? raw?.campaignId ?? raw?.productId ?? raw?.legacyId ?? raw?.campaign_id;
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || /[\\/\s?#]/.test(text)) return null;
  return text;
}

/**
 * Select the campaigns whose commission groups are requested.
 * scope=joined (default): only campaigns whose publisher relationship is verified JOINED.
 * scope=all: every campaign with a safe id. Duplicates are collapsed; a cap bounds requests.
 */
export function selectOptimiseCommissionGroupCampaigns(campaignRows = [], { scope = "joined", maxCampaigns = 200 } = {}) {
  const selected = [];
  const seen = new Set();
  let skippedNoId = 0;
  let skippedByScope = 0;
  let skippedDuplicate = 0;
  let skippedByCap = 0;

  for (const raw of Array.isArray(campaignRows) ? campaignRows : []) {
    const campaignId = campaignIdOf(raw);
    if (!campaignId) {
      skippedNoId += 1;
      continue;
    }
    if (seen.has(campaignId)) {
      skippedDuplicate += 1;
      continue;
    }
    if (scope === "joined") {
      const relationship = mapOptimisePublisherRelationship(raw ?? {});
      if (relationship?.isJoined !== true) {
        skippedByScope += 1;
        continue;
      }
    }
    seen.add(campaignId);
    if (selected.length >= maxCampaigns) {
      skippedByCap += 1;
      continue;
    }
    selected.push({ campaignId, currency: campaignCurrencyOf(raw) });
  }

  return {
    campaigns: selected,
    campaignsInspected: Array.isArray(campaignRows) ? campaignRows.length : 0,
    skippedNoId,
    skippedByScope,
    skippedDuplicate,
    skippedByCap,
  };
}

function campaignCurrencyOf(raw = {}) {
  const value =
    raw?.currencyCode ?? raw?.currency_code ?? raw?.commissionCurrency ?? raw?.currency ?? raw?.currencySymbol ?? null;
  if (value == null || value === "") return null;
  const code = String(typeof value === "object" ? value.code ?? value.currencyCode ?? "" : value)
    .trim()
    .toUpperCase()
    .slice(0, 3);
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function failureRecord(campaignId, error) {
  return {
    campaignId,
    httpStatus: error?.response?.status ?? null,
    code: error?.code ?? null,
    message: extractUpstreamErrorMessage(error?.response?.data) || error?.message || String(error),
  };
}

/**
 * Sequentially fetch commission groups for the selected campaigns.
 * @returns {{ rows: object[], byCampaign: Map<string, object>, campaignScope: object }}
 */
export async function fetchOptimiseCommissionGroups({ adapter, campaigns = [], onCampaign = null }) {
  const rows = [];
  const byCampaign = new Map();
  const failures = [];
  let requestsSucceeded = 0;
  let groupsFetched = 0;

  for (const { campaignId, currency = null } of campaigns) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await adapter.fetchCommissionGroups(campaignId);
      const groups = Array.isArray(result?.groups) ? result.groups : [];
      requestsSucceeded += 1;
      groupsFetched += groups.length;
      byCampaign.set(campaignId, {
        status: "SUCCESS",
        groups,
        currency,
        fetchedAt: result?.fetchedAt ?? new Date(),
        httpStatus: result?.httpStatus ?? null,
        envelopeKind: result?.envelopeKind ?? null,
      });
      groups.forEach((group, index) => {
        rows.push({
          ...(group && typeof group === "object" ? group : { value: group }),
          campaignId: group?.campaignId ?? campaignId,
          sourceCampaignId: campaignId,
          record_source: "commission_group",
          sourceIndex: index,
        });
      });
    } catch (error) {
      const failure = failureRecord(campaignId, error);
      failures.push(failure);
      byCampaign.set(campaignId, { status: "FAILED", groups: [], currency, error: failure });
    }
    if (typeof onCampaign === "function") onCampaign(campaignId, byCampaign.get(campaignId));
  }

  return {
    rows,
    byCampaign,
    campaignScope: {
      requestsAttempted: campaigns.length,
      requestsSucceeded,
      requestsFailed: failures.length,
      groupsFetched,
      failures,
    },
  };
}

/**
 * Campaign ids from already-staged campaign entities (used when the campaign list was
 * not refreshed in this run, e.g. `sourceObject=commission_groups` requests).
 */
export async function loadStagedOptimiseCampaignRows({ networkSource, sourceAccountKey = null, db = prisma }) {
  const where = { networkSource, entityType: "campaign" };
  if (sourceAccountKey && sourceAccountKey !== "default") {
    where.externalId = { startsWith: `${sourceAccountKey}:` };
  } else {
    where.NOT = { externalId: { contains: ":" } };
  }
  const entities = await db.entity.findMany({ where, select: { rawData: true } });
  return entities.map((entity) => entity.rawData).filter(Boolean);
}

/**
 * Run the commission-groups source object for one Optimise account.
 * Returns the same result shape as other Optimise resources plus `campaignScope`
 * and `byCampaign` so the sync can persist evidence and plan rule precedence.
 */
export async function fetchOptimiseCommissionGroupSourceObject({
  adapter,
  credentials,
  campaignRows = [],
  ctx = {},
  config = optimiseCommissionGroupSyncConfig(),
}) {
  const selection = selectOptimiseCommissionGroupCampaigns(campaignRows, config);
  let fetched = null;

  const result = await fetchOptimiseSourceObject(
    OPTIMISE_COMMISSION_GROUPS_RESOURCE,
    credentials,
    async () => {
      fetched = await fetchOptimiseCommissionGroups({ adapter, campaigns: selection.campaigns });
      const scope = fetched.campaignScope;
      if (scope.requestsAttempted > 0 && scope.requestsSucceeded === 0) {
        const error = new Error(
          `All ${scope.requestsAttempted} Optimise campaign commission-group requests failed: ${scope.failures[0]?.message ?? "unknown error"}`,
        );
        error.code = "optimise_commission_groups_all_requests_failed";
        error.response = scope.failures[0]?.httpStatus ? { status: scope.failures[0].httpStatus } : undefined;
        throw error;
      }
      return fetched.rows;
    },
    {},
    ctx,
  );

  const campaignScope = {
    campaignsInspected: selection.campaignsInspected,
    campaignsSelected: selection.campaigns.length,
    skippedNoId: selection.skippedNoId,
    skippedByScope: selection.skippedByScope,
    skippedDuplicate: selection.skippedDuplicate,
    skippedByCap: selection.skippedByCap,
    scope: config.scope,
    maxCampaigns: config.maxCampaigns,
    requestsAttempted: fetched?.campaignScope.requestsAttempted ?? 0,
    requestsSucceeded: fetched?.campaignScope.requestsSucceeded ?? 0,
    requestsFailed: fetched?.campaignScope.requestsFailed ?? 0,
    groupsFetched: fetched?.campaignScope.groupsFetched ?? 0,
    failures: fetched?.campaignScope.failures ?? [],
  };

  return {
    ...result,
    rows: result.skipped ? [] : fetched?.rows ?? [],
    byCampaign: result.skipped || result.error ? new Map() : fetched?.byCampaign ?? new Map(),
    campaignScope: result.skipped ? { ...campaignScope, skipped: true } : campaignScope,
  };
}
