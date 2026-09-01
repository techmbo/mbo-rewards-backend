import { prisma } from "../../../database/prisma.js";
import { logger } from "../../../platform/logging/logger.js";
import { parseNetworkSource, parseSourceAccountLabel } from "../../supplier/entityIdentity.js";
import { findLatestRawPayloadForEntity } from "../../raw/rawPayload.service.js";
import { OrderIngestionService } from "../../order/orderIngestion.service.js";
import { ExceptionCaseService } from "../../order/exceptionCase.service.js";
import {
  assertPromotableConversionIdentity,
  buildConversionDedupeKey,
  enrichConversionIngestMetadata,
  isPromotableConversionRow,
  mapRawOrderItems,
} from "../../order/orderConversionIngestion.contract.js";
import { extractAttributionHints } from "../attributionLogic.contract.js";
import {
  buildOrderStatusMetadata,
  mapMboOrderStatusToConversionStatus,
  resolveOrderStatusFromNetworkRaw,
} from "../../order/orderStatusNormalization.contract.js";
import { extractOptimiseConversionFields } from "../../supplier/mappers/optimise.mapper.js";
import { AttributionService } from "./attribution.service.js";

export {
  extractNetworkConversionId as extractSupplierConversionId,
} from "../../order/orderConversionIngestion.contract.js";
export { extractAttributionHints } from "../attributionLogic.contract.js";

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object" && value.amount != null) return toNumberOrNull(value.amount);
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toDateOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Skip aggregate / payment-grain rows that are not individual conversion truth.
 */
export function isPromotableConversionEntity(entity) {
  return isPromotableConversionRow(entity);
}

export function extractOrderItems(rawData) {
  return mapRawOrderItems(rawData);
}

