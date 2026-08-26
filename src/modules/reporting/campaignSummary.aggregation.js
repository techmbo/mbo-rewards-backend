/**
 * Campaign Summary aggregation from NetworkPerformanceFact (P1.14 canonical).
 * Grain: campaign identity (campaignSourceId → supplierCampaignDbId → supplier:supplierCampaignId)
 *        × currency (never mix currencies).
 *
 * Metrics (workbook):
 * - Clicks → 04A linkClicks → mboLinkClicks (never copy networkClicks)
 * - Conversions → 04A grossOrders
 * - Gross Commission → 04A grossCommission
 * - Client / Platform → 07A–07C from confirmedCommission (net) + ClientCommissionRule
 * - CVR / EPC derived when inputs available; never fabricate 0 from missing
 */

import { prisma } from "../../database/prisma.js";
import {
  applyCommissionRuleToGross,
  computeConversionRate,
  computeEpc,
} from "./attributionMath.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

function endOfUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

function startOfUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function buildNetworkPerformanceWhere(filters = {}) {
  const where = {};
  if (filters.campaignSourceId) where.campaignSourceId = filters.campaignSourceId;
  if (filters.country) where.country = String(filters.country).toUpperCase().slice(0, 2);
  if (filters.supplier) where.supplier = String(filters.supplier).toUpperCase();
  if (filters.from || filters.to) {
    where.reportDate = {};
    if (filters.from) where.reportDate.gte = startOfUtcDay(filters.from);
    if (filters.to) where.reportDate.lte = endOfUtcDay(filters.to);
  }
  return where;
}

function sumNullableInts(values) {
  let any = false;
  let sum = 0;
  for (const v of values) {
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    any = true;
    sum += n;
  }
  return any ? sum : null;
}

function sumNullableDecimals(values) {
  let any = false;
  let sum = 0;
  for (const v of values) {
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    any = true;
    sum += n;
  }
  return any ? sum : null;
}

function campaignGrainKey(fact) {
  if (fact.campaignSourceId) return `cs:${fact.campaignSourceId}`;
  if (fact.supplierCampaignDbId) return `scdb:${fact.supplierCampaignDbId}`;
  const sid = fact.supplierCampaignId != null ? String(fact.supplierCampaignId) : "";
  return `sup:${fact.supplier}:${sid || fact.campaignName || "unknown"}`;
}

/**
 * Aggregate NetworkPerformanceFact rows into campaign-level summary buckets.
 * @returns {Promise<{ rows: object[], total: number }>}
 */
