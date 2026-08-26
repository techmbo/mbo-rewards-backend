import { prisma } from "../../database/prisma.js";
import { buildEventDateFilter } from "../../core/dateRange.js";
import { buildCouponKindPrismaWhere, normalizeCouponKindParam } from "../../core/couponKind.js";
import {
  buildEntityListOrderBy,
  buildEntityListWhere,
} from "../../core/entitySearch.js";
import { runWithConcurrency } from "../../core/concurrency.js";
import { extractFields } from "../../field-system/fieldExtractor.js";
import { upsertExtractedFields } from "../../field-system/fieldRegistry.service.js";
import { logFieldUsageWarnings, validateFieldUsage } from "../../field-system/validateFieldUsage.js";
import { upsertCouponFromSync } from "../coupons/couponCms.service.js";
import { SYNC_UPSERT_CHUNK_SIZE, SYNC_UPSERT_CONCURRENCY } from "../../jobs/syncConfig.js";
import { batchUpsertEntities } from "./batchEntityUpsert.js";
import { normalizeEntity } from "./normalizers.js";
import {
  persistRawPayload,
  persistRawPayloadsForPreparedRecords,
} from "./rawPayload.service.js";

function resolveExternalId(rawData, fallbackPrefix, index) {
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

  if (rawData?.record_source === "deal" && rawData?.id != null) {
    return `${fallbackPrefix}-deal-${rawData.id}`;
  }

  if (rawData?.record_source === "coupon" && rawData?.id != null) {
    return `${fallbackPrefix}-coupon-${rawData.id}`;
  }

  if (rawData?.report_type && rawData?.campaignName && (rawData?.date || rawData?.invoiceDate)) {
    const dateKey = rawData.date || rawData.invoiceDate;
    return `${fallbackPrefix}-${rawData.report_type}-${String(rawData.campaignName).slice(0, 80)}-${dateKey}`;
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

export async function cleanupOptimiseCampaignDuplicates(networkSource, sourceAccountKey) {
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
export async function upsertRawEntity({
  networkSource,
  entityType,
  rawData,
  externalId,
  skipFieldExtraction = false,
}) {
  const record = prepareEntityRecord({ networkSource, entityType, rawData, externalId });

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
      payload: record.rawData,
      entityId: entity?.id ?? null,
      processingStatus: "STAGED",
    });
  } catch {
    // Raw lineage must not block Entity staging / CMS.
  }

  if (!skipFieldExtraction) {
    const extractedFields = extractFields(record.rawData, networkSource, entityType);
    await upsertExtractedFields(extractedFields);
  }

  return entity;
}

async function upsertCouponRows({ networkSource, rows, externalIdPrefix, sourceAccountKey }) {
  const results = [];
  await runWithConcurrency(rows, SYNC_UPSERT_CONCURRENCY, async (rawData, index) => {
    const externalId = withAccountScopedExternalId(
      resolveExternalId(rawData ?? {}, externalIdPrefix, index),
      sourceAccountKey,
    );
    const entity = await upsertRawEntity({
      networkSource,
      entityType: "coupon",
      rawData: rawData ?? {},
      externalId,
      skipFieldExtraction: true,
    });
    results.push(entity);
  });
  return results;
}

function collectUniqueFields(rows, networkSource, entityType) {
  const uniqueFields = new Map();
  for (const rawData of rows) {
    for (const field of extractFields(rawData ?? {}, networkSource, entityType)) {
      uniqueFields.set(`${field.fieldPath}|${field.source}|${field.entityType}`, field);
    }
  }
  return [...uniqueFields.values()];
}

/**
 * Batch upserts with bulk SQL for standard entities; coupons keep per-row merge logic.
 */
export async function upsertManyRawEntities({
  networkSource,
  entityType,
  rows,
  externalIdPrefix,
  sourceAccountKey,
  onTiming,
}) {
  if (!rows.length) {
    if (onTiming) onTiming({ dbWriteMs: 0, fieldExtractionMs: 0, batchUpsertMs: 0, rowUpsertMs: 0 });
    return [];
  }

  const useOptimiseCampaignIds =
    entityType === "campaign" && String(networkSource).startsWith("optimise_");
  const benchmark = String(process.env.SYNC_UPSERT_BENCHMARK || "").toLowerCase() === "true";

  const prepareStart = Date.now();
  const preparedRecords = rows.map((rawData, index) => {
    const resolvedId = useOptimiseCampaignIds
      ? buildOptimiseCampaignExternalId(networkSource, rawData ?? {}, index)
      : resolveExternalId(rawData ?? {}, externalIdPrefix, index);
    const externalId = withAccountScopedExternalId(resolvedId, sourceAccountKey);
    return prepareEntityRecord({
      networkSource,
      entityType,
      rawData: rawData ?? {},
      externalId,
    });
  });
  const prepareMs = Date.now() - prepareStart;

  let batchUpsertMs = 0;
  let rowUpsertMs = 0;
  const dbWriteStart = Date.now();

  if (entityType === "coupon") {
    const couponStart = Date.now();
    await upsertCouponRows({ networkSource, rows, externalIdPrefix, sourceAccountKey });
    rowUpsertMs = Date.now() - couponStart;
  } else {
    const batchStart = Date.now();
    const { batchMs } = await batchUpsertEntities(preparedRecords);
    batchUpsertMs = batchMs;
  }

  const dbWriteMs = Date.now() - dbWriteStart;

  // Wave B — persist append-only RawPayload for each prepared row (best-effort).
  try {
    await persistRawPayloadsForPreparedRecords(preparedRecords, {
      metadata: { sourceAccountKey: sourceAccountKey ?? null },
    });
  } catch {
    // Do not fail sync if raw lineage write fails.
  }

  // Link latest raw rows to staged Entity ids (best-effort, non-blocking).
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
    for (const prepared of preparedRecords) {
      const entityId = idByExternal.get(prepared.externalId);
      if (!entityId) continue;
      await persistRawPayload({
        networkSource: prepared.networkSource,
        entityType: prepared.entityType,
        externalId: prepared.externalId,
        payload: prepared.rawData,
        entityId,
        processingStatus: "STAGED",
        metadata: { sourceAccountKey: sourceAccountKey ?? null },
      });
    }
  } catch {
    // Entity linkage is enrichment only.
  }

  const fieldStart = Date.now();
  const pendingFields = collectUniqueFields(rows, networkSource, entityType);
  await upsertExtractedFields(pendingFields);
  const fieldExtractionMs = Date.now() - fieldStart;

  if (benchmark) {
    // eslint-disable-next-line no-console
    console.info(
      `[sync-benchmark] ${networkSource}:${entityType} rows=${rows.length} prepareMs=${prepareMs} batchUpsertMs=${batchUpsertMs} rowUpsertMs=${rowUpsertMs} dbWriteMs=${dbWriteMs} fieldExtractionMs=${fieldExtractionMs}`,
    );
  }

  if (onTiming) {
    onTiming({ dbWriteMs, fieldExtractionMs, batchUpsertMs, rowUpsertMs, prepareMs });
  }

  return preparedRecords;
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
