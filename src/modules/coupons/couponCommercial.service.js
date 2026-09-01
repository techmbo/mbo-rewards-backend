import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { toClientCampaignAssignmentDto } from "../client/dto/client.dto.js";

function supplierDisplayName(supplierCampaign) {
  if (!supplierCampaign) return null;
  if (supplierCampaign.supplierRef?.displayName) return supplierCampaign.supplierRef.displayName;
  const key = String(supplierCampaign.supplier || "").trim();
  if (!key) return null;
  return key
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeCampaignName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function extractOrderValue(conversion) {
  const meta = conversion?.metadata && typeof conversion.metadata === "object" ? conversion.metadata : {};
  const candidates = [
    meta.orderValue,
    meta.order_value,
    meta.saleAmount,
    meta.sales_amount,
    meta.sales_amount_usd,
    meta.conversionValue?.amount,
    meta.origConversionValue?.amount,
    meta.rawConversionValue?.amount,
  ];
  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function emptyBucket() {
  return {
    grossOrders: 0,
    netOrders: 0,
    grossOrderValue: 0,
    netOrderValue: 0,
    currency: null,
    source: "none",
  };
}

function finalizeBucket(bucket) {
  bucket.grossOrders = Math.round(bucket.grossOrders);
  bucket.netOrders = Math.round(bucket.netOrders);
  bucket.grossOrderValue = Number(bucket.grossOrderValue.toFixed(4));
  bucket.netOrderValue = Number(bucket.netOrderValue.toFixed(4));
  return bucket;
}

/**
 * Collect campaign names that can match synced performance/conversion entities.
 */
export function collectCampaignNamesForAssignment(record) {
  const names = new Set();
  const push = (value) => {
    const normalized = normalizeCampaignName(value);
    if (normalized) names.add(normalized);
  };

  push(record?.canonicalCampaign?.displayName);
  push(record?.campaignSource?.supplierCampaign?.campaignName);

  for (const source of record?.canonicalCampaign?.sources || []) {
    push(source?.supplierCampaign?.campaignName);
  }

  for (const couponAssignment of record?.couponAssignments || []) {
    push(couponAssignment?.supplierCoupon?.supplierCampaign?.campaignName);
    const raw = couponAssignment?.supplierCoupon?.entity?.rawData;
    if (raw && typeof raw === "object") {
      push(raw.campaign_name || raw.campaignName || raw.campaign?.name);
    }
  }

  return [...names];
}

function readPerformanceMetrics(rawData) {
  const raw = rawData && typeof rawData === "object" ? rawData : {};
  return {
    campaignName: normalizeCampaignName(raw.campaignName || raw.campaign_name || raw.campaign?.name),
    grossOrders: toNumber(raw.orders ?? raw.totalConversions ?? raw.gross_orders),
    netOrders: toNumber(raw.net_orders ?? raw.validatedConversions ?? raw.approvedConversions),
    grossOrderValue: toNumber(raw.sales_amount_usd ?? raw.originalOrderValue ?? raw.sales_amount ?? raw.revenue),
    netOrderValue: toNumber(raw.net_sales_amount_usd ?? raw.net_sales_amount),
    currency: raw.targetCurrencyCode || raw.currency || raw.currencyCode || null,
  };
}

/**
 * Sum synced performance rows keyed by normalized campaign name.
 * Used for Assignments and Coupon CMS allotment lists.
 */
export async function aggregateOrderMetricsByCampaignNames(campaignNames = []) {
  const map = new Map();
  const names = [
    ...new Set(
      campaignNames
        .map((name) => normalizeCampaignName(name))
        .filter(Boolean),
    ),
  ];
  for (const name of names) {
    map.set(name, emptyBucket());
  }
  if (!names.length) return map;

  const performanceRows = await prisma.entity.findMany({
    where: {
      entityType: { in: ["performance", "conversion"] },
    },
    select: {
      entityType: true,
      rawData: true,
    },
  });

  const wanted = new Set(names);
  for (const entity of performanceRows) {
    const metrics = readPerformanceMetrics(entity.rawData);
    if (!metrics.campaignName || !wanted.has(metrics.campaignName)) continue;
    const bucket = map.get(metrics.campaignName);
    if (!bucket) continue;
    bucket.source = "performance_entity";
    bucket.grossOrders += metrics.grossOrders;
    bucket.netOrders += metrics.netOrders;
    bucket.grossOrderValue += metrics.grossOrderValue;
    bucket.netOrderValue += metrics.netOrderValue;
    if (metrics.currency && !bucket.currency) bucket.currency = metrics.currency;
  }

  for (const bucket of map.values()) {
    finalizeBucket(bucket);
  }
  return map;
}

/**
 * Aggregate Gross / Net order counts (and values) per assignment.
 * Prefer attributed Conversion rows; fall back to synced Entity performance
 * matched by campaign name so Assignments reflect supplier sync data.
 */
export async function aggregateOrderMetricsByAssignmentIds(assignmentIds = [], assignmentRows = []) {
  const ids = [...new Set(assignmentIds.filter(Boolean))];
  const map = new Map();
  for (const id of ids) {
    map.set(id, emptyBucket());
  }
  if (!ids.length) return map;

  const conversions = await prisma.conversion.findMany({
    where: { clientAssignmentId: { in: ids } },
    select: {
      clientAssignmentId: true,
      status: true,
      supplierCommission: true,
      approvedCommission: true,
      currency: true,
      metadata: true,
    },
  });

  for (const conversion of conversions) {
    const bucket = map.get(conversion.clientAssignmentId);
    if (!bucket) continue;
    if (conversion.currency && !bucket.currency) bucket.currency = conversion.currency;

    const isNet = conversion.status === "APPROVED" || conversion.status === "PAID";
    bucket.source = "conversion";
    bucket.grossOrders += 1;
    if (isNet) bucket.netOrders += 1;

    const orderValue = extractOrderValue(conversion);
    if (orderValue != null) {
      bucket.grossOrderValue += orderValue;
      if (isNet) bucket.netOrderValue += orderValue;
      continue;
    }

    const gross = toNumber(conversion.supplierCommission);
    const net = toNumber(conversion.approvedCommission ?? (isNet ? conversion.supplierCommission : 0));
    bucket.grossOrderValue += gross;
    bucket.netOrderValue += net;
  }

  const needsFallback = [...map.entries()].filter(([, bucket]) => bucket.source === "none");
  if (needsFallback.length && assignmentRows.length) {
    await applyPerformanceEntityFallback(map, assignmentRows);
  }

  for (const bucket of map.values()) {
    finalizeBucket(bucket);
  }

  return map;
}

/**
 * Sum synced performance Entity rows for assignments that have no attributed conversions yet.
 */
async function applyPerformanceEntityFallback(map, assignmentRows) {
  const nameToAssignmentIds = new Map();

  for (const row of assignmentRows) {
    if (!row?.id || !map.has(row.id)) continue;
    if (map.get(row.id).source !== "none") continue;
    for (const name of collectCampaignNamesForAssignment(row)) {
      if (!nameToAssignmentIds.has(name)) nameToAssignmentIds.set(name, new Set());
      nameToAssignmentIds.get(name).add(row.id);
    }
  }

  const campaignNames = [...nameToAssignmentIds.keys()];
  if (!campaignNames.length) return;

  const performanceRows = await prisma.entity.findMany({
    where: {
      entityType: { in: ["performance", "conversion"] },
    },
    select: {
      entityType: true,
      networkSource: true,
      rawData: true,
    },
  });

  for (const entity of performanceRows) {
    const metrics = readPerformanceMetrics(entity.rawData);
    if (!metrics.campaignName) continue;
    const assignmentIds = nameToAssignmentIds.get(metrics.campaignName);
    if (!assignmentIds?.size) continue;

    for (const assignmentId of assignmentIds) {
      const bucket = map.get(assignmentId);
      if (!bucket || bucket.source === "conversion") continue;
      bucket.source = "performance_entity";
      bucket.grossOrders += metrics.grossOrders;
      bucket.netOrders += metrics.netOrders;
      bucket.grossOrderValue += metrics.grossOrderValue;
      bucket.netOrderValue += metrics.netOrderValue;
      if (metrics.currency && !bucket.currency) bucket.currency = metrics.currency;
    }
  }
}

export function collectSuppliersForAssignment(record) {
  const names = [];
  const seen = new Set();

  function push(name) {
    const label = String(name || "").trim();
    if (!label) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(label);
  }

  push(supplierDisplayName(record?.campaignSource?.supplierCampaign));

  const sources = record?.canonicalCampaign?.sources || [];
  for (const source of sources) {
    push(supplierDisplayName(source?.supplierCampaign));
  }

  for (const couponAssignment of record?.couponAssignments || []) {
    push(supplierDisplayName(couponAssignment?.supplierCoupon?.supplierCampaign));
  }

  return names;
}

export async function listCommercialContextForCoupon(couponEntityId) {
  if (!couponEntityId) throw fail("Coupon id is required.", 400);

  const { toCommissionRuleDto } = await import("../commercial/dto/commercial.dto.js");

  const supplierCoupon = await prisma.supplierCoupon.findFirst({
    where: { entityId: couponEntityId },
    include: {
      supplierCampaign: {
        include: {
          campaignSources: {
            include: {
              canonicalCampaign: true,
            },
          },
        },
      },
    },
  });

  if (!supplierCoupon?.supplierCampaign) {
    return {
      couponEntityId,
      canonicalCampaignIds: [],
      assignments: [],
      commissionRules: [],
    };
  }

  const canonicalCampaignIds = [
    ...new Set(
      (supplierCoupon.supplierCampaign.campaignSources || [])
        .map((source) => source.canonicalCampaignId)
        .filter(Boolean),
    ),
  ];

  if (!canonicalCampaignIds.length) {
    return {
      couponEntityId,
      canonicalCampaignIds: [],
      assignments: [],
      commissionRules: [],
    };
  }

  const assignments = await prisma.clientCampaignAssignment.findMany({
    where: {
      canonicalCampaignId: { in: canonicalCampaignIds },
      status: { not: "REVOKED" },
    },
    include: {
      client: { select: { id: true, name: true, slug: true, status: true } },
      canonicalCampaign: { select: { id: true, displayName: true } },
    },
    orderBy: [{ createdAt: "desc" }],
    take: 100,
  });

  const assignmentIds = assignments.map((row) => row.id);
  const rules = assignmentIds.length
    ? await prisma.clientCommissionRule.findMany({
        where: { assignmentId: { in: assignmentIds } },
        orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
      })
    : [];

  return {
    couponEntityId,
    canonicalCampaignIds,
    assignments: assignments.map((row) => ({
      ...toClientCampaignAssignmentDto(row),
      client: row.client,
      canonicalCampaign: row.canonicalCampaign,
    })),
    commissionRules: rules.map((row) => toCommissionRuleDto(row)),
  };
}
