import { prisma } from "../../database/prisma.js";
import { isPrismaUniqueViolation } from "../../core/prismaErrors.js";
import { mapPayload } from "../mapping/engine.js";

function toDecimalString(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : null;
}

function normalizeAvailability(raw) {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v) return "UNKNOWN";
  // Optimise StockAvailability is often "1"/"0"
  if (v === "1" || v === "TRUE" || v === "YES" || v === "Y" || v === "AVAILABLE") return "IN_STOCK";
  if (v === "0" || v === "FALSE" || v === "NO" || v === "N" || v === "UNAVAILABLE") return "OUT_OF_STOCK";
  if (v.includes("IN") && v.includes("STOCK")) return "IN_STOCK";
  if (v.includes("OUT")) return "OUT_OF_STOCK";
  if (v.includes("PRE")) return "PREORDER";
  return "UNKNOWN";
}

/**
 * Wave F — normalized product catalog (current state).
 * Does NOT perform fuzzy merge across suppliers.
 */
export class ProductService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  async findSourceBySupplierProduct({ supplier, sourceAccountLabel = "default", supplierProductId }, client = null) {
    const db = client ?? this.db;
    return db.productSource.findUnique({
      where: {
        supplier_sourceAccountLabel_supplierProductId: {
          supplier,
          sourceAccountLabel,
          supplierProductId: String(supplierProductId),
        },
      },
      include: { product: true },
    });
  }

  /**
   * Ingest mapped product payload → Product + ProductSource (idempotent).
   */
  async ingestMappedProduct(
    {
      supplier,
      sourceAccountLabel = "default",
      mapped,
      rawPayloadId = null,
      mapperVersion = null,
      merchantId = null,
    },
    client = null,
  ) {
    const db = client ?? this.db;
    const n = mapped?.normalizedData || {};
    const supplierProductId = n.supplierProductId != null ? String(n.supplierProductId) : null;
    if (!supplierProductId) {
      return { ok: false, reason: "missing_supplier_product_id" };
    }
    const title = n.title != null ? String(n.title).trim() : null;
    if (!title) {
      return { ok: false, reason: "missing_product_title" };
    }

    const price = toDecimalString(n.price);
    const salePrice = toDecimalString(n.salePrice);
    const currency = n.currency ? String(n.currency).slice(0, 3).toUpperCase() : null;
    const availability = normalizeAvailability(n.availabilityRaw ?? n.availability);
    const epicFields = {
      productFeedId: n.productFeedId ?? undefined,
      campaignSourceId: n.campaignSourceId ?? undefined,
      salePrice: salePrice ?? undefined,
      clientReportingCurrency: n.clientReportingCurrency
        ? String(n.clientReportingCurrency).slice(0, 3).toUpperCase()
        : undefined,
      feedStatus: n.feedStatus ?? undefined,
      supplierProductTrackingUrl: n.supplierProductTrackingUrl
        ? String(n.supplierProductTrackingUrl)
        : undefined,
    };

    const existing = await this.findSourceBySupplierProduct(
      { supplier, sourceAccountLabel, supplierProductId },
      db,
    );

    if (existing) {
      const product = await db.product.update({
        where: { id: existing.productId },
        data: {
          title,
          description: n.description ?? existing.product.description,
          url: n.url ?? existing.product.url,
          imageUrl: n.imageUrl ?? existing.product.imageUrl,
          category: n.category ?? existing.product.category,
          brand: n.brand ?? existing.product.brand,
          sku: n.supplierSku ?? existing.product.sku,
          price: price ?? existing.product.price,
          currency: currency ?? existing.product.currency,
          availability,
          status: "ACTIVE",
          merchantId: merchantId ?? existing.product.merchantId,
          ...(epicFields.productFeedId !== undefined
            ? { productFeedId: epicFields.productFeedId }
            : {}),
          ...(epicFields.campaignSourceId !== undefined
            ? { campaignSourceId: epicFields.campaignSourceId }
            : {}),
          ...(epicFields.salePrice !== undefined ? { salePrice: epicFields.salePrice } : {}),
          ...(epicFields.clientReportingCurrency !== undefined
            ? { clientReportingCurrency: epicFields.clientReportingCurrency }
            : {}),
          ...(epicFields.feedStatus !== undefined ? { feedStatus: epicFields.feedStatus } : {}),
          ...(epicFields.supplierProductTrackingUrl !== undefined
            ? { supplierProductTrackingUrl: epicFields.supplierProductTrackingUrl }
            : {}),
        },
      });
      const source = await db.productSource.update({
        where: { id: existing.id },
        data: {
          supplierSku: n.supplierSku ?? existing.supplierSku,
          supplierCampaignId: n.supplierCampaignId ?? existing.supplierCampaignId,
          catalogId: n.catalogId ?? existing.catalogId,
          title,
          price: price ?? existing.price,
          currency: currency ?? existing.currency,
          rawPayloadId: rawPayloadId ?? existing.rawPayloadId,
          mapperVersion: mapperVersion ?? existing.mapperVersion,
          metadata: {
            ...(existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
            lastIngestAt: new Date().toISOString(),
          },
        },
      });
      return { ok: true, created: false, product, source };
    }

    try {
      const product = await db.product.create({
        data: {
          merchantId,
          sku: n.supplierSku ?? null,
          title,
          description: n.description ?? null,
          url: n.url ?? null,
          imageUrl: n.imageUrl ?? null,
          category: n.category ?? null,
          brand: n.brand ?? null,
          price,
          currency,
          availability,
          status: "ACTIVE",
          metadata: { ingestSource: supplier },
          productFeedId: epicFields.productFeedId ?? null,
          campaignSourceId: epicFields.campaignSourceId ?? null,
          salePrice: epicFields.salePrice ?? null,
          clientReportingCurrency: epicFields.clientReportingCurrency ?? null,
          feedStatus: epicFields.feedStatus ?? "ACTIVE",
          supplierProductTrackingUrl: epicFields.supplierProductTrackingUrl ?? null,
        },
      });
      const source = await db.productSource.create({
        data: {
          productId: product.id,
          supplier,
          sourceAccountLabel,
          supplierProductId,
          supplierSku: n.supplierSku ?? null,
          supplierCampaignId: n.supplierCampaignId ?? null,
          catalogId: n.catalogId ?? null,
          title,
          price,
          currency,
          rawPayloadId,
          mapperVersion,
          metadata: { ingestSource: supplier },
        },
      });
      return { ok: true, created: true, product, source };
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        const row = await this.findSourceBySupplierProduct(
          { supplier, sourceAccountLabel, supplierProductId },
          db,
        );
        if (row) return { ok: true, created: false, product: row.product, source: row, deduped: true };
      }
      throw error;
    }
  }

  /**
   * Map RawPayload-like object and ingest.
   */
  async ingestFromPayload(
    { supplier, sourceAccountLabel = "default", payload, rawPayloadId = null, merchantId = null },
    client = null,
  ) {
    const mapped = mapPayload({ supplier, resourceKey: "products", payload });
    if (!mapped.success) {
      return { ok: false, reason: "mapping_failed", errors: mapped.errors };
    }
    return this.ingestMappedProduct(
      {
        supplier,
        sourceAccountLabel,
        mapped,
        rawPayloadId,
        mapperVersion: mapped.mappingVersion,
        merchantId,
      },
      client,
    );
  }

  /**
   * Optional OrderItem → Product link by supplier SKU/product id (does not mutate OrderItem prices).
   */
  async linkOrderItemToProduct(orderItem, { supplier, sourceAccountLabel = "default" } = {}, client = null) {
    const db = client ?? this.db;
    if (!orderItem || orderItem.productRecordId) {
      return { linked: false, reason: orderItem?.productRecordId ? "already_linked" : "missing_item" };
    }
    const supplierProductId = orderItem.productId || orderItem.sku;
    if (!supplierProductId || !supplier) {
      return { linked: false, reason: "missing_supplier_product_ref" };
    }
    const source = await this.findSourceBySupplierProduct(
      { supplier, sourceAccountLabel, supplierProductId: String(supplierProductId) },
      db,
    );
    if (!source) return { linked: false, reason: "product_source_not_found" };
    await db.orderItem.update({
      where: { id: orderItem.id },
      data: { productRecordId: source.productId },
    });
    return { linked: true, productId: source.productId, productSourceId: source.id };
  }
}
