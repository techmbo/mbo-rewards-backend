import { createHash } from "node:crypto";
import { prisma } from "../../database/prisma.js";
import { logger } from "../../platform/logging/logger.js";
import { buildEventDateFilter } from "../../core/dateRange.js";
import { buildCouponKindPrismaWhere, normalizeCouponKindParam } from "../../core/couponKind.js";
import {
  buildEntityListOrderBy,
  buildEntityListWhere,
} from "../../core/entitySearch.js";
import { runWithConcurrency } from "../../core/concurrency.js";
import { logFieldUsageWarnings, validateFieldUsage } from "../../field-system/validateFieldUsage.js";
import { upsertCouponFromSync } from "../coupons/couponCms.service.js";
import { SYNC_UPSERT_CHUNK_SIZE, SYNC_UPSERT_CONCURRENCY } from "../../jobs/syncConfig.js";
import { resolveDbConcurrency } from "../../core/dbPermits.js";

/**
 * Coupon and offer rows are staged one row at a time, and each row's work is several Prisma calls,
 * so this fan-out is measured against the connection pool rather than against throughput.
 * SYNC_UPSERT_CONCURRENCY defaulted to 50, which put hundreds of calls in a queue served by five
 * connections and timed them out.
 */
const COUPON_ROW_CONCURRENCY = resolveDbConcurrency(SYNC_UPSERT_CONCURRENCY);
import { batchUpsertEntities } from "./batchEntityUpsert.js";
// The durable Entity-staging barrier. This module is the FINAL safety boundary: every supplier
// staging path funnels through the two entrypoints below, so a future sync path cannot bypass the
// freeze by forgetting a route-level check.
import { entityStagingBarrier } from "../../jobs/entityStagingBarrier.js";
import { normalizeEntity } from "./normalizers.js";
import {
  persistRawPayload,
  linkRawPayloadsToEntities,
  persistRawPayloadsForPreparedRecords,
  hashPayload,
} from "./rawPayload.service.js";
import { cloneRawJson } from "../networkOps/rawPayload.contract.js";
import { collectEmbeddedCouponsFromCampaigns } from "../coupons/couponVoucherFanOut.js";
import { upsertCommissionRulesForPreparedCampaigns } from "../commercial/supplierCommissionRuleSync.service.js";
import { runWithSourceEvidence } from "../networkOps/sourceEvidence.context.js";
import { rollupRawPayloadOutcomes } from "../networkOps/syncObservability.contract.js";
import { sourceObjectSync } from "../networkOps/sourceObjectSync.service.js";
import { resolveConversionEntityExternalId } from "../order/orderConversionIngestion.contract.js";

/** How much of a campaign name the readable part of a reporting id carries. */
const REPORTING_NAME_LIMIT = 80;

/**
 * Everything a reporting row was grouped by that the readable part of its id cannot carry.
 *
 * A reporting row is one supplier aggregate over the dimensions we asked for — for Optimise that
 * is campaignId, campaignName, advertiserName and date, plus invoiceDate on the invoice report.
 * The readable id holds only the report type, a truncated campaign name and ONE date, so three
 * kinds of distinct facts used to land on the same identity: two campaigns sharing a name, two
 * names sharing their first 80 characters, and an invoice row whose conversion date matches
 * another's but whose invoice date does not.
 *
 * Returns null when a row carries nothing beyond what the readable part already states, so ids
 * that were never ambiguous keep exactly the value they had.
 */
function reportingDiscriminator(rawData) {
  const parts = {};
  const campaignName = String(rawData.campaignName ?? "");

  const campaignId = rawData.campaignId ?? rawData.campaign_id ?? null;
  if (campaignId != null && String(campaignId).trim() !== "") {
    parts.campaignId = String(campaignId).trim();
  }
  const advertiserName = rawData.advertiserName ?? null;
  if (advertiserName != null && String(advertiserName).trim() !== "") {
    parts.advertiserName = String(advertiserName).trim();
  }
  // Only an extra dimension when the readable date key took `date`; an invoice-only row already
  // states its invoice date there.
  if (rawData.date && rawData.invoiceDate) {
    parts.invoiceDate = String(rawData.invoiceDate);
  }
  if (campaignName.length > REPORTING_NAME_LIMIT) {
    parts.campaignName = campaignName;
  }

  const keys = Object.keys(parts).sort();
  if (!keys.length) return null;
  return createHash("sha1")
    .update(JSON.stringify(keys.map((key) => [key, parts[key]])))
    .digest("hex")
    .slice(0, 12);
}

/**
 * Build the staging identity for one supplier row. Exported so identity rules can be tested
 * directly: a weak rule here collapses distinct supplier facts into one Entity.
 */