export async function aggregateCampaignSummaryFromFacts(
  filters = {},
  { skip = 0, take = 25 } = {},
  client = null,
) {
  const db = resolveClient(client);
  const where = buildNetworkPerformanceWhere(filters);

  const facts = await db.networkPerformanceFact.findMany({
    where,
    select: {
      id: true,
      campaignSourceId: true,
      supplierCampaignDbId: true,
      supplierCampaignId: true,
      supplier: true,
      brandName: true,
      campaignName: true,
      currency: true,
      networkClicks: true,
      mboLinkClicks: true,
      grossOrders: true,
      confirmedOrders: true,
      grossCommission: true,
      confirmedCommission: true,
      epc: true,
      conversionRate: true,
    },
  });

  /** @type {Map<string, object>} */
  const buckets = new Map();
  for (const fact of facts) {
    const currency = fact.currency ? String(fact.currency).toUpperCase() : null;
    const key = `${campaignGrainKey(fact)}::${currency || "UNK"}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        grainKey: key,
        campaignSourceId: fact.campaignSourceId || null,
        supplierCampaignDbId: fact.supplierCampaignDbId || null,
        supplierCampaignId: fact.supplierCampaignId || null,
        supplier: fact.supplier,
        brandName: fact.brandName || null,
        campaignName: fact.campaignName || null,
        currency,
        mboLinkClicks: [],
        networkClicks: [],
        grossOrders: [],
        confirmedOrders: [],
        grossCommission: [],
        confirmedCommission: [],
        epcSamples: [],
      };
      buckets.set(key, bucket);
    } else {
      if (!bucket.brandName && fact.brandName) bucket.brandName = fact.brandName;
      if (!bucket.campaignName && fact.campaignName) bucket.campaignName = fact.campaignName;
      if (!bucket.campaignSourceId && fact.campaignSourceId) {
        bucket.campaignSourceId = fact.campaignSourceId;
      }
    }
    bucket.mboLinkClicks.push(fact.mboLinkClicks);
    bucket.networkClicks.push(fact.networkClicks);
    bucket.grossOrders.push(fact.grossOrders);
    bucket.confirmedOrders.push(fact.confirmedOrders);
    bucket.grossCommission.push(fact.grossCommission);
    bucket.confirmedCommission.push(fact.confirmedCommission);
    if (fact.epc != null) bucket.epcSamples.push(Number(fact.epc));
  }

  const sourceIds = [...new Set([...buckets.values()].map((b) => b.campaignSourceId).filter(Boolean))];

  const sources =
    sourceIds.length > 0
      ? await db.campaignSource.findMany({
          where: { id: { in: sourceIds } },
          select: {
            id: true,
            canonicalCampaignId: true,
            canonicalCampaign: {
              select: {
                id: true,
                displayName: true,
                merchant: { select: { id: true, displayName: true } },
              },
            },
            supplierCampaign: {
              select: {
                id: true,
                supplier: true,
                campaignName: true,
                merchantNameRaw: true,
              },
            },
            assignments: {
              take: 8,
              select: {
                id: true,
                commissionRules: {
                  where: { status: "EFFECTIVE" },
                  orderBy: { effectiveFrom: "desc" },
                  take: 1,
                  select: {
                    id: true,
                    grossCommission: true,
                    clientCommission: true,
                    mboCommission: true,
                    commissionType: true,
                    status: true,
                  },
                },
              },
            },
          },
        })
      : [];

  const sourceById = new Map(sources.map((s) => [s.id, s]));

  const scDbIds = [
    ...new Set(
      [...buckets.values()]
        .filter((b) => !b.campaignSourceId && b.supplierCampaignDbId)
        .map((b) => b.supplierCampaignDbId),
    ),
  ];
  const supplierCampaigns =
    scDbIds.length > 0
      ? await db.supplierCampaign.findMany({
          where: { id: { in: scDbIds } },
          select: {
            id: true,
            supplier: true,
            campaignName: true,
            merchantNameRaw: true,
          },
        })
      : [];
  const scById = new Map(supplierCampaigns.map((s) => [s.id, s]));

  let rows = [];
  for (const bucket of buckets.values()) {
    const mboClicks = sumNullableInts(bucket.mboLinkClicks);
    const networkClicks = sumNullableInts(bucket.networkClicks);
    // 04A linkClicks = MBO tracked clicks — never substitute networkClicks into this field.
    const clickCount = mboClicks;
    const conversionCount = sumNullableInts(bucket.grossOrders);
    const approvedConversionCount = sumNullableInts(bucket.confirmedOrders);
    const grossCommission = sumNullableDecimals(bucket.grossCommission);
    const confirmedCommission = sumNullableDecimals(bucket.confirmedCommission);

    const source = bucket.campaignSourceId ? sourceById.get(bucket.campaignSourceId) : null;
    const sc =
      source?.supplierCampaign ||
      (bucket.supplierCampaignDbId ? scById.get(bucket.supplierCampaignDbId) : null);

    const campaignName =
      source?.canonicalCampaign?.displayName ||
      sc?.campaignName ||
      bucket.campaignName ||
      null;
    const brandName =
      source?.canonicalCampaign?.merchant?.displayName ||
      sc?.merchantNameRaw ||
      bucket.brandName ||
      null;

    const dimensionId =
      source?.canonicalCampaignId ||
      bucket.campaignSourceId ||
      bucket.supplierCampaignDbId ||
      `${bucket.supplier}:${bucket.supplierCampaignId || campaignName || "unknown"}`;

    // 07A–07C: client payable from confirmed (net) supplier commission + EFFECTIVE rule.
    // Never copy gross into client; never invent platform share without a rule.
    let clientCommission = null;
    let mboCommission = null;
    const rule = source?.assignments?.flatMap((a) => a.commissionRules || [])?.[0] || null;
    const splitBase = confirmedCommission != null ? confirmedCommission : null;
    if (rule && splitBase != null) {
      const split = applyCommissionRuleToGross(splitBase, rule);
      if (split.ok) {
        clientCommission = split.clientCommission;
        mboCommission = split.mboCommission;
      }
    }

    // EPC: prefer supplier-provided samples when present; else derive grossCommission / linkClicks.
    let epc = null;
    if (bucket.epcSamples.length > 0) {
      epc = Number(
        (
          bucket.epcSamples.reduce((a, b) => a + b, 0) / bucket.epcSamples.length
        ).toFixed(4),
      );
    } else if (clickCount != null && clickCount > 0 && grossCommission != null) {
      epc = computeEpc(grossCommission, clickCount);
    }

    // CVR = conversions/clicks (ratio); DTO formats ×100 for display contract.
    const conversionRate =
      clickCount != null && clickCount > 0 && conversionCount != null
        ? computeConversionRate(conversionCount, clickCount)
        : null;

    rows.push({
      dimensionKey: "campaign",
      dimensionId,
      campaignSourceId: bucket.campaignSourceId,
      canonicalCampaignId: source?.canonicalCampaignId || null,
      campaignName,
      brandName,
      supplier: sc?.supplier || bucket.supplier || null,
      currency: bucket.currency,
      clickCount,
      networkClickCount: networkClicks,
      conversionCount,
      approvedConversionCount,
      grossCommission,
      confirmedCommission,
      clientCommission,
      mboCommission,
      conversionRate,
      epc,
    });
  }

  // Prefer rows with a real campaign name; then by clicks/conversions presence.
  rows.sort((a, b) => {
    const aScore = (a.clickCount || 0) + (a.conversionCount || 0) + (Number(a.grossCommission) || 0);
    const bScore = (b.clickCount || 0) + (b.conversionCount || 0) + (Number(b.grossCommission) || 0);
    return bScore - aScore;
  });

  if (filters.canonicalCampaignId) {
    rows = rows.filter((r) => r.canonicalCampaignId === filters.canonicalCampaignId);
  }
  if (filters.merchantId) {
    const allowed = new Set(
      sources
        .filter((s) => s.canonicalCampaign?.merchant?.id === filters.merchantId)
        .map((s) => s.id),
    );
    rows = rows.filter((r) => r.campaignSourceId && allowed.has(r.campaignSourceId));
  }

  const total = rows.length;
  const page = rows.slice(skip, skip + take);
  return { rows: page, total };
}