export function mapEntityToConversionIngest(entity) {
  const raw = asObject(entity.rawData);
  const normalized = asObject(entity.normalizedData);
  const { supplier } = parseNetworkSource(entity.networkSource);
  const { sourceAccountLabel } = parseSourceAccountLabel(entity.externalId);
  const identity = assertPromotableConversionIdentity(entity);
  if (!identity.ok) {
    return { ok: false, reason: identity.reason };
  }
  const supplierConversionId = identity.supplierConversionId;
  if (supplier === "UNKNOWN") {
    return { ok: false, reason: "unknown_supplier" };
  }

  const optimise =
    supplier === "OPTIMISE" ? extractOptimiseConversionFields(raw) : null;
  const hints = extractAttributionHints(raw);
  if (optimise?.assignmentIdHint && !hints.assignmentId) {
    hints.assignmentId = String(optimise.assignmentIdHint);
  }
  if (optimise?.clientIdHint && !hints.clientId) {
    hints.clientId = String(optimise.clientIdHint);
  }
  if (optimise?.couponCode && !hints.couponCode) {
    hints.couponCode = String(optimise.couponCode);
  }

  // Prefer Optimise conversion commission fields; never campaign headline / Product.price.
  // Boostiny order-level performance uses net_revenue / revenue (not "commission").
  const supplierCommission =
    optimise?.supplierCommission != null
      ? optimise.supplierCommission
      : toNumberOrNull(
          first(
            raw.commission,
            raw.validatedCommission,
            raw.pendingCommission,
            raw.totalCommission,
            raw.commissionValue,
            raw.payout,
            raw.Payout,
            raw.ActionEarnings,
            raw.payout_value,
            raw?.cost?.amount,
            raw?.commission?.amount,
            raw?.payout?.amount,
            raw.net_revenue,
            raw.revenue,
            normalized.commission,
            entity.commission,
          ),
        );

  if (supplierCommission == null) {
    return { ok: false, reason: "missing_supplier_commission" };
  }
  if (supplierCommission < 0) {
    return { ok: false, reason: "negative_supplier_commission" };
  }

  const approvedCommission =
    optimise?.approvedCommission != null
      ? optimise.approvedCommission
      : toNumberOrNull(first(raw.validatedCommission, raw.approvedCommission));

  const rawStatusValue = first(
    optimise?.status,
    raw.status,
    raw.State,
    raw.state,
    raw.paymentStatus,
    raw.PaymentStatus,
    normalized.status,
    entity.entityStatus,
  );
  const statusResolution = resolveOrderStatusFromNetworkRaw(rawStatusValue, { supplier });
  const networkRawStatus = statusResolution.networkRawStatus;
  const mboOrderStatus = statusResolution.mboOrderStatus;
  const conversionStatus =
    mapMboOrderStatusToConversionStatus(mboOrderStatus) ??
    (statusResolution.mappingExceptionRequired ? "UNKNOWN" : "PENDING");

  const conversionDate = toDateOrNull(
    first(
      optimise?.conversionDate,
      raw.conversionDate,
      raw.conversion_date,
      raw.EventDate,
      raw.CreationDate,
      raw.date,
      raw.created,
      raw.createdAt,
      entity.eventDate,
    ),
  );
  // Do not invent conversionDate from "now" / sync time.
  if (!conversionDate) {
    return { ok: false, reason: "missing_conversion_date" };
  }

  const currency = first(
    optimise?.currency,
    raw.currency,
    raw.Currency,
    raw.PayoutCurrency,
    raw.currencyCode,
    raw?.cost?.currency,
    raw?.conversionValue?.currency,
    raw?.transactionValue?.currency,
    raw?.commission?.currency,
  );

  const orderValue =
    optimise?.orderValue != null
      ? optimise.orderValue
      : toNumberOrNull(
          first(
            raw.originalOrderValue,
            raw?.conversionValue?.amount,
            raw.validatedItemValue,
            raw.net_sales_amount,
            raw.sales_amount,
            raw.net_sales_amount_usd,
            raw.sales_amount_usd,
            raw.saleAmount,
            raw.SaleAmount,
            raw?.transactionValue?.amount,
            normalized.revenue,
            entity.revenue,
          ),
        );

  const supplierOrderId = first(
    optimise?.supplierOrderId,
    raw.orderId,
    raw.order_id,
    raw.Oid,
    raw.OrderId,
    raw.supplierOrderId,
    raw.supplier_order_id,
    raw.originalOrderId,
    raw.merchantOrderId,
  );

  const supplierCampaignId = first(
    optimise?.supplierCampaignId,
    raw.campaignId,
    raw.campaign_id,
    raw.productId,
  );
  const publisherCampaignId = first(
    optimise?.publisherCampaignId,
    raw.publisherCampaignId,
    raw.publisher_campaign_id,
  );
  const campaignName = first(
    optimise?.campaignName,
    entity.campaignName,
    raw.campaignName,
    raw.campaign_name,
    normalized.campaign_name,
  );
  const advertiserName = first(
    optimise?.advertiserName,
    entity.advertiserName,
    raw.advertiserName,
    raw.advertiser_name,
    raw.companyName,
  );

  return {
    ok: true,
    input: {
      supplier,
      supplierConversionId,
      sourceAccountLabel,
      clickId: hints.clickId,
      subId: hints.subId,
      trackingLinkId: null,
      supplierCommission: supplierCommission.toFixed(4),
      approvedCommission: approvedCommission != null ? approvedCommission.toFixed(4) : null,
      currency: currency ? String(currency).slice(0, 3).toUpperCase() : null,
      status: conversionStatus,
      conversionDate,
      approvedDate: mboOrderStatus === "CONFIRMED" ? conversionDate : null,
      metadata: enrichConversionIngestMetadata(
        buildOrderStatusMetadata(
          {
            entityId: entity.id,
            networkSource: entity.networkSource,
            externalId: entity.externalId,
            attributionHints: hints,
            couponCode: hints.couponCode,
            country: raw.country ?? null,
            orderValue,
            supplierOrderId: supplierOrderId != null ? String(supplierOrderId) : null,
            supplierCampaignId: supplierCampaignId != null ? String(supplierCampaignId) : null,
            publisherCampaignId: publisherCampaignId != null ? String(publisherCampaignId) : null,
            campaignName: campaignName != null ? String(campaignName) : null,
            advertiserName: advertiserName != null ? String(advertiserName) : null,
            merchantName: advertiserName != null ? String(advertiserName) : null,
            confirmedDate:
              mboOrderStatus === "CONFIRMED"
                ? conversionDate?.toISOString?.() || conversionDate
                : null,
            rawStatus: networkRawStatus,
            promotedAt: new Date().toISOString(),
          },
          statusResolution,
        ),
        { supplier, sourceAccountLabel, supplierConversionId },
      ),
      _assignmentIdHint: hints.assignmentId,
      _order: {
        supplierOrderId: supplierOrderId != null ? String(supplierOrderId) : null,
        supplierConversionId,
        orderValue,
        currency: currency ? String(currency).slice(0, 3).toUpperCase() : null,
        orderDate: conversionDate,
        networkRawStatus,
        mboOrderStatus,
        statusMappingExceptionRequired: statusResolution.mappingExceptionRequired,
        items: extractOrderItems(raw),
      },
    },
  };
}

