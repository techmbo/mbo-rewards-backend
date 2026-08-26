/**
 * Epic 4 — ProductFeed ingest via RawPayload + MappingEngine → ProductFeedItem → Product/ProductSource.
 * Does not invent supplier fields. Product price is never commission basis.
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../../database/prisma.js";
import { mapPayload } from "../mapping/engine.js";
import { ProductService } from "./product.service.js";
import { ExceptionCaseService } from "../order/exceptionCase.service.js";
import { getTrackingBaseUrl } from "../commercial/trackingUrl.js";
import { resolveReportingCurrency } from "../finance/fx.service.js";
import { buildClientCommission } from "../client/dto/partnerCampaign.dto.js";
import { mapCampaignType } from "../ops/v15FieldContract.js";
import { fail } from "../../core/apiResponse.js";

function hashPayload(payload) {
  return createHash("sha256").update(JSON.stringify(payload ?? {})).digest("hex");
}

function toDecimalString(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : null;
}

/**
 * v15 09J / 11E — India → INR; known non-India → USD; unknown country/region → null.
 * Never invent currency unconditionally.
 */
export function resolveClientReportingCurrency({ country = null, region = null } = {}) {
  const resolved = resolveReportingCurrency({ country, region });
  return resolved.ok && resolved.currency ? resolved.currency : null;
}

function discountPercentageFromPrices(price, salePrice) {
  const p = price != null ? Number(price) : null;
  const s = salePrice != null ? Number(salePrice) : null;
  if (p == null || s == null || !Number.isFinite(p) || !Number.isFinite(s) || p <= 0) return null;
  if (s >= p) return null;
  return Number((((p - s) / p) * 100).toFixed(2));
}

/**
 * Client-facing currency for catalog display (11E / 09J).
 * Prefer persisted clientReportingCurrency, then regional rule when country known,
 * then catalog Product.currency. Never invent INR/USD when all unknown.
 */
function resolveProductDisplayCurrency(product = {}, clientRecord = null) {
  if (product.clientReportingCurrency && String(product.clientReportingCurrency).trim()) {
    return String(product.clientReportingCurrency).trim().toUpperCase();
  }
  const regional = resolveClientReportingCurrency({
    country: clientRecord?.country,
  });
  if (regional) return regional;
  if (product.currency && String(product.currency).trim()) {
    return String(product.currency).trim().toUpperCase();
  }
  return null;
}

function commissionDisplayFromAssignment(assignmentRow) {
  const rules = assignmentRow.clientCampaignAssignment?.commissionRules || [];
  const rule = rules.find((r) => String(r.status || "").toUpperCase() === "EFFECTIVE") || rules[0] || null;
  if (!rule) return null;
  const built = buildClientCommission({
    displayLabel: rule.displayLabel,
    displayRangeMin: rule.displayRangeMin != null ? Number(rule.displayRangeMin) : null,
    displayRangeMax: rule.displayRangeMax != null ? Number(rule.displayRangeMax) : null,
    orderValuePercent: rule.orderValuePercent != null ? Number(rule.orderValuePercent) : null,
    fixedAmount: rule.fixedAmount != null ? Number(rule.fixedAmount) : null,
    manualAmount: rule.manualAmount != null ? Number(rule.manualAmount) : null,
    manualApproved: rule.manualApproved === true,
    currency: rule.currency || null,
    commissionType: rule.commissionType || null,
    clientSharePercent:
      rule.grossCommission != null && Number(rule.grossCommission) !== 0
        ? (Number(rule.clientCommission) / Number(rule.grossCommission)) * 100
        : null,
  });
  return built?.commissionDisplay || null;
}

function commercialModelFromRow(assignmentRow) {
  const sc =
    assignmentRow.clientCampaignAssignment?.campaignSource?.supplierCampaign ||
    assignmentRow.product?.campaignSource?.supplierCampaign ||
    null;
  return mapCampaignType(sc?.campaignType, sc?.pricingModel) || null;
}

