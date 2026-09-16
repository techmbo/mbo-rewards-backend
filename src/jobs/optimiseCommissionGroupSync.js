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

/**
 * The identifier GET /campaigns/{campaignId}/commission-groups requires.
 *
 * Optimise campaign rows carry several identifier namespaces, and live certification
 * plus the production identifier audit proved they are NOT interchangeable:
 *   productId  → GET /campaigns/{productId}                    (campaign detail)
 *   campaignId → GET /campaigns/{campaignId}/commission-groups
 * Only an explicit campaignId (or its snake_case form, campaign_id) may be dispatched
 * here. `id`, `productId` and `legacyId` are never used as a fallback: a row without an
 * explicit campaignId is skipped (skippedNoId) rather than requested under a foreign
 * identifier. This is request selection only — persisted campaign identity
 * (resolveOptimiseCampaignId / SupplierCampaign.supplierCampaignId) is untouched.
 */
export function optimiseCommissionGroupCampaignId(raw = {}) {
  return commissionGroupCampaignIdOf(raw);
}

function commissionGroupCampaignIdOf(raw = {}) {
  for (const value of [raw?.campaignId, raw?.campaign_id]) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    return /[\\/\s?#]/.test(text) ? null : text;
  }
  return null;
}

/**
 * Select the campaigns whose commission groups are requested.
 * scope=joined (default): only campaigns whose publisher relationship is verified JOINED.
 * scope=all: every campaign with a safe explicit campaignId. Duplicates are collapsed;
 * a cap bounds requests.
 */
export function selectOptimiseCommissionGroupCampaigns(campaignRows = [], { scope = "joined", maxCampaigns = 200 } = {}) {
  const selected = [];
  const seen = new Set();
  let skippedNoId = 0;
  let skippedByScope = 0;
  let skippedDuplicate = 0;
  let skippedByCap = 0;

  for (const raw of Array.isArray(campaignRows) ? campaignRows : []) {
    const campaignId = commissionGroupCampaignIdOf(raw);
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

/**
 * Campaigns per bounded commission-group unit.
 *
 * GET /campaigns/{campaignId}/commission-groups is one request per campaign, and the Optimise
 * client limiter holds requests 12.5 s apart (OPTIMISE_MIN_INTERVAL_MS). Eight campaigns is
 * therefore ~100 s of supplier time before the unit's own persistence work, comfortably inside a
 * serverless invocation with room for a slow response and the rule writes. Ten would be ~125 s and
 * still fit, but leaves less margin for the per-campaign SupplierCommissionRule persistence that
 * follows each fetch, so the conservative end of the range is used.
 */
export const OPTIMISE_COMMISSION_GROUP_CHUNK_SIZE = 8;

/**
 * Narrow campaign rows to the slice a bounded commission-group unit names.
 *
 * Identity comes from the SAME extractor the request path uses, so a chunk cannot select a
 * campaign under a foreign identifier, and a row whose id is not in the slice is dropped outright
 * — that is what keeps two chunks of one account from requesting the same campaign twice.
 */
export function filterCampaignRowsToChunk(campaignRows = [], campaignIds = null) {
  if (!Array.isArray(campaignIds) || !campaignIds.length) return Array.isArray(campaignRows) ? campaignRows : [];
  const wanted = new Set(campaignIds.map((id) => String(id ?? "").trim()).filter(Boolean));
  return (Array.isArray(campaignRows) ? campaignRows : []).filter((row) =>
    wanted.has(String(commissionGroupCampaignIdOf(row) ?? "")),
  );
}

/** Split ids into fixed-size chunks, in order. No id is dropped and none appears twice. */
export function chunkCommissionGroupCampaignIds(campaignIds = [], size = OPTIMISE_COMMISSION_GROUP_CHUNK_SIZE) {
  const step = Math.max(1, Math.floor(Number(size) || OPTIMISE_COMMISSION_GROUP_CHUNK_SIZE));
  const chunks = [];
  for (let index = 0; index < campaignIds.length; index += step) {
    chunks.push(campaignIds.slice(index, index + step));
  }
  return chunks;
}

/**
 * The campaign ids a commission-group run would request, in a STABLE order.
 *
 * Rows are ordered by campaign id BEFORE selection, so the `maxCampaigns` cap and the resulting
 * chunk boundaries do not depend on the order the staging table happens to return. Selection
 * itself is the existing one — same scope rule, same cap, same id extraction — so a chunked run
 * covers exactly the campaigns a single account-wide run would have covered.
 */
export function orderedCommissionGroupCampaignIds(campaignRows = [], config = optimiseCommissionGroupSyncConfig()) {
  const rows = (Array.isArray(campaignRows) ? [...campaignRows] : []).sort((a, b) => {
    const left = commissionGroupCampaignIdOf(a) ?? "";
    const right = commissionGroupCampaignIdOf(b) ?? "";
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const selection = selectOptimiseCommissionGroupCampaigns(rows, config);
  return {
    campaignIds: selection.campaigns.map((campaign) => campaign.campaignId),
    campaignsInspected: selection.campaignsInspected,
    skippedByCap: selection.skippedByCap,
  };
}

/**
 * Bounded commission-group units for one Optimise account, from the campaigns ALREADY STAGED by
 * this run's campaigns unit. Discovery is therefore a single indexed read of rows the run has
 * just written — never a supplier fan-out — which is why the chunks can only be planned once the
 * campaigns unit has completed.
 */
export async function planOptimiseCommissionGroupChunks({
  platform,
  accountLabel = "default",
  db = prisma,
  config = optimiseCommissionGroupSyncConfig(),
  chunkSize = OPTIMISE_COMMISSION_GROUP_CHUNK_SIZE,
} = {}) {
  if (!config.enabled) return { chunks: [], campaignIds: [], chunkSize, reason: "disabled" };
  const rows = await loadStagedOptimiseCampaignRows({
    networkSource: platform,
    sourceAccountKey: accountLabel,
    db,
  });
  const { campaignIds, campaignsInspected, skippedByCap } = orderedCommissionGroupCampaignIds(rows, config);
  const chunks = chunkCommissionGroupCampaignIds(campaignIds, chunkSize).map((ids, index) => ({
    index,
    campaignIds: ids,
  }));
  return { chunks, campaignIds, campaignsInspected, skippedByCap, chunkSize };
}