export function resolveExternalId(rawData, fallbackPrefix, index, entityType = null) {
  if (entityType === "conversion") {
    return resolveConversionEntityExternalId(rawData ?? {}, fallbackPrefix);
  }
  if (rawData?.invoiceId != null && rawData?.record_source === "invoice") {
    return `${fallbackPrefix}-${rawData.invoiceId}`;
  }

  if (rawData?.report_type === "summary" && rawData?.period_from && rawData?.period_to) {
    return `${fallbackPrefix}-summary-${rawData.period_from}-${rawData.period_to}`;
  }

  // Boostiny (and similar): real order_id must win over campaign+date aggregates.
  const orderId = rawData?.order_id ?? rawData?.orderId ?? rawData?.OrderId ?? null;
  if (orderId != null && String(orderId).trim() !== "") {
    const campaignId = rawData?.campaign_id ?? rawData?.campaignId ?? null;
    const oid = String(orderId).trim();
    return campaignId != null
      ? `${fallbackPrefix}-order-${campaignId}-${oid}`
      : `${fallbackPrefix}-order-${oid}`;
  }

  if (rawData?.campaign_id != null && (rawData?.date || rawData?.period_from)) {
    const dateKey = rawData.date || rawData.period_from;
    return `${fallbackPrefix}-campaign-${rawData.campaign_id}-${dateKey}`;
  }

  if (rawData?.conversionId != null) {
    return `${fallbackPrefix}-${rawData.conversionId}`;
  }

  if (rawData?.click_id != null && rawData?.id != null) {
    return `${fallbackPrefix}-${rawData.id}`;
  }

  if (rawData?.record_source === "commission_group") {
    const campaignId = rawData?.campaignId ?? rawData?.sourceCampaignId ?? "unknown-campaign";
    const groupId = rawData?.id ?? rawData?.commissionGroupId ?? rawData?.groupId ?? null;
    return groupId != null && String(groupId).trim() !== ""
      ? `${fallbackPrefix}-${campaignId}-${groupId}`
      : `${fallbackPrefix}-${campaignId}-index-${index}`;
  }

  if (rawData?.record_source === "deal" && rawData?.id != null) {
    return `${fallbackPrefix}-deal-${rawData.id}`;
  }

  if (rawData?.record_source === "coupon" && rawData?.id != null) {
    return `${fallbackPrefix}-coupon-${rawData.id}`;
  }

  if (rawData?.report_type && rawData?.campaignName && (rawData?.date || rawData?.invoiceDate)) {
    const dateKey = rawData.date || rawData.invoiceDate;
    const base = `${fallbackPrefix}-${rawData.report_type}-${String(rawData.campaignName).slice(0, REPORTING_NAME_LIMIT)}-${dateKey}`;
    const discriminator = reportingDiscriminator(rawData);
    return discriminator ? `${base}-${discriminator}` : base;
  }

  if (rawData?.campaignName && rawData?.date) {
    return `${fallbackPrefix}-${String(rawData.campaignName).slice(0, 80)}-${rawData.date}`;
  }

  if (rawData?.campaignName && rawData?.invoiceDate) {
    return `${fallbackPrefix}-${String(rawData.campaignName).slice(0, 80)}-invoice-${rawData.invoiceDate}`;
  }

  return String(
    rawData?.id ??
      rawData?._id ??
      rawData?.productId ??
      rawData?.campaignId ??
      rawData?.conversionId ??
      rawData?.legacyId ??
      rawData?.campaign_id ??
      rawData?.click_id ??
      rawData?.coupon ??
      rawData?.voucherCode ??
      rawData?.code ??
      `${fallbackPrefix}-${index}`,
  );
}

function withAccountScopedExternalId(externalId, sourceAccountKey) {
  if (!sourceAccountKey || sourceAccountKey === "default") return externalId;
  return `${sourceAccountKey}:${externalId}`;
}

function resolveOptimiseCampaignId(rawData) {
  const campaignId =
    rawData?.id ??
    rawData?.campaignId ??
    rawData?.productId ??
    rawData?.legacyId ??
    rawData?.campaign_id;

  if (campaignId === undefined || campaignId === null || campaignId === "") return null;
  return String(campaignId);
}

export function buildOptimiseCampaignExternalId(networkSource, rawData, index) {
  const campaignId = resolveOptimiseCampaignId(rawData);
  if (campaignId) return `${networkSource}-campaign-${campaignId}`;
  return `${networkSource}-campaign-index-${index}`;
}

/**
 * Awin coupon identity — Phase 9A.0b-v1.
 *
 * Awin promotion rows carry NO top-level `id`, `_id`, `advertiserId`, `voucherCode` or `code`, so
 * every one of them fell through resolveExternalId's chain to the positional
 * `awin-coupon-${index}` — an identity that is remapped by any change in supplier ordering — or,
 * where a flat code had been assumed, to the bare voucher code, which two advertisers can share
 * and which therefore collapses two promotions into one Entity.
 *
 * Production FieldRegistry shows what the rows actually carry: `promotionId` (number, non-null,
 * 100% of observed rows) and nested `advertiser.id` (number, non-null, 100%). `voucher.code` is
 * present on 28.25% and nullable, so it is content and never identity.
 *
 * promotionId alone is not used: nothing proves it unique ACROSS advertisers, and the composite
 * costs nothing. Both parts are required — there is no positional, voucher-code or generic-id
 * fallback for an Awin coupon, because every one of those is the defect this replaces.
 */
export function buildAwinCouponExternalId(rawData) {
  const advertiser = rawData?.advertiser?.id;
  const promotion = rawData?.promotionId;
  const advertiserId = advertiser == null ? "" : String(advertiser).trim();
  const promotionId = promotion == null ? "" : String(promotion).trim();
  // Both parts must be bare digits. FieldRegistry observed both as `number` on 100% of production
  // rows, so this rejects nothing real — and it is what makes the evidence id below provably
  // un-collidable: a canonical id's third hyphen-separated segment is ALWAYS numeric, so an id
  // whose third segment is the word `unresolved` cannot be produced here by any input.
  if (!AWIN_ID_PART.test(advertiserId) || !AWIN_ID_PART.test(promotionId)) return null;
  return `awin-coupon-${advertiserId}-${promotionId}`;
}