function channelFromRow(assignmentRow) {
  const ch = assignmentRow.clientCampaignAssignment?.channel || null;
  if (!ch) return null;
  const upper = String(ch).toUpperCase();
  // Never treat commercial models as channel.
  if (["CPS", "CPA", "CPL", "CPI", "CPC"].includes(upper)) return null;
  return upper;
}

function detectFormat(hint, sampleRow) {
  const h = String(hint || "").toUpperCase();
  if (["CSV", "XML", "JSON", "GOOGLE_SHOPPING"].includes(h)) return h;
  if (sampleRow && typeof sampleRow === "object") return "JSON";
  return "UNKNOWN";
}

function tokenAlphabet() {
  return "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
}

export function generateProductTrackingToken(bytes = 6) {
  const alphabet = tokenAlphabet();
  const buf = randomBytes(bytes);
  let out = "";
  for (const b of buf) out += alphabet[b % alphabet.length];
  return `P${out}`;
}

export class ProductFeedService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.products = deps.products ?? new ProductService({ prisma: this.db });
    this.exceptions = deps.exceptions ?? new ExceptionCaseService({ prisma: this.db });
  }

  async upsertFeed(
    {
      supplier,
      sourceAccountLabel = "default",
      campaignSourceId = null,
      feedExternalId = "default",
      feedName = null,
      feedUrl = null,
      feedFormat = "UNKNOWN",
      aid = null,
      compressedLocation = null,
      creativeId = null,
      mappingVersion = null,
      metadata = null,
      feedStatus = "NEEDS_REVIEW",
    },
    client = null,
  ) {
    const db = client ?? this.db;
    const key = {
      supplier,
      sourceAccountLabel,
      feedExternalId: feedExternalId || "default",
    };
    const existing = await db.productFeed.findUnique({
      where: { supplier_sourceAccountLabel_feedExternalId: key },
    });
    const data = {
      campaignSourceId,
      feedName,
      feedUrl,
      feedFormat: detectFormat(feedFormat),
      aid,
      compressedLocation,
      creativeId,
      mappingVersion,
      metadata,
      feedStatus,
    };
    if (existing) {
      return db.productFeed.update({ where: { id: existing.id }, data });
    }
    return db.productFeed.create({
      data: {
        ...key,
        ...data,
      },
    });
  }

  /**
   * Ingest one product row for a feed (idempotent by feed + supplierProductId and ProductSource identity).
   */
  async ingestFeedRow(
    {
      feed,
      supplier,
      sourceAccountLabel = "default",
      rawRow,
      campaignSourceId = null,
      countryHint = null,
      merchantId = null,
    },
    client = null,
  ) {
    const db = client ?? this.db;
    const mapped = mapPayload({
      supplier,
      resourceKey: "products",
      payload: rawRow,
    });

    if (!mapped.success) {
      await this.exceptions.report(
        {
          type: "PRODUCT_FEED_ERROR",
          severity: "HIGH",
          supplier,
          reason: "mapping_failed",
          metadata: { errors: mapped.errors, feedId: feed?.id },
        },
        db,
      );
      return { ok: false, reason: "mapping_failed", errors: mapped.errors };
    }

    const n = mapped.normalizedData || {};
    const supplierProductId = n.supplierProductId != null ? String(n.supplierProductId) : null;
    if (!supplierProductId) {
      await this.exceptions.report(
        {
          type: "PRODUCT_MISSING_ID",
          severity: "HIGH",
          supplier,
          reason: "missing_supplier_product_id",
          metadata: { feedId: feed?.id },
        },
        db,
      );
      return { ok: false, reason: "missing_supplier_product_id" };
    }

    const productUrl = n.url || n.productUrl || null;
    const trackingUrl = n.supplierProductTrackingUrl || n.trackingUrl || productUrl || null;
    if (!productUrl && !trackingUrl) {
      await this.exceptions.report(
        {
          type: "PRODUCT_MISSING_URL",
          severity: "HIGH",
          supplier,
          reason: "missing_product_url",
          metadata: { feedId: feed?.id, supplierProductId },
        },
        db,
      );
      // Still store feed item as NEEDS_REVIEW — do not silently discard
    }

    const payloadHash = hashPayload(rawRow);
    let rawPayloadId = null;
    try {
      const raw = await db.rawPayload.create({
        data: {
          supplier,
          sourceAccountLabel,
          resourceKey: "products",
          entityType: "product",
          externalId: `${feed?.feedExternalId || "default"}:${supplierProductId}`,
          payload: rawRow,
          payloadHash,
          mapperVersion: mapped.mappingVersion,
          processingStatus: "MAPPED",
          networkSource: String(supplier).toLowerCase(),
          metadata: { productFeedId: feed?.id ?? null },
        },
      });
      rawPayloadId = raw.id;
    } catch (error) {
      // Unique hash collision → reuse existing
      if (db.rawPayload?.findFirst) {
        const existingRaw = await db.rawPayload.findFirst({
          where: {
            supplier,
            sourceAccountLabel,
            resourceKey: "products",
            payloadHash,
          },
        });
        rawPayloadId = existingRaw?.id ?? null;
      }
    }

    const clientReportingCurrency = resolveClientReportingCurrency({
      country: countryHint || n.country,
    });

    const ingest = await this.products.ingestMappedProduct(
      {
        supplier,
        sourceAccountLabel,
        mapped: {
          ...mapped,
          normalizedData: {
            ...n,
            supplierProductTrackingUrl: trackingUrl,
            salePrice: n.salePrice,
            clientReportingCurrency,
            productFeedId: feed?.id,
            campaignSourceId: campaignSourceId || feed?.campaignSourceId,
            feedStatus: !productUrl && !trackingUrl ? "NEEDS_REVIEW" : "ACTIVE",
          },
        },
        rawPayloadId,
        mapperVersion: mapped.mappingVersion,
        merchantId,
      },
      db,
    );

    if (!ingest.ok) {
      return ingest;
    }

    const itemData = {
      productId: ingest.product.id,
      productSourceId: ingest.source.id,
      title: n.title != null ? String(n.title) : null,
      price: toDecimalString(n.price),
      currency: n.currency ? String(n.currency).slice(0, 3).toUpperCase() : null,
      productUrl: productUrl ? String(productUrl) : null,
      imageUrl: n.imageUrl ? String(n.imageUrl) : null,
      supplierTrackingUrl: trackingUrl ? String(trackingUrl) : null,
      status: !productUrl && !trackingUrl ? "NEEDS_REVIEW" : "ACTIVE",
      rawPayloadId,
      mapperVersion: mapped.mappingVersion,
      metadata: {
        unmappedFields: mapped.unmappedFields || [],
        warnings: mapped.warnings || [],
      },
    };

    const existingItem = await db.productFeedItem.findUnique({
      where: {
        productFeedId_supplierProductId: {
          productFeedId: feed.id,
          supplierProductId,
        },
      },
    });

    let feedItem;
    if (existingItem) {
      feedItem = await db.productFeedItem.update({
        where: { id: existingItem.id },
        data: itemData,
      });
    } else {
      feedItem = await db.productFeedItem.create({
        data: {
          productFeedId: feed.id,
          supplierProductId,
          ...itemData,
        },
      });
    }

    await db.productFeed.update({
      where: { id: feed.id },
      data: {
        lastSyncedAt: new Date(),
        feedStatus: "ACTIVE",
        mappingVersion: mapped.mappingVersion,
        lastError: null,
      },
    });

    return {
      ok: true,
      created: Boolean(ingest.created),
      product: ingest.product,
      source: ingest.source,
      feedItem,
      rawPayloadId,
      mappingVersion: mapped.mappingVersion,
      unmappedFields: mapped.unmappedFields || [],
    };
  }

  /**
   * Ingest many rows for a supplier feed (fixture or adapter-fetched).
   */
  async ingestFeedBatch(input, client = null) {
    const db = client ?? this.db;
    const feed = await this.upsertFeed(
      {
        supplier: input.supplier,
        sourceAccountLabel: input.sourceAccountLabel || "default",
        campaignSourceId: input.campaignSourceId || null,
        feedExternalId: input.feedExternalId || "default",
        feedName: input.feedName || null,
        feedUrl: input.feedUrl || null,
        feedFormat: input.feedFormat || "JSON",
        aid: input.aid || null,
        compressedLocation: input.compressedLocation || null,
        creativeId: input.creativeId || null,
        feedStatus: "ACTIVE",
      },
      db,
    );

    const rows = Array.isArray(input.rows) ? input.rows : [];
    const summary = {
      feedId: feed.id,
      processed: 0,
      created: 0,
      updated: 0,
      failed: 0,
      errors: [],
    };

    for (const rawRow of rows) {
      summary.processed += 1;
      try {
        const out = await this.ingestFeedRow(
          {
            feed,
            supplier: input.supplier,
            sourceAccountLabel: input.sourceAccountLabel || "default",
            rawRow,
            campaignSourceId: input.campaignSourceId || null,
            countryHint: input.countryHint || null,
            merchantId: input.merchantId || null,
          },
          db,
        );
        if (!out.ok) {
          summary.failed += 1;
          summary.errors.push({ reason: out.reason });
        } else if (out.created) {
          summary.created += 1;
        } else {
          summary.updated += 1;
        }
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({ reason: error.message });
        await this.exceptions.report(
          {
            type: "PRODUCT_FEED_ERROR",
            severity: "HIGH",
            supplier: input.supplier,
            reason: error.message,
            metadata: { feedId: feed.id },
          },
          db,
        ).catch(() => {});
      }
    }

    if (summary.failed && !summary.created && !summary.updated) {
      await db.productFeed.update({
        where: { id: feed.id },
        data: {
          feedStatus: "ERROR",
          errorCount: { increment: summary.failed },
          lastError: summary.errors[0]?.reason || "ingest_failed",
        },
      });
    }

    return { feed, summary };
  }
}

