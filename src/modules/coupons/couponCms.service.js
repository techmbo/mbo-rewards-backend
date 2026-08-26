import { randomUUID } from "node:crypto";
import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { listEntities } from "../raw/raw.service.js";
import {
  applyManualCouponFields,
  buildNormalizedFromCouponFields,
  extractCouponFieldsFromNormalized,
  formatCouponEntityForClient,
  isCampaignStatusAllottable,
  mergeCouponSyncData,
} from "./couponMerge.js";
import { buildAllotmentDisplayFields, extractParentCampaignIds } from "./allotmentFields.js";
import { aggregateOrderMetricsByCampaignNames } from "./couponCommercial.service.js";

function toNullableString(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function normalizeCampaignName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function campaignNamesForCoupon(row) {
  const names = new Set();
  const push = (value) => {
    const normalized = normalizeCampaignName(value);
    if (normalized) names.add(normalized);
  };
  push(row?.campaignName);
  push(row?.cmsMeta?.displayFields?.campaignName);
  push(row?.allotment?.brandName);
  push(row?.advertiserName);
  const raw = row?.rawData && typeof row.rawData === "object" ? row.rawData : {};
  push(raw.campaign_name);
  push(raw.campaignName);
  push(raw.campaign?.name);
  if (typeof raw.campaign === "string") push(raw.campaign);
  return [...names];
}

async function attachOrderMetrics(rows = []) {
  const allNames = [];
  const rowNameLists = rows.map((row) => {
    const names = campaignNamesForCoupon(row);
    allNames.push(...names);
    return names;
  });

  const metricsByName = await aggregateOrderMetricsByCampaignNames(allNames);

  return rows.map((row, index) => {
    const metrics = {
      grossOrders: 0,
      netOrders: 0,
      grossOrderValue: 0,
      netOrderValue: 0,
      currency: null,
    };
    for (const name of rowNameLists[index]) {
      const bucket = metricsByName.get(name);
      if (!bucket) continue;
      metrics.grossOrders += bucket.grossOrders || 0;
      metrics.netOrders += bucket.netOrders || 0;
      metrics.grossOrderValue += bucket.grossOrderValue || 0;
      metrics.netOrderValue += bucket.netOrderValue || 0;
      if (bucket.currency && !metrics.currency) metrics.currency = bucket.currency;
    }
    return {
      ...row,
      grossOrders: metrics.grossOrders,
      netOrders: metrics.netOrders,
      grossOrderValue: metrics.grossOrderValue,
      netOrderValue: metrics.netOrderValue,
      ordersCurrency: metrics.currency,
      allotment: {
        ...(row.allotment || {}),
        grossOrders: metrics.grossOrders,
        netOrders: metrics.netOrders,
        grossOrderValue: metrics.grossOrderValue,
        netOrderValue: metrics.netOrderValue,
        ordersCurrency: metrics.currency,
      },
    };
  });
}

function toNullableDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildStructuredFieldsFromNormalized(normalizedData) {
  const code =
    normalizedData?.code && !/^https?:\/\//i.test(String(normalizedData.code).trim())
      ? toNullableString(normalizedData.code)
      : null;
  return {
    entityName: toNullableString(
      code ||
        normalizedData?.name ||
        normalizedData?.advertiser ||
        normalizedData?.campaign_name ||
        null,
    ),
    campaignName: toNullableString(normalizedData?.campaign_name),
    advertiserName: toNullableString(normalizedData?.brand_name ?? normalizedData?.advertiser),
    entityStatus: toNullableString(normalizedData?.status),
    entitySubType: toNullableString(normalizedData?.code_type),
    code,
    discount: toNullableString(normalizedData?.discount),
    eventDate: toNullableDate(normalizedData?.expiry ?? normalizedData?.start_date),
  };
}

async function loadRelatedCampaignEntities(couponRows = []) {
  const parentIds = extractParentCampaignIds(couponRows);
  if (!parentIds.length) return new Map();

  const campaigns = await prisma.entity.findMany({
    where: {
      entityType: "campaign",
      OR: [
        { externalId: { in: parentIds } },
        ...parentIds.flatMap((id) => [
          { externalId: { endsWith: `:${id}` } },
          { externalId: { contains: `:${id}` } },
        ]),
      ],
    },
  });

  const byId = new Map();
  for (const campaign of campaigns) {
    const ext = String(campaign.externalId || "");
    byId.set(ext, campaign);
    const tail = ext.includes(":") ? ext.slice(ext.lastIndexOf(":") + 1) : ext;
    if (tail) byId.set(tail, campaign);
    if (campaign.rawData?.id != null) byId.set(String(campaign.rawData.id), campaign);
  }
  return byId;
}

async function loadLinkedSupplierContext(couponEntityIds = []) {
  if (!couponEntityIds.length) return new Map();
  const coupons = await prisma.supplierCoupon.findMany({
    where: { entityId: { in: couponEntityIds } },
    include: {
      supplierCampaign: { include: { merchant: true } },
    },
  });
  const byEntityId = new Map();
  for (const row of coupons) {
    if (!row.entityId) continue;
    byEntityId.set(row.entityId, {
      supplierCampaign: row.supplierCampaign,
      merchant: row.supplierCampaign?.merchant || null,
    });
  }
  return byEntityId;
}

function withAllotmentFields(entity, related = {}) {
  const formatted = formatCouponEntityForClient(entity, { includeMeta: true });
  const allotment = buildAllotmentDisplayFields(entity, related);

  // Keep displayFields in sync for brand/expiry when enrichment improves them.
  if (formatted.cmsMeta?.displayFields) {
    if (!formatted.cmsMeta.displayFields.brandName && allotment.brandName) {
      formatted.cmsMeta.displayFields.brandName = allotment.brandName;
    }
    if (!formatted.cmsMeta.displayFields.expiryDate && allotment.expiryDate) {
      formatted.cmsMeta.displayFields.expiryDate = allotment.expiryDate;
    }
    if (!formatted.cmsMeta.displayFields.discountPercentage && allotment.discountPercentage) {
      formatted.cmsMeta.displayFields.discountPercentage = allotment.discountPercentage;
    }
    if (!formatted.cmsMeta.displayFields.couponLink && allotment.offerLink) {
      formatted.cmsMeta.displayFields.couponLink = allotment.offerLink;
    }
  }

  formatted.allotment = allotment;
  if (!formatted.advertiserName && allotment.brandName) {
    formatted.advertiserName = allotment.brandName;
  }
  return formatted;
}

export async function listCouponsForCms({
  page = 1,
  pageSize = 20,
  networkSource,
  search,
  brand,
  couponKind,
  status,
  campaignStatus,
  allottableOnly = false,
} = {}) {
  const { rows, total } = await listEntities({
    entityType: "coupon",
    networkSource,
    page,
    pageSize,
    search,
    brand,
    couponKind,
  });

  const campaignMap = await loadRelatedCampaignEntities(rows);
  const supplierMap = await loadLinkedSupplierContext(rows.map((row) => row.id).filter(Boolean));

  let filtered = rows.map((row) => {
    const parentId = row?.rawData?.campaign_id ?? row?.rawData?.campaignId ?? row?.rawData?.campaign?.id;
    const campaignEntity = parentId != null ? campaignMap.get(String(parentId)) : null;
    const linked = supplierMap.get(row.id) || {};
    return withAllotmentFields(row, {
      campaignEntity,
      supplierCampaign: linked.supplierCampaign || null,
      merchant: linked.merchant || null,
    });
  });

  if (status) {
    const needle = String(status).trim().toLowerCase();
    filtered = filtered.filter((row) => {
      const value = String(
        row.cmsMeta?.displayFields?.couponStatus || row.entityStatus || "",
      )
        .trim()
        .toLowerCase();
      return value === needle || value.includes(needle);
    });
  }

  const campaignStatusNeedle = campaignStatus
    ? String(campaignStatus).trim().toLowerCase()
    : allottableOnly
      ? "active"
      : null;

  if (campaignStatusNeedle) {
    filtered = filtered.filter((row) => {
      const value = String(
        row.cmsMeta?.displayFields?.campaignStatus || "Active",
      )
        .trim()
        .toLowerCase();
      return value === campaignStatusNeedle || value.includes(campaignStatusNeedle);
    });
  }

  const withMetrics = await attachOrderMetrics(filtered);

  return {
    rows: withMetrics,
    total: status || campaignStatusNeedle ? withMetrics.length : total,
    page,
    pageSize,
    totalPages: Math.max(Math.ceil((status || campaignStatusNeedle ? withMetrics.length : total) / pageSize), 1),
  };
}

export async function getCouponById(id) {
  const entity = await prisma.entity.findFirst({
    where: { id, entityType: "coupon" },
  });
  if (!entity) return null;

  const campaignMap = await loadRelatedCampaignEntities([entity]);
  const supplierMap = await loadLinkedSupplierContext([entity.id]);
  const parentId = entity?.rawData?.campaign_id ?? entity?.rawData?.campaignId ?? entity?.rawData?.campaign?.id;
  const campaignEntity = parentId != null ? campaignMap.get(String(parentId)) : null;
  const linked = supplierMap.get(entity.id) || {};

  const [withMetrics] = await attachOrderMetrics([
    withAllotmentFields(entity, {
      campaignEntity,
      supplierCampaign: linked.supplierCampaign || null,
      merchant: linked.merchant || null,
    }),
  ]);
  return withMetrics || null;
}

export async function createManualCoupon({ fields = {}, fieldPolicies = {}, fieldTypes = {} }) {
  const externalId = `manual-${randomUUID()}`;
  const withDefaults = {
    campaignStatus: "Active",
    ...fields,
  };
  const merged = applyManualCouponFields(
    { networkSource: "manual" },
    withDefaults,
    fieldPolicies,
    fieldTypes,
  );

  const entity = await prisma.entity.create({
    data: {
      externalId,
      networkSource: "manual",
      entityType: "coupon",
      isManual: true,
      manualData: merged.manualData,
      fieldPolicies: merged.fieldPolicies,
      lastSyncedData: null,
      hasSyncConflict: false,
      normalizedData: merged.normalizedData,
      rawData: merged.rawData,
      ...buildStructuredFieldsFromNormalized(merged.normalizedData),
    },
  });

  return formatCouponEntityForClient(entity, { includeMeta: true });
}

export async function updateCoupon(id, { fields, fieldPolicies, fieldTypes, resolveConflict } = {}) {
  const existing = await prisma.entity.findFirst({
    where: { id, entityType: "coupon" },
  });
  if (!existing) throw new Error("Coupon not found");

  const currentManual = existing.manualData && typeof existing.manualData === "object" ? existing.manualData : {};
  const currentPolicies =
    existing.fieldPolicies && typeof existing.fieldPolicies === "object" ? existing.fieldPolicies : {};
  const currentFieldTypes =
    existing.normalizedData && typeof existing.normalizedData === "object"
      ? existing.normalizedData.field_types && typeof existing.normalizedData.field_types === "object"
        ? existing.normalizedData.field_types
        : {}
      : {};

  const nextManual = fields ? { ...currentManual, ...fields } : currentManual;
  const nextPolicies = fieldPolicies ? { ...currentPolicies, ...fieldPolicies } : currentPolicies;
  const nextFieldTypes = fieldTypes ? { ...currentFieldTypes, ...fieldTypes } : currentFieldTypes;

  if (resolveConflict && existing.lastSyncedData) {
    const syncedFields = extractCouponFieldsFromNormalized(existing.lastSyncedData);
    for (const [fieldKey, choice] of Object.entries(resolveConflict)) {
      if (choice === "sync" && Object.prototype.hasOwnProperty.call(syncedFields, fieldKey)) {
        nextManual[fieldKey] = syncedFields[fieldKey];
        nextPolicies[fieldKey] = "sync";
      } else if (choice === "manual") {
        nextPolicies[fieldKey] = "manual";
      }
    }
  }

  for (const key of Object.keys(nextManual)) {
    if (!nextPolicies[key]) nextPolicies[key] = "manual";
  }

  const merged = applyManualCouponFields(existing, nextManual, nextPolicies, nextFieldTypes);

  let hasSyncConflict = false;
  if (existing.lastSyncedData) {
    const syncedFields = extractCouponFieldsFromNormalized(existing.lastSyncedData);
    for (const [fieldKey, manualValue] of Object.entries(nextManual)) {
      if ((nextPolicies[fieldKey] || "manual") === "manual" && syncedFields[fieldKey] !== undefined) {
        const a = manualValue === null || manualValue === undefined || manualValue === "" ? null : String(manualValue);
        const b =
          syncedFields[fieldKey] === null || syncedFields[fieldKey] === undefined || syncedFields[fieldKey] === ""
            ? null
            : String(syncedFields[fieldKey]);
        if (a !== b) hasSyncConflict = true;
      }
    }
  }

  const entity = await prisma.entity.update({
    where: { id },
    data: {
      manualData: merged.manualData,
      fieldPolicies: merged.fieldPolicies,
      normalizedData: merged.normalizedData,
      rawData: merged.rawData,
      hasSyncConflict,
      ...buildStructuredFieldsFromNormalized(merged.normalizedData),
    },
  });

  return formatCouponEntityForClient(entity, { includeMeta: true });
}

export async function deleteCoupon(id) {
  const existing = await prisma.entity.findFirst({
    where: { id, entityType: "coupon" },
  });
  if (!existing) throw new Error("Coupon not found");

  await prisma.entity.delete({ where: { id } });
  return { ok: true };
}

export async function upsertCouponFromSync({
  networkSource,
  rawData,
  externalId,
  normalizedData,
}) {
  const existing = await prisma.entity.findUnique({
    where: {
      externalId_networkSource_entityType: {
        externalId,
        networkSource,
        entityType: "coupon",
      },
    },
  });

  if (!existing) {
    const entity = await prisma.entity.create({
      data: {
        externalId,
        networkSource,
        entityType: "coupon",
        normalizedData,
        rawData,
        ...buildStructuredFieldsFromNormalized(normalizedData),
      },
    });
    return entity;
  }

  if (existing.isManual && existing.networkSource === "manual") {
    return existing;
  }

  const hasManualEdits =
    existing.manualData &&
    typeof existing.manualData === "object" &&
    Object.keys(existing.manualData).length > 0;

  if (!hasManualEdits) {
    return prisma.entity.update({
      where: { id: existing.id },
      data: {
        normalizedData,
        rawData,
        lastSyncedData: normalizedData,
        hasSyncConflict: false,
        ...buildStructuredFieldsFromNormalized(normalizedData),
      },
    });
  }

  const merged = mergeCouponSyncData({
    existingEntity: existing,
    syncedNormalized: normalizedData,
    syncedRaw: rawData,
  });

  return prisma.entity.update({
    where: { id: existing.id },
    data: {
      normalizedData: buildNormalizedFromCouponFields(
        extractCouponFieldsFromNormalized(merged.normalizedData),
        networkSource,
      ),
      rawData: merged.rawData,
      lastSyncedData: merged.lastSyncedData,
      hasSyncConflict: merged.hasSyncConflict,
      manualData: merged.manualData,
      fieldPolicies: merged.fieldPolicies,
      ...buildStructuredFieldsFromNormalized(merged.normalizedData),
    },
  });
}

export function getCouponCampaignStatus(entityOrFormatted) {
  return (
    entityOrFormatted?.cmsMeta?.displayFields?.campaignStatus ||
    entityOrFormatted?.normalizedData?.campaign_status ||
    entityOrFormatted?.manualData?.campaignStatus ||
    "Active"
  );
}

export async function assertCouponAllottable(couponEntityId) {
  const coupon = await getCouponById(couponEntityId);
  if (!coupon) throw fail("Coupon CMS campaign not found.", 404);
  if (!isCampaignStatusAllottable(getCouponCampaignStatus(coupon))) {
    throw fail(
      `Campaign "${coupon.campaignName || coupon.cmsMeta?.displayFields?.campaignName || couponEntityId}" is Paused and cannot be newly allotted.`,
      409,
    );
  }
  return coupon;
}

export function formatCouponsForDashboard(rows = []) {
  return rows.map((row) => formatCouponEntityForClient(row));
}