/**
 * Awin CAMPAIGN identity — the advertiser, under one deterministic id.
 *
 * Awin programmes currently return nothing, so the only evidence of an advertiser's existence is
 * the nested `advertiser` object on its promotion rows. Parents derived from that evidence and
 * parents staged from a real programme row must land on the SAME Entity, or the two would share
 * one SupplierCampaign business key while being two Entity rows — and whichever promoted last
 * would overwrite the other, because toCampaignWriteData writes every column on update.
 *
 * One id, minted the same way from either shape, is what removes that class of problem entirely:
 * a real programme row arriving later UPDATES the derived Entity in place rather than racing it.
 *
 * Returns null when no id is present, so the caller falls back to the generic resolver rather than
 * minting `awin-campaign-undefined`.
 */
export function buildAwinCampaignExternalId(rawData) {
  const id = rawData?.id ?? rawData?.advertiserId ?? rawData?.advertiser?.id ?? null;
  const value = id == null ? "" : String(id).trim();
  if (!value) return null;
  return `awin-campaign-${value}`;
}

/** True for an Awin campaign row, whose identity is the advertiser rather than a generic id. */
export function usesAwinCampaignIdentity(networkSource, entityType) {
  return entityType === "campaign" && String(networkSource ?? "").toLowerCase() === "awin";
}

/** Bare digits only. See buildAwinCouponExternalId for why this is required, not merely expected. */
const AWIN_ID_PART = /^[0-9]+$/;

/** The third segment of every evidence-only id. Never numeric, so never a canonical id. */
const AWIN_UNRESOLVED_SEGMENT = "unresolved";

/**
 * The evidence-only identity for an Awin promotion whose canonical identity cannot be resolved.
 *
 * Such a row must not become an Entity — a weak identity collapses or churns real promotions. But
 * it must not vanish either: RawPayload is the append-only supplier evidence store, and a row the
 * supplier actually sent is evidence whether or not we could name it.
 *
 * The id is derived from the payload alone, so it is deterministic: the same promotion re-fetched
 * produces the same id, lands on the same (supplier, account, resource, externalId, payloadHash)
 * unique key, and is recognised as a duplicate rather than written twice.
 *
 * Nothing about it is invented. It does not fall back to the voucher code, which two advertisers
 * can share; it does not substitute a positional index, which supplier ordering silently remaps;
 * and it does not fabricate an advertiser.id or promotionId. It says only "this payload, unnamed".
 */
export function buildUnresolvedAwinCouponEvidenceExternalId(rawData) {
  return `awin-coupon-${AWIN_UNRESOLVED_SEGMENT}-${hashPayload(rawData ?? {})}`;
}

/** True for an id minted by the evidence path. Never true for a canonical Awin coupon id. */
export function isUnresolvedAwinCouponEvidenceId(externalId) {
  const local = String(externalId ?? "").split(":").pop();
  return local.startsWith(`awin-coupon-${AWIN_UNRESOLVED_SEGMENT}-`);
}

/**
 * Whether a row is an Awin PROMOTION row, as opposed to a voucher fanned out of a campaign payload.
 *
 * collectEmbeddedCouponsFromCampaigns synthesises coupon rows from `vouchers`/`voucher_codes`
 * arrays and stamps `record_source: "coupon"` on each. Those rows carry neither `advertiser.id`
 * nor `promotionId` and already have a stable identity of their own, so applying the Awin rule to
 * them would fail them closed and drop rows that stage correctly today.
 */
export function usesAwinCouponIdentity(networkSource, rawData) {
  if (String(networkSource ?? "").toLowerCase() !== "awin") return false;
  return rawData?.record_source == null;
}

/** One coupon row's staging identity, used by BOTH coupon staging paths so they cannot diverge. */
function resolveCouponEntityExternalId(networkSource, rawData, externalIdPrefix, index) {
  if (usesAwinCouponIdentity(networkSource, rawData)) return buildAwinCouponExternalId(rawData);
  return resolveExternalId(rawData, externalIdPrefix, index, "coupon");
}

export async function cleanupOptimiseCampaignDuplicates(networkSource, sourceAccountKey) {
  // A direct Entity delete, not routed through the staging chokepoints. It removes duplicate staged
  // campaigns, which is exactly the row set a campaign walk is paging through, so it is refused
  // under the same freeze.
  await entityStagingBarrier.assertStagingAllowed();
  const campaigns = await prisma.entity.findMany({
    where: { networkSource, entityType: "campaign" },
    select: { id: true, externalId: true, rawData: true },
  });

  const groupsByCampaignId = new Map();
  for (const entity of campaigns) {
    const campaignId = resolveOptimiseCampaignId(entity.rawData);
    if (!campaignId) continue;

    const canonicalExternalId = withAccountScopedExternalId(
      buildOptimiseCampaignExternalId(networkSource, entity.rawData, 0),
      sourceAccountKey,
    );

    if (!groupsByCampaignId.has(campaignId)) {
      groupsByCampaignId.set(campaignId, []);
    }
    groupsByCampaignId.get(campaignId).push({ entity, canonicalExternalId });
  }

  const idsToDelete = [];
  for (const group of groupsByCampaignId.values()) {
    const hasCanonical = group.some((item) => item.entity.externalId === item.canonicalExternalId);
    if (!hasCanonical) continue;

    for (const { entity, canonicalExternalId } of group) {
      if (entity.externalId !== canonicalExternalId) {
        idsToDelete.push(entity.id);
      }
    }
  }

  if (idsToDelete.length === 0) return 0;

  await prisma.entity.deleteMany({
    where: { id: { in: idsToDelete } },
  });

  return idsToDelete.length;
}