export class ClientProductService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.exceptions = deps.exceptions ?? new ExceptionCaseService({ prisma: this.db });
  }

  /**
   * Publish product to client (creates assignment + ProductTrackingLink).
   */
  async assignProductToClient(
    {
      clientId,
      productId,
      clientCampaignAssignmentId = null,
      status = "ACTIVE",
    },
    client = null,
  ) {
    const db = client ?? this.db;
    const product = await db.product.findUnique({ where: { id: productId } });
    if (!product) {
      return { ok: false, reason: "product_not_found" };
    }
    const trackingTarget = product.supplierProductTrackingUrl || product.url;
    if (!trackingTarget) {
      await this.exceptions.report(
        {
          type: "PRODUCT_NEEDS_REVIEW",
          severity: "HIGH",
          clientId,
          reason: "cannot_publish_without_url",
          metadata: { productId },
        },
        db,
      );
      return { ok: false, reason: "missing_product_url" };
    }
    if (product.feedStatus === "NEEDS_REVIEW" || product.feedStatus === "ERROR") {
      return { ok: false, reason: "product_not_publishable", feedStatus: product.feedStatus };
    }

    let assignment = await db.clientProductAssignment.findUnique({
      where: { clientId_productId: { clientId, productId } },
    });
    if (assignment) {
      assignment = await db.clientProductAssignment.update({
        where: { id: assignment.id },
        data: {
          status,
          clientCampaignAssignmentId: clientCampaignAssignmentId ?? assignment.clientCampaignAssignmentId,
          publishedAt: status === "ACTIVE" ? new Date() : assignment.publishedAt,
        },
      });
    } else {
      assignment = await db.clientProductAssignment.create({
        data: {
          clientId,
          productId,
          clientCampaignAssignmentId,
          status,
          publishedAt: status === "ACTIVE" ? new Date() : null,
        },
      });
    }

    let link = await db.productTrackingLink.findFirst({
      where: { clientId, productId, status: "ACTIVE" },
    });
    if (!link) {
      const token = generateProductTrackingToken();
      const mboProductTrackingUrl = `${getTrackingBaseUrl()}/t/product/${token}`;
      link = await db.productTrackingLink.create({
        data: {
          clientId,
          productId,
          clientProductAssignmentId: assignment.id,
          clientCampaignAssignmentId,
          token,
          supplierProductTrackingUrl: trackingTarget,
          mboProductTrackingUrl,
          status: "ACTIVE",
        },
      });
    }

    return { ok: true, assignment, trackingLink: link };
  }

  async unassignProduct({ clientId, productId }, client = null) {
    const db = client ?? this.db;
    const assignment = await db.clientProductAssignment.findUnique({
      where: { clientId_productId: { clientId, productId } },
    });
    if (!assignment) return { ok: false, reason: "not_found" };
    await db.clientProductAssignment.update({
      where: { id: assignment.id },
      data: { status: "PAUSED" },
    });
    await db.productTrackingLink.updateMany({
      where: { clientId, productId, status: "ACTIVE" },
      data: { status: "REVOKED" },
    });
    return { ok: true };
  }

  /**
   * Client-safe product list (tenant-scoped from auth clientId only).
   * Visibility reuses campaign published+ACTIVE gate — no second visibility engine.
   */
  async listClientProducts(clientId, query = {}, client = null) {
    const db = client ?? this.db;
    const page = Math.max(1, Number(query.page) || 1);
    const pageSizeRaw = Number(query.pageSize ?? query.limit) || 25;
    const take = Math.min(Math.max(1, pageSizeRaw), 200);
    const skip =
      query.offset != null && query.offset !== ""
        ? Math.max(0, Number(query.offset) || 0)
        : (page - 1) * take;
    const search = query.search ? String(query.search).trim() : null;
    const brand = query.brand ? String(query.brand).trim() : null;
    const campaignAssignmentId = query.campaignAssignmentId || null;

    const clientRecord = await db.client.findUnique({ where: { id: clientId } });
    if (!clientRecord || clientRecord.deletedAt || clientRecord.status !== "ACTIVE") {
      throw fail("Client account is not active.", 403);
    }

    // Ignore query.clientId for tenant — auth clientId only (controller also 403s mismatches).
    const where = {
      clientId,
      status: "ACTIVE",
      // Must be linked to a client-visible campaign assignment (published + ACTIVE).
      clientCampaignAssignment: {
        is: {
          clientId,
          published: true,
          status: "ACTIVE",
        },
      },
      ...(campaignAssignmentId ? { clientCampaignAssignmentId: campaignAssignmentId } : {}),
      product: {
        status: { in: ["ACTIVE", "UNKNOWN"] },
        AND: [
          {
            OR: [{ feedStatus: null }, { feedStatus: { in: ["ACTIVE", "PAUSED"] } }],
          },
          ...(search
            ? [
                {
                  OR: [
                    { title: { contains: search, mode: "insensitive" } },
                    { brand: { contains: search, mode: "insensitive" } },
                    { sku: { contains: search, mode: "insensitive" } },
                  ],
                },
              ]
            : []),
          ...(brand
            ? [
                {
                  OR: [
                    { brand: { contains: brand, mode: "insensitive" } },
                    { merchant: { is: { displayName: { contains: brand, mode: "insensitive" } } } },
                  ],
                },
              ]
            : []),
        ],
      },
    };

    const [total, rows] = await Promise.all([
      db.clientProductAssignment.count({ where }),
      db.clientProductAssignment.findMany({
        where,
        include: {
          product: {
            include: {
              merchant: { select: { id: true, displayName: true, logoUrl: true } },
              campaignSource: {
                include: {
                  canonicalCampaign: { select: { id: true, displayName: true } },
                  supplierCampaign: { select: { campaignType: true, pricingModel: true } },
                },
              },
            },
          },
          clientCampaignAssignment: {
            include: {
              canonicalCampaign: { select: { id: true, displayName: true } },
              campaignSource: {
                include: {
                  supplierCampaign: { select: { campaignType: true, pricingModel: true } },
                },
              },
              commissionRules: {
                where: { status: "EFFECTIVE" },
                orderBy: { effectiveFrom: "desc" },
                take: 1,
              },
            },
          },
          productTrackingLinks: {
            where: { status: "ACTIVE" },
            take: 1,
            orderBy: { createdAt: "desc" },
          },
        },
        orderBy: { updatedAt: "desc" },
        skip,
        take,
      }),
    ]);

    const items = rows.map((row) => toClientProductDto(row, clientRecord));
    const totalPages = take > 0 ? Math.ceil(total / take) : 0;
    return {
      items,
      products: items,
      total,
      limit: take,
      offset: skip,
      dataAvailable: total > 0,
      dataState: total > 0 ? "ok" : "empty",
      pagination: {
        page: query.offset != null && query.offset !== "" ? Math.floor(skip / take) + 1 : page,
        pageSize: take,
        total,
        totalPages,
      },
      contract: "v15-11E-client-products",
    };
  }
}