/**
 * Resolve merchant / campaignSource / canonical campaign for an order from network ids or coupon.
 * Best-effort — never invent client attribution here.
 */
export async function resolveOrderCatalogLinks(
  { supplier, supplierCampaignId, publisherCampaignId, couponCode },
  db,
) {
  if (!db?.supplierCampaign?.findFirst) {
    return {
      merchantId: null,
      canonicalCampaignId: null,
      campaignSourceId: null,
      campaignName: null,
      merchantName: null,
    };
  }

  const extIds = [...new Set([supplierCampaignId, publisherCampaignId].filter(Boolean).map(String))];
  let sc = null;
  if (extIds.length) {
    sc = await db.supplierCampaign.findFirst({
      where: { supplier, supplierCampaignId: { in: extIds } },
      include: {
        merchant: { select: { id: true, displayName: true } },
        campaignSources: {
          take: 1,
          orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
          select: { id: true, canonicalCampaignId: true },
        },
      },
    });
  }

  if (!sc && couponCode && db.supplierCoupon?.findFirst) {
    const coupon = await db.supplierCoupon.findFirst({
      where: {
        couponCode: { equals: String(couponCode).trim(), mode: "insensitive" },
        supplierCampaign: { supplier },
      },
      include: {
        supplierCampaign: {
          include: {
            merchant: { select: { id: true, displayName: true } },
            campaignSources: {
              take: 1,
              orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }],
              select: { id: true, canonicalCampaignId: true },
            },
          },
        },
      },
      orderBy: { lastSyncedAt: "desc" },
    });
    sc = coupon?.supplierCampaign || null;
  }

  const source = sc?.campaignSources?.[0] || null;
  return {
    merchantId: sc?.merchantId || sc?.merchant?.id || null,
    canonicalCampaignId: source?.canonicalCampaignId || null,
    campaignSourceId: source?.id || null,
    campaignName: sc?.campaignName || null,
    merchantName: sc?.merchant?.displayName || sc?.merchantNameRaw || null,
  };
}

export class ConversionPromotionService {
  constructor(deps = {}) {
    this.attribution = deps.attribution ?? new AttributionService();
    this.orders = deps.orders ?? new OrderIngestionService();
    this.exceptions = deps.exceptions ?? new ExceptionCaseService();
    this.prisma = deps.prisma ?? prisma;
  }