function toNullableString(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function firstNonEmptyField(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    return value;
  }
  return null;
}

function toNullableNumber(value) {
  return typeof value === "number" && !Number.isNaN(value) ? value : null;
}

function toNullableDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

function resolveEventDate(normalizedData, rawData, entityType) {
  const fromNormalized = toNullableDate(
    normalizedData?.date ?? normalizedData?.expiry ?? normalizedData?.start_date,
  );
  if (fromNormalized) return fromNormalized;

  if (entityType !== "campaign") return null;

  return toNullableDate(
    rawData?.startDate ??
      rawData?.start_date ??
      rawData?.activationDate ??
      rawData?.createdAt ??
      rawData?.created_at ??
      null,
  );
}

function buildStructuredFields(normalizedData, rawData, entityType) {
  return {
    entityName: toNullableString(normalizedData?.name),
    campaignName: toNullableString(
      firstNonEmptyField(
        normalizedData?.campaign_name,
        normalizedData?.name,
        rawData?.title,
        rawData?.campaign_name,
        rawData?.campaignName,
      ),
    ),
    advertiserName: toNullableString(
      firstNonEmptyField(
        normalizedData?.advertiser,
        rawData?.advertiser_name,
        typeof rawData?.advertiser === "string" ? rawData.advertiser : rawData?.advertiser?.name,
        rawData?.advertiserName,
        rawData?.merchant_name,
        rawData?.companyName,
        rawData?.brand_name,
      ),
    ),
    entityStatus: toNullableString(normalizedData?.status),
    entitySubType: toNullableString(normalizedData?.code_type ?? normalizedData?.type),
    code: toNullableString(normalizedData?.code),
    discount: toNullableString(normalizedData?.discount),
    revenue: toNullableNumber(normalizedData?.revenue),
    commission: toNullableNumber(normalizedData?.commission),
    eventDate: resolveEventDate(normalizedData, rawData, entityType),
  };
}

function prepareEntityRecord({ networkSource, entityType, rawData, externalId }) {
  const normalizedData = normalizeEntity(rawData, networkSource, entityType);
  const mismatches = validateFieldUsage(rawData, normalizedData, entityType, networkSource);
  logFieldUsageWarnings(networkSource, entityType, mismatches);

  return {
    externalId,
    networkSource,
    entityType,
    rawData,
    normalizedData,
    ...buildStructuredFields(normalizedData, rawData, entityType),
  };
}

/**
 * Single-entity upsert (coupons and direct callers).
 */
export async function upsertRawEntity(options) {
  /**
   * `alreadyStaged` says the CALLER is already registered as a staging participant for this write.
   *
   * It exists because upsertCouponRows reaches this function once per row while sitting inside the
   * batch participant upsertManyRawEntities already took. Each of those rows was then announcing a
   * participant of its own: a JobRun insert, the freeze read that follows it, and a JobRun update
   * to release it — three extra round trips per row, on top of a participant table that grew by one
   * row per coupon and was re-read by the next coupon's freeze check. Trackier's 116 coupons
   * exhausted a 300s invocation on that alone, staging zero Entities while their RECEIVED lineage
   * was already written.
   *
   * It is NOT a way to skip the barrier. The batch participant still covers every row, and the
   * freeze is still evaluated once for the batch before any row runs. What goes away is the
   * re-entry, which protected nothing: a row inside an already-registered batch cannot be the
   * stager a freeze needs to see, because the batch is.
   *
   * Default false, so every direct caller — the Coupon CMS, the operator paths — registers exactly
   * as it did before.
   */
  const { alreadyStaged = false, ...staging } = options ?? {};
  if (alreadyStaged) return stageRawEntity(staging);
  // Registered as a staging participant for the whole write, and refused outright if a promotion
  // or conversion-promotion cursor walk is in flight. See entityStagingBarrier.js for why.
  return entityStagingBarrier.withStaging(
    `${options?.networkSource ?? "unknown"}:${options?.entityType ?? "unknown"}`,
    () => stageRawEntity(staging),
    { holderId: "upsertRawEntity" },
  );
}