const FORBIDDEN_CLIENT_PRODUCT_KEYS = [
  "supplierProductTrackingUrl",
  "rawPayload",
  "rawPayloadId",
  "rawData",
  "mboMargin",
  "mboCommission",
  "supplierReceivable",
  "supplierCommission",
  "mapperVersion",
  "productFeedId",
  "apiKey",
  "keyHash",
  "supplierCampaignId",
  "internalSupplierId",
];

export function toClientProductDto(assignmentRow, clientRecord = null) {
  const product = assignmentRow.product || {};
  const link = assignmentRow.productTrackingLinks?.[0] || null;
  const campaignAssignment = assignmentRow.clientCampaignAssignment || null;
  const campaign =
    campaignAssignment?.canonicalCampaign || product.campaignSource?.canonicalCampaign || null;
  const brandName = product.merchant?.displayName || product.brand || null;
  const price = product.price != null ? Number(product.price) : null;
  const salePrice = product.salePrice != null ? Number(product.salePrice) : null;
  const currency = resolveProductDisplayCurrency(product, clientRecord);
  const commercialModel = commercialModelFromRow(assignmentRow);
  const channel = channelFromRow(assignmentRow);

  const dto = {
    productId: product.id || null,
    brandName,
    brandLogoUrl: product.merchant?.logoUrl || null,
    campaignName: campaign?.displayName || null,
    campaignAssignmentId: assignmentRow.clientCampaignAssignmentId || null,
    productName: product.title || null,
    productImageUrl: product.imageUrl || null,
    productCategory: product.category || null,
    price: Number.isFinite(price) ? price : null,
    salePrice: Number.isFinite(salePrice) ? salePrice : null,
    discountPercentage: discountPercentageFromPrices(price, salePrice),
    currency,
    originalCurrency: product.currency || null,
    availability: product.availability || "UNKNOWN",
    status: assignmentRow.status || null,
    commercialModel,
    channel,
    /** Channel alias — never commercial CPS/CPA. */
    campaignType: channel,
    commissionDisplay: commissionDisplayFromAssignment(assignmentRow),
    validFrom: campaignAssignment?.startDate
      ? new Date(campaignAssignment.startDate).toISOString().slice(0, 10)
      : null,
    validUntil: campaignAssignment?.endDate
      ? new Date(campaignAssignment.endDate).toISOString().slice(0, 10)
      : null,
    mboProductTrackingUrl: link?.mboProductTrackingUrl || null,
  };

  for (const key of FORBIDDEN_CLIENT_PRODUCT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(dto, key)) delete dto[key];
  }
  return dto;
}

export { FORBIDDEN_CLIENT_PRODUCT_KEYS };