  async promoteEntity(entity, client = null) {
    if (!isPromotableConversionEntity(entity)) {
      return { result: "skipped", reason: "not_promotable" };
    }

    const mapped = mapEntityToConversionIngest(entity);
    if (!mapped.ok) {
      if (mapped.reason === "missing_network_conversion_id" || mapped.reason === "missing_supplier_conversion_id") {
        try {
          await this.exceptions.report({
            type: "MISSING_SUPPLIER_CONVERSION_ID",
            severity: "HIGH",
            entityId: entity.id,
            reason: mapped.reason,
            metadata: { networkSource: entity.networkSource, externalId: entity.externalId },
          });
        } catch {
          // ignore
        }
      }
      return { result: "skipped", reason: mapped.reason };
    }

    try {
      const rawRow = entity?.id ? await findLatestRawPayloadForEntity(entity.id, client) : null;
      const orderFacts = mapped.input._order || {};
      const meta = asObject(mapped.input.metadata);
      const db = client ?? this.prisma;
      let catalog = {
        merchantId: null,
        canonicalCampaignId: null,
        campaignSourceId: null,
        campaignName: null,
        merchantName: null,
      };
      try {
        catalog = await resolveOrderCatalogLinks(
          {
            supplier: mapped.input.supplier,
            supplierCampaignId: meta.supplierCampaignId,
            publisherCampaignId: meta.publisherCampaignId,
            couponCode: meta.couponCode,
          },
          db,
        );
      } catch {
        // Catalog enrichment is best-effort — never block conversion/order promotion.
      }

      const order = await this.orders.upsertOrder(
        {
          supplier: mapped.input.supplier,
          sourceAccountLabel: mapped.input.sourceAccountLabel,
          supplierOrderId: orderFacts.supplierOrderId,
          supplierConversionId: mapped.input.supplierConversionId,
          orderValue: orderFacts.orderValue,
          currency: orderFacts.currency,
          orderDate: orderFacts.orderDate,
          networkRawStatus: orderFacts.networkRawStatus ?? meta.network_raw_status ?? null,
          mboOrderStatus: orderFacts.mboOrderStatus ?? meta.mboOrderStatus ?? null,
          statusMappingExceptionRequired: orderFacts.statusMappingExceptionRequired ?? false,
          items: orderFacts.items,
          rawPayloadId: rawRow?.id ?? null,
          merchantId: catalog.merchantId,
          canonicalCampaignId: catalog.canonicalCampaignId,
          campaignSourceId: catalog.campaignSourceId,
          metadata: buildOrderStatusMetadata(
            {
              entityId: entity.id,
              networkSource: entity.networkSource,
              couponCode: meta.couponCode ?? null,
              supplierCampaignId: meta.supplierCampaignId ?? null,
              publisherCampaignId: meta.publisherCampaignId ?? null,
              campaignName: meta.campaignName || catalog.campaignName || null,
              advertiserName: meta.advertiserName || catalog.merchantName || null,
              merchantName: meta.merchantName || catalog.merchantName || null,
              confirmedDate: meta.confirmedDate ?? null,
              rawStatus: meta.rawStatus ?? meta.network_raw_status ?? null,
              dedupeKey: buildConversionDedupeKey({
                supplier: mapped.input.supplier,
                sourceAccountLabel: mapped.input.sourceAccountLabel,
                supplierConversionId: mapped.input.supplierConversionId,
              }),
              networkConversionId: mapped.input.supplierConversionId,
            },
            {
              networkRawStatus: orderFacts.networkRawStatus ?? meta.network_raw_status ?? null,
              mboOrderStatus: orderFacts.mboOrderStatus ?? meta.mboOrderStatus ?? null,
              mappingExceptionRequired: orderFacts.statusMappingExceptionRequired ?? false,
            },
          ),
        },
        client,
      );

      const conversion = await this.attribution.ingestConversion(
        {
          ...mapped.input,
          orderId: order?.id ?? null,
          rawPayloadId: rawRow?.id ?? mapped.input.rawPayloadId ?? null,
        },
        client,
      );
      if (rawRow?.id && this.prisma?.rawPayload?.update) {
        try {
          await this.prisma.rawPayload.update({
            where: { id: rawRow.id },
            data: { processingStatus: "PROMOTED", entityId: entity.id },
          });
        } catch {
          // Lineage status is best-effort.
        }
      }
      return {
        result: "promoted",
        conversionId: conversion?.id ?? null,
        orderId: order?.id ?? null,
        attributionStatus: conversion?.attributionStatus ?? null,
        entityId: entity.id,
        rawPayloadId: rawRow?.id ?? null,
      };
    } catch (error) {
      logger.warn(
        { entityId: entity.id, err: error.message },
        "conversion promotion failed",
      );
      return { result: "failed", reason: error.message, entityId: entity.id };
    }
  }

  async run({
    networkSource,
    entityIds,
    batchSize = 100,
    cursorId,
  } = {}) {
    const startedAt = Date.now();
    const summary = {
      processed: 0,
      promoted: 0,
      skipped: 0,
      failed: 0,
      durationMs: 0,
    };

    let cursor = cursorId;
    for (;;) {
      const batch = await this.prisma.entity.findMany({
        where: {
          entityType: "conversion",
          ...(networkSource ? { networkSource } : {}),
          ...(entityIds?.length ? { id: { in: entityIds } } : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: batchSize,
      });

      if (!batch.length) break;

      for (const entity of batch) {
        const outcome = await this.promoteEntity(entity);
        summary.processed += 1;
        if (outcome.result === "promoted") summary.promoted += 1;
        else if (outcome.result === "failed") summary.failed += 1;
        else summary.skipped += 1;
      }

      cursor = batch[batch.length - 1].id;
      if (batch.length < batchSize) break;
    }

    summary.durationMs = Date.now() - startedAt;
    return summary;
  }
}