async function stageRawEntity({
  networkSource,
  entityType,
  rawData,
  externalId,
  evidence = null,
  /**
   * Schema observation fans out one upsert per field path. When a caller stages many rows it
   * observes them once for the whole batch and turns this off, so a row fan-out never nests a
   * second fan-out inside itself.
   */
  observeSchema = true,
  /**
   * Fix B1 — the record stageManyRawEntities already built for this exact row.
   *
   * The batch prepare pass resolves the external id, account-scopes it, normalizes the payload and
   * validates its field usage for every row. Reaching this function then threw all of that away
   * and did it again. Handing the record down instead makes the batch path prepare each row once.
   *
   * Reused only when it describes THIS write. A record whose identity does not match the one the
   * caller asked for is ignored and the row is prepared here, because staging a payload under
   * someone else's external id is worse than any amount of repeated work.
   */
  preparedRecord = null,
  /**
   * True when the caller has already written this row's RECEIVED lineage. Set per row by the batch
   * path, and only for rows whose RECEIVED write actually returned a record, so a row that failed
   * that pass still gets it here.
   */
  alreadyReceived = false,
}) {
  const original = cloneRawJson(rawData ?? {});
  const reusable =
    preparedRecord &&
    preparedRecord.externalId === externalId &&
    preparedRecord.networkSource === networkSource &&
    preparedRecord.entityType === entityType;
  const record = reusable
    ? preparedRecord
    : prepareEntityRecord({
        networkSource,
        entityType,
        rawData: cloneRawJson(original),
        externalId,
      });

  return runWithSourceEvidence(evidence || {}, async () => {
    // Skipped only when the caller proved it already wrote this row's RECEIVED row. The STAGED
    // write below still runs, so the entityId lineage every raw row needs is unaffected.
    if (!alreadyReceived) {
      try {
        await persistRawPayload({
          networkSource,
          entityType,
          externalId,
          payload: original,
          processingStatus: "RECEIVED",
          observeSchema,
          ...(evidence || {}),
        });
      } catch (error) {
        logger.warn(
          { err: error?.message || String(error), networkSource, entityType, externalId },
          "raw payload persist before entity staging failed",
        );
      }
    }

  let entity;
  if (entityType === "coupon") {
    entity = await upsertCouponFromSync({
      networkSource,
      rawData: record.rawData,
      externalId,
      normalizedData: record.normalizedData,
    });
  } else {
    entity = await prisma.entity.upsert({
      where: {
        externalId_networkSource_entityType: {
          externalId,
          networkSource,
          entityType,
        },
      },
      create: {
        externalId,
        networkSource,
        entityType,
        ...buildStructuredFields(record.normalizedData),
        rawData: record.rawData,
        normalizedData: record.normalizedData,
      },
      update: {
        ...buildStructuredFields(record.normalizedData),
        rawData: record.rawData,
        normalizedData: record.normalizedData,
      },
    });
  }

    // Wave B — append-only raw lineage (Entity.rawData remains mutable staging copy).
    try {
      await persistRawPayload({
        networkSource,
        entityType,
        externalId,
        payload: original,
        entityId: entity?.id ?? null,
        processingStatus: "STAGED",
        observeSchema: false,
        ...(evidence || {}),
      });
    } catch {
      // Raw lineage must not block Entity staging / CMS.
    }

    return entity;
  });
}

/**
 * Stage coupon/offer rows one at a time, because the coupon CMS merge has to read each existing
 * Entity before deciding how to write it.
 *
 * Two things keep this within the connection pool. The fan-out is bounded by
 * COUPON_ROW_CONCURRENCY, and schema observation is lifted out of the rows: it happens once for
 * the whole batch, so no row's work fans out again while the row itself holds a connection.
 */
async function upsertCouponRows({
  networkSource,
  rows,
  externalIdPrefix,
  sourceAccountKey,
  alreadyObserved = false,
  /**
   * True when the caller already holds a staging participant for this batch, which
   * stageManyRawEntities always does. Threaded rather than assumed so the one place that decides
   * is the call site that knows.
   */
  alreadyStaged = false,
  /**
   * Fix B1 — the batch's own prepared records, as `{ record, alreadyReceived }` entries.
   *
   * When supplied, identity and normalization are taken from the record the batch already built
   * rather than derived a second time from the raw row. That also removes a latent divergence:
   * the fallback below calls resolveExternalId WITHOUT an entityType, while the batch prepare pass
   * calls it WITH one. The two agree for coupons today, but only by accident of which branches
   * that function takes.
   *
   * Null for the callers that genuinely have only raw rows — the Coupon CMS, and the coupons
   * lifted out of campaign payloads, which are not in the campaign batch's prepared records.
   */
  preparedEntries = null,
}) {
  const results = [];
  /**
   * Two identity sources, deliberately not one.
   *
   * `preparedEntries` is the batch's own prepared records, and the prepare pass in
   * stageManyRawEntities already applied the Awin rule and already refused the rows that fail it.
   * Re-resolving here would recompute an identity that is by construction the same one, which is
   * the repetition Fix B1 removed — and would risk disagreeing with the RawPayload lineage the
   * batch has already written under those ids.
   *
   * The fallback is for the one caller that genuinely has only raw rows: the vouchers fanned out
   * of campaign payloads, which are synthesised after the prepare pass and so are in nobody's
   * prepared records. It resolves identity through the same resolver the prepare pass uses, so the
   * two paths cannot diverge on what an Awin coupon is called. Its refusal branch is unreachable
   * today — those rows carry record_source, which takes them off the Awin rule and onto
   * resolveExternalId, which always answers — and it is kept because that is a property of the
   * current fan-out, not a guarantee.
   */
  const prepared = preparedEntries
    ? preparedEntries.map((entry) => ({
        rawData: entry.record.originalPayload,
        externalId: entry.record.externalId,
        preparedRecord: entry.record,
        alreadyReceived: entry.alreadyReceived === true,
      }))
    : rows
        .map((rawData, index) => {
          const row = rawData ?? {};
          const resolvedId = resolveCouponEntityExternalId(
            networkSource,
            row,
            externalIdPrefix,
            index,
          );
          if (!resolvedId) {
            // Fail closed, exactly as a conversion without a network id does: a weak identity here
            // would collapse or churn rows, which is worse than not staging the row at all.
            logger.warn(
              { networkSource, entityType: "coupon", index },
              "coupon row skipped — missing supplier identity (weak dedupe forbidden)",
            );
            return null;
          }
          return {
            rawData: row,
            externalId: withAccountScopedExternalId(resolvedId, sourceAccountKey),
            preparedRecord: null,
            alreadyReceived: false,
          };
        })
        .filter(Boolean);

  if (!alreadyObserved) {
    // Batch observation also writes each row's RECEIVED lineage, exactly as the caller's own
    // staging pass does, so nothing is lost by taking observation out of the per-row work.
    try {
      await persistRawPayloadsForPreparedRecords(
        prepared.map((entry) => ({
          networkSource,
          entityType: "coupon",
          externalId: entry.externalId,
          rawData: entry.rawData,
        })),
        { metadata: { sourceAccountKey: sourceAccountKey ?? null } },
      );
    } catch (error) {
      logger.warn(
        { err: error?.message || String(error), networkSource, rows: prepared.length },
        "coupon batch raw payload persist failed",
      );
    }
  }

  await runWithConcurrency(prepared, COUPON_ROW_CONCURRENCY, async (entry) => {
    const entity = await upsertRawEntity({
      networkSource,
      entityType: "coupon",
      rawData: entry.rawData,
      externalId: entry.externalId,
      observeSchema: false,
      // Inside the batch participant already: one more per row buys nothing and costs three
      // round trips, exactly as observeSchema:false avoids a second schema fan-out per row.
      alreadyStaged,
      preparedRecord: entry.preparedRecord,
      alreadyReceived: entry.alreadyReceived,
    });
    results.push(entity);
  });
  return results;
}

/**
 * Batch upserts with bulk SQL for standard entities; coupons keep per-row merge logic.
 */
export async function upsertManyRawEntities(options) {
  // Same barrier, one participant for the whole batch rather than one per row: a batch is a single
  // staging operation, and the freeze must either allow all of it or none of it.
  return entityStagingBarrier.withStaging(
    `${options?.networkSource ?? "unknown"}:${options?.entityType ?? "unknown"}`,
    () => stageManyRawEntities(options),
    { holderId: "upsertManyRawEntities" },
  );
}

async function stageManyRawEntities({
  networkSource,
  entityType,
  rows,
  externalIdPrefix,
  sourceAccountKey,
  onTiming,
  evidence = null,
  /** Campaign ids whose detailed commission rules were ingested separately this sync. */
  commissionRuleSkipCampaignIds = null,
  /** Skip the campaign-summary commission fan-out for every campaign (fail closed). */
  commissionRuleFanOutDisabled = false,
  /**
   * Whether this batch may roll its counters up onto the NetworkSyncRun in `evidence`.
   *
   * That run measures the SUPPLIER FETCH. finalizeRun recomputes the run's status from the patch
   * it is given, so a batch that reports no quarantined rows resolves it to SUCCESS — which would
   * erase a PARTIAL the fetch recorded truthfully, for example an Awin offers walk that stopped at
   * its page cap holding part of the catalogue.
   *
   * It has never bitten because the invocation died before staging finished. A caller that stages
   * one fetch in several batches would make it fire once per batch, each with that batch's
   * counters, so such a caller turns this off and leaves the fetch's own verdict alone.
   */
  finalizeSyncRun = true,
}) {
  if (!rows.length) {
    if (onTiming) onTiming({ dbWriteMs: 0, fieldExtractionMs: 0, batchUpsertMs: 0, rowUpsertMs: 0 });
    return { preparedRecords: [], counters: rollupRawPayloadOutcomes([]) };
  }

  return runWithSourceEvidence(evidence || {}, async () => {
    const useOptimiseCampaignIds =
      entityType === "campaign" && String(networkSource).startsWith("optimise_");
    const useAwinCampaignIds = usesAwinCampaignIdentity(networkSource, entityType);
    const benchmark = String(process.env.SYNC_UPSERT_BENCHMARK || "").toLowerCase() === "true";

    /**
     * Phase-boundary diagnostics. The existing `[sync-benchmark]` line is emitted only at the END
     * of this function, so an invocation killed mid-batch produces no timing at all — its absence
     * proves nothing about WHICH phase consumed the budget. These lines close each phase as it
     * completes, so a truncated invocation still reports how far it got.
     *
     * Counts and durations only: never a payload, an externalId, a coupon code, a row body, a
     * token or a secret. `networkSource` and `entityType` are the same two identifiers the
     * existing benchmark line already carries.
     */
    const emitPhase = (phase, fields) => {
      if (!benchmark) return;
      // eslint-disable-next-line no-console
      console.info(`[sync-phase] ${networkSource}:${entityType} ${phase} ${fields}`);
    };

    const prepareStart = Date.now();
    /**
     * Coupon rows whose canonical identity could not be resolved.
     *
     * They are kept OUT of preparedRecords, so no Entity is created for them and they never reach
     * upsertCouponRows or upsertCouponFromSync. They are not discarded: each one is persisted
     * below as immutable RawPayload evidence in the FAILED state, under an id derived from the
     * payload rather than guessed from it.
     */
    const unresolvedCouponEvidence = [];
    const preparedRecords = rows
      .map((rawData, index) => {
        const original = cloneRawJson(rawData ?? {});
        const genericId = () => resolveExternalId(original, externalIdPrefix, index, entityType);
        const resolvedId = useOptimiseCampaignIds
          ? buildOptimiseCampaignExternalId(networkSource, original, index)
          : entityType === "coupon"
            ? resolveCouponEntityExternalId(networkSource, original, externalIdPrefix, index)
            : useAwinCampaignIds
              // Both the programmes path and the derived advertiser parents come through here, so
              // this is the one place that has to agree with itself for them to converge.
              ? (buildAwinCampaignExternalId(original) ?? genericId())
              : genericId();
        if (entityType === "coupon" && !resolvedId) {
          // Fail closed for the Entity, open for the evidence. The refusal is the same one
          // upsertCouponRows makes, so lineage and the Entity cannot disagree about which rows
          // were staged — but the payload itself is still recorded, as FAILED, below.
          logger.warn(
            { networkSource, entityType, index },
            "coupon row skipped — missing supplier identity (weak dedupe forbidden)",
          );
          if (usesAwinCouponIdentity(networkSource, original)) {
            unresolvedCouponEvidence.push({
              networkSource,
              entityType,
              externalId: withAccountScopedExternalId(
                buildUnresolvedAwinCouponEvidenceExternalId(original),
                sourceAccountKey,
              ),
              rawData: original,
            });
          }
          return null;
        }
        if (entityType === "conversion" && !resolvedId) {
          logger.warn(
            {
              networkSource,
              entityType,
              index,
              campaignName: original?.campaignName ?? original?.campaign_name ?? null,
            },
            "conversion row skipped — missing network conversion id (weak dedupe forbidden)",
          );
          return null;
        }
        const externalId = withAccountScopedExternalId(resolvedId, sourceAccountKey);
        const prepared = prepareEntityRecord({
          networkSource,
          entityType,
          rawData: cloneRawJson(original),
          externalId,
        });
        return { ...prepared, originalPayload: original };
      })
      .filter(Boolean);
    const prepareMs = Date.now() - prepareStart;
    emitPhase("prepared", `rows=${rows.length} prepared=${preparedRecords.length} ms=${prepareMs}`);

    let rawOutcomes = [];
    try {
      rawOutcomes = await persistRawPayloadsForPreparedRecords(
        preparedRecords.map((record) => ({ ...record, rawData: record.originalPayload })),
        {
          metadata: { sourceAccountKey: sourceAccountKey ?? null },
          evidence,
          // Fires after RECEIVED persistence and again after schema observation, which happen
          // inside that call rather than here. Ignored entirely when the flag is off.
          onPhase: benchmark
            ? ({ phase, count, ms }) =>
                emitPhase(phase, count === null ? `ms=${ms}` : `outcomes=${count} ms=${ms}`)
            : null,
        },
      );
    } catch (error) {
      logger.warn(
        { err: error?.message || String(error), networkSource, entityType, rows: preparedRecords.length },
        "raw payload persist before entity staging failed",
      );
    }

    // Evidence for the rows that will deliberately never become Entities. Written as FAILED, with
    // no entityId, and never linked afterwards: the relink pass below walks preparedRecords, which
    // these are not in. Re-ingesting the same payload produces the same id and the same hash, so
    // persistRawPayload recognises the duplicate and does not write a second row.
    if (unresolvedCouponEvidence.length) {
      try {
        await persistRawPayloadsForPreparedRecords(unresolvedCouponEvidence, {
          metadata: {
            sourceAccountKey: sourceAccountKey ?? null,
            // A reason code, not a payload excerpt: no coupon code, advertiser name or URL.
            failureReason: "identity_resolution_failed",
          },
          evidence,
          processingStatus: "FAILED",
        });
      } catch (error) {
        logger.warn(
          {
            err: error?.message || String(error),
            networkSource,
            entityType,
            rows: unresolvedCouponEvidence.length,
          },
          "unresolved coupon evidence persist failed",
        );
      }
    }

  let batchUpsertMs = 0;
  let rowUpsertMs = 0;
  const dbWriteStart = Date.now();

  if (entityType === "coupon") {
    const couponStart = Date.now();
    // These are the rows the staging pass above already observed and wrote RECEIVED lineage for.
    // Handing the prepared records down rather than the raw rows is Fix B1: identity and
    // normalization are not derived twice, and the RECEIVED persist is not repeated for any row
    // the pass above actually wrote. `alreadyReceived` is decided per row from that pass's own
    // outcome, so a row it failed on still has its RECEIVED lineage written here.
    await upsertCouponRows({
      networkSource,
      rows,
      externalIdPrefix,
      sourceAccountKey,
      alreadyObserved: true,
      alreadyStaged: true,
      preparedEntries: preparedRecords.map((record, index) => ({
        record,
        alreadyReceived: Boolean(rawOutcomes[index]?.record?.id),
      })),
    });
    rowUpsertMs = Date.now() - couponStart;
  } else {
    const batchStart = Date.now();
    const { batchMs } = await batchUpsertEntities(preparedRecords);
    batchUpsertMs = batchMs;

    if (entityType === "campaign") {
      const embedded = collectEmbeddedCouponsFromCampaigns(
        preparedRecords.map((record) => ({ rawData: record.originalPayload })),
        { sourceObject: "campaigns" },
      );
      if (embedded.length) {
        const fanOutStart = Date.now();
        await upsertCouponRows({
          networkSource,
          rows: embedded.map((row) => ({ ...row, record_source: "coupon" })),
          externalIdPrefix,
          sourceAccountKey,
          // Same batch participant: this fan-out runs inside stageManyRawEntities too.
          alreadyStaged: true,
        });
        rowUpsertMs += Date.now() - fanOutStart;
      }

      try {
        if (!commissionRuleFanOutDisabled) {
          await upsertCommissionRulesForPreparedCampaigns({
            networkSource,
            preparedRecords,
            sourceAccountKey,
            skipCampaignIds: commissionRuleSkipCampaignIds,
          });
        }
      } catch {
        // Commission rule fan-out must not block entity staging.
      }
    }
  }

  const dbWriteMs = Date.now() - dbWriteStart;
  emitPhase("entities", `rows=${preparedRecords.length} ms=${dbWriteMs}`);

  // Link latest raw rows to staged Entity ids (best-effort, non-blocking).
  // The raw rows were just written above, so their ids come from this batch's own outcomes: no
  // second lookup per row, and no second schema observation of payloads already observed.
  try {
    const entities = await prisma.entity.findMany({
      where: {
        networkSource,
        entityType,
        externalId: { in: preparedRecords.map((r) => r.externalId) },
      },
      select: { id: true, externalId: true },
    });
    const idByExternal = new Map(entities.map((e) => [e.externalId, e.id]));
    const links = [];
    for (let i = 0; i < preparedRecords.length; i += 1) {
      const prepared = preparedRecords[i];
      const entityId = idByExternal.get(prepared.externalId);
      const rawRecord = rawOutcomes[i]?.record;
      if (!entityId || !rawRecord?.id) continue;
      links.push({
        id: rawRecord.id,
        entityId,
        currentEntityId: rawRecord.entityId ?? null,
        processingStatus: rawRecord.processingStatus ?? "RECEIVED",
      });
    }
    await linkRawPayloadsToEntities(links);
  } catch {
    // Entity linkage is enrichment only.
  }

  const fieldExtractionMs = 0;

  if (benchmark) {
    // eslint-disable-next-line no-console
    console.info(
      `[sync-benchmark] ${networkSource}:${entityType} rows=${rows.length} prepareMs=${prepareMs} batchUpsertMs=${batchUpsertMs} rowUpsertMs=${rowUpsertMs} dbWriteMs=${dbWriteMs} fieldExtractionMs=${fieldExtractionMs}`,
    );
  }

  if (onTiming) {
    onTiming({ dbWriteMs, fieldExtractionMs, batchUpsertMs, rowUpsertMs, prepareMs });
  }

  const rawCounters = rollupRawPayloadOutcomes(rawOutcomes);
  const entityUpdated = Math.max(0, preparedRecords.length - rawCounters.recordsCreated);
  const counters = {
    recordsFetched: rows.length,
    recordsCreated: rawCounters.recordsCreated,
    recordsUpdated: entityUpdated,
    recordsUnchanged: rawCounters.recordsUnchanged,
    recordsQuarantined: rawCounters.recordsQuarantined,
  };

  if (finalizeSyncRun && evidence?.syncRunId) {
    try {
      await sourceObjectSync.finalizeRun(evidence.syncRunId, {
        ...counters,
        checkpointAfter: evidence.checkpoint ?? evidence.requestWindow ?? null,
        partial: counters.recordsQuarantined > 0,
      });
    } catch {
      // Best-effort observability rollup.
    }
  }

  return { preparedRecords, counters };
  });
}

export async function listEntities({
  entityType,
  networkSource,
  accountLabel,
  page,
  pageSize,
  fromDate,
  toDate,
  search,
  couponKind,
  brand,
}) {
  const normalizedSearch = String(search ?? "").trim();
  const normalizedBrand = String(brand ?? "").trim();
  const skip = (page - 1) * pageSize;
  const useRawQuery =
    Boolean(normalizedSearch) ||
    Boolean(normalizedBrand) ||
    (entityType === "coupon" && Boolean(normalizeCouponKindParam(couponKind)));

  if (useRawQuery) {
    const whereClause = buildEntityListWhere({
      entityType,
      networkSource,
      accountLabel,
      fromDate,
      toDate,
      search: normalizedSearch || undefined,
      couponKind,
      brand: normalizedBrand || undefined,
    });
    const orderByClause = buildEntityListOrderBy(networkSource);

    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT *
        FROM "Entity"
        ${whereClause}
        ${orderByClause}
        LIMIT ${pageSize}
        OFFSET ${skip}
      `,
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM "Entity"
        ${whereClause}
      `,
    ]);

    return {
      rows,
      total: Number(countRows?.[0]?.count ?? 0),
    };
  }

  const normalizedAccountLabel = accountLabel ? String(accountLabel).trim().toLowerCase() : "";
  const dateFilter = buildEventDateFilter({ fromDate, toDate, entityType });
  const couponKindFilter = buildCouponKindPrismaWhere(entityType, couponKind);
  const where = {
    ...(entityType ? { entityType } : {}),
    ...(networkSource ? { networkSource } : {}),
    ...(normalizedAccountLabel
      ? normalizedAccountLabel === "default"
        ? { NOT: { externalId: { contains: ":" } } }
        : { externalId: { startsWith: `${normalizedAccountLabel}:` } }
      : {}),
    ...(dateFilter ? dateFilter : {}),
    ...(couponKindFilter ? couponKindFilter : {}),
  };

  const orderBy = networkSource
    ? [{ updatedAt: "desc" }]
    : [{ networkSource: "asc" }, { updatedAt: "desc" }];

  const [rows, total] = await Promise.all([
    prisma.entity.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.entity.count({ where }),
  ]);

  return { rows, total };
}

export async function loadCachedCampaignRows(networkSource, accountLabel) {
  const { rows } = await listEntities({
    entityType: "campaign",
    networkSource,
    accountLabel,
    page: 1,
    pageSize: 10000,
  });
  return rows.map((row) => row.rawData);
}
