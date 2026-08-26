import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { getSupplierCapabilities, listRegisteredSuppliers, isSupplierRegistered } from "../../adapters/registry.js";
import { getTrackingParamRule } from "../tracking/trackingParamRules.js";
import { getSyncStatus } from "../../jobs/syncState.js";
import { parseNetworkSource } from "../supplier/entityIdentity.js";
import { mapPayload } from "../mapping/engine.js";
import { ProductPromotionService } from "../product/productPromotion.service.js";

function normalizeAvailabilityLabel(raw) {
  const v = String(raw ?? "").trim().toUpperCase();
  if (!v || v === "UNKNOWN") return null;
  if (v === "1" || v === "TRUE" || v === "YES" || v === "Y" || v === "AVAILABLE") return "IN_STOCK";
  if (v === "0" || v === "FALSE" || v === "NO" || v === "N" || v === "UNAVAILABLE") return "OUT_OF_STOCK";
  if (v.includes("IN") && v.includes("STOCK")) return "IN_STOCK";
  if (v.includes("OUT")) return "OUT_OF_STOCK";
  if (v.includes("PRE")) return "PREORDER";
  return v;
}

function feedSourceLabel({ feed, supplier, raw } = {}) {
  if (feed?.feedName) return feed.feedName;
  if (feed?.feedFormat && String(feed.feedFormat).toUpperCase() !== "UNKNOWN") {
    return String(feed.feedFormat);
  }
  const fromRaw =
    raw?.CatalogName ||
    raw?.catalog_name ||
    raw?.FeedName ||
    raw?.feed_name ||
    raw?.Source ||
    raw?.source ||
    null;
  if (fromRaw) return String(fromRaw);
  const key = String(supplier || "").toUpperCase();
  if (key === "IMPACT") return "Catalog Item";
  if (key === "AWIN") return "Enhanced Feed";
  if (key === "PARTNERIZE" || key === "OPTIMISE") return "Product Feed / API";
  if (key) return "Product Source / API";
  return null;
}

/**
 * v13 Products / Feeds list row — real product/feed records only (never invented from campaign metadata).
 */
export function toAdminProductListDto(product) {
  const source = Array.isArray(product?.sources) ? product.sources[0] : null;
  const feed = product?.productFeed || null;
  const campaignSource = product?.campaignSource || null;
  const campaignName =
    campaignSource?.canonicalCampaign?.displayName ||
    campaignSource?.supplierCampaign?.campaignName ||
    null;
  const hasMappingEvidence = Boolean(source?.mapperVersion || source?.rawPayloadId);
  let mappingStatus = "UNMAPPED";
  if (hasMappingEvidence) mappingStatus = "MAPPED";
  else if (product?.status && String(product.status).toUpperCase() !== "UNKNOWN") mappingStatus = "NEEDS_REVIEW";

  const price = product?.price ?? source?.price ?? null;
  const currency = product?.currency || source?.currency || null;
  const networkSource = source?.supplier || campaignSource?.supplierCampaign?.supplier || null;

  return {
    id: product.id,
    networkSource,
    networkAccount: source?.sourceAccountLabel || null,
    brandName: product.merchant?.displayName || product.brand || null,
    campaignName,
    campaignSourceId: product.campaignSourceId || campaignSource?.id || null,
    supplierProductId: source?.supplierProductId || null,
    productName: product.title || source?.title || null,
    sku: product.sku || source?.supplierSku || null,
    price: price != null ? Number(price) : null,
    currency,
    availability: normalizeAvailabilityLabel(product.availability) || product.availability || null,
    mappingStatus,
    productFeedSource: feedSourceLabel({ feed, supplier: networkSource }),
    productFeedId: feed?.id || product.productFeedId || null,
    status: product.status || null,
    imageUrl: product.imageUrl || null,
    url: product.url || null,
    sources: (product.sources || []).map((s) => ({
      id: s.id,
      supplier: s.supplier,
      sourceAccountLabel: s.sourceAccountLabel,
      supplierProductId: s.supplierProductId,
    })),
  };
}

/** Map staged Entity(product) → same v13 list contract when Product rows are not yet promoted. */
export function toAdminProductListDtoFromEntity(entity) {
  const { supplier } = parseNetworkSource(entity?.networkSource);
  const raw = entity?.rawData && typeof entity.rawData === "object" ? entity.rawData : {};
  let normalized = {};
  let mappingOk = false;
  if (supplier && supplier !== "UNKNOWN") {
    const mapped = mapPayload({
      supplier,
      resourceKey: "products",
      payload: raw,
    });
    mappingOk = Boolean(mapped?.success);
    normalized = mapped?.normalizedData || {};
  }

  const supplierProductId =
    normalized.supplierProductId ??
    raw.Id ??
    raw.CatalogItemId ??
    raw.Sku ??
    raw.SKU ??
    raw.id ??
    raw.sku ??
    null;
  const productName = normalized.title ?? raw.Name ?? raw.Title ?? raw.name ?? raw.title ?? null;
  const sku = normalized.supplierSku ?? raw.Sku ?? raw.SKU ?? raw.sku ?? null;
  const brandName = normalized.brand ?? raw.Brand ?? raw.brand ?? raw.Manufacturer ?? null;
  const price = normalized.price ?? raw.Price ?? raw.CurrentPrice ?? raw.price ?? null;
  const currency = normalized.currency ?? raw.Currency ?? raw.CurrencyCode ?? raw.currency ?? null;
  const availability = normalizeAvailabilityLabel(
    normalized.availabilityRaw ?? normalized.availability ?? raw.Availability ?? raw.StockStatus,
  );
  const campaignName =
    raw.CampaignName ?? raw.campaign_name ?? raw.ProgramName ?? raw.AdvertiserName ?? null;

  return {
    id: entity.id,
    networkSource: supplier !== "UNKNOWN" ? supplier : entity.networkSource || null,
    networkAccount: null,
    brandName: brandName != null ? String(brandName) : null,
    campaignName: campaignName != null ? String(campaignName) : null,
    campaignSourceId: null,
    supplierProductId: supplierProductId != null ? String(supplierProductId) : null,
    productName: productName != null ? String(productName) : null,
    sku: sku != null ? String(sku) : null,
    price: price != null && Number.isFinite(Number(price)) ? Number(price) : null,
    currency: currency != null ? String(currency).slice(0, 3).toUpperCase() : null,
    availability,
    mappingStatus: mappingOk ? "MAPPED" : "NEEDS_REVIEW",
    productFeedSource: feedSourceLabel({ supplier, raw }),
    productFeedId: null,
    status: null,
    imageUrl: normalized.imageUrl ?? raw.ImageUrl ?? null,
    url: normalized.url ?? raw.Url ?? raw.ProductUrl ?? null,
    sources: [],
    stagedFromEntity: true,
  };
}

/**
 * Wave G — product admin + data quality + supplier/job health.
 */
export class ProductOpsService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.promotion = deps.promotion ?? new ProductPromotionService({ prisma: this.db });
  }

  async listProducts(filters = {}, { skip = 0, take = 50 } = {}) {
    // Promote staged Entity(product) rows into Product/ProductSource so the registry stays current.
    try {
      await this.promotion.promoteBatch({
        networkSource: filters.networkSource || undefined,
        limit: Math.min(200, Math.max(take * 2, 50)),
      });
    } catch {
      // listing must still work if promotion fails
    }

    const where = {};
    if (filters.merchantId) where.merchantId = filters.merchantId;
    if (filters.status) where.status = filters.status;
    if (filters.availability) where.availability = String(filters.availability).toUpperCase();
    if (filters.sku) where.sku = { contains: String(filters.sku), mode: "insensitive" };
    if (filters.q) {
      const q = String(filters.q).trim();
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { sku: { contains: q, mode: "insensitive" } },
        { brand: { contains: q, mode: "insensitive" } },
        { sources: { some: { supplierProductId: { contains: q, mode: "insensitive" } } } },
        { sources: { some: { supplierSku: { contains: q, mode: "insensitive" } } } },
      ];
    }
    if (filters.supplier) {
      where.sources = { some: { supplier: filters.supplier } };
    }
    if (filters.supplierProductId) {
      where.sources = {
        some: {
          ...(filters.supplier ? { supplier: filters.supplier } : {}),
          supplierProductId: String(filters.supplierProductId),
        },
      };
    }

    const [rows, total] = await Promise.all([
      this.db.product.findMany({
        where,
        include: {
          merchant: { select: { id: true, displayName: true } },
          productFeed: {
            select: {
              id: true,
              feedName: true,
              feedFormat: true,
              feedExternalId: true,
              feedStatus: true,
            },
          },
          campaignSource: {
            select: {
              id: true,
              canonicalCampaign: { select: { displayName: true } },
              supplierCampaign: { select: { campaignName: true, supplier: true, trackingUrl: true, merchantId: true } },
            },
          },
          sources: {
            select: {
              id: true,
              supplier: true,
              sourceAccountLabel: true,
              supplierProductId: true,
              supplierSku: true,
              catalogId: true,
              title: true,
              price: true,
              currency: true,
              rawPayloadId: true,
              mapperVersion: true,
              updatedAt: true,
            },
            orderBy: { updatedAt: "desc" },
          },
        },
        orderBy: { updatedAt: "desc" },
        skip,
        take,
      }),
      this.db.product.count({ where }),
    ]);

    if (total > 0 || rows.length > 0) {
      const enriched = await this.enrichMissingCampaignLinks(rows);
      return {
        rows: enriched.map(toAdminProductListDto),
        total,
        contract: "v13-products-feeds",
      };
    }

    // Fallback: show real staged network product entities (never invent from campaign metadata).
    return this.listStagedProductEntities(filters, { skip, take });
  }

  /**
   * Optimise feeds store publisher PID on ProductSource.catalogId; SupplierCampaign.supplierCampaignId
   * is often a different id. Link via trackingUrl ?PID= when campaignSourceId is missing.
   */
  async enrichMissingCampaignLinks(rows) {
    const need = (rows || []).filter(
      (r) => !r.campaignSourceId && r.sources?.[0]?.catalogId && String(r.sources[0].supplier || "").toUpperCase() === "OPTIMISE",
    );
    if (!need.length) return rows;

    const campaigns = await this.db.supplierCampaign.findMany({
      where: { supplier: "OPTIMISE", trackingUrl: { contains: "PID=", mode: "insensitive" } },
      select: {
        trackingUrl: true,
        merchantId: true,
        campaignName: true,
        supplier: true,
        campaignSources: {
          select: {
            id: true,
            canonicalCampaign: { select: { displayName: true } },
          },
          take: 1,
          orderBy: { priority: "asc" },
        },
      },
      take: 5000,
    });

    const byPid = new Map();
    for (const c of campaigns) {
      const m = String(c.trackingUrl || "").match(/(?:^|[?&])PID=([^&]+)/i);
      if (!m) continue;
      const csId = c.campaignSources?.[0]?.id;
      if (!csId) continue;
      byPid.set(decodeURIComponent(m[1]), {
        campaignSourceId: csId,
        merchantId: c.merchantId,
        campaignSource: {
          id: csId,
          canonicalCampaign: c.campaignSources[0].canonicalCampaign || null,
          supplierCampaign: {
            campaignName: c.campaignName,
            supplier: c.supplier,
            trackingUrl: c.trackingUrl,
            merchantId: c.merchantId,
          },
        },
      });
    }

    for (const product of need) {
      const pid = String(product.sources[0].catalogId);
      const hit = byPid.get(pid);
      if (!hit) continue;
      product.campaignSourceId = hit.campaignSourceId;
      product.campaignSource = hit.campaignSource;
      // Persist so subsequent lists and detail views stay linked.
      this.db.product
        .update({
          where: { id: product.id },
          data: {
            campaignSourceId: hit.campaignSourceId,
            ...(hit.merchantId && !product.merchantId ? { merchantId: hit.merchantId } : {}),
          },
        })
        .catch(() => {});
    }
    return rows;
  }

  async listStagedProductEntities(filters = {}, { skip = 0, take = 50 } = {}) {
    const where = { entityType: "product" };
    if (filters.supplier) {
      const key = String(filters.supplier).toLowerCase();
      where.networkSource = { equals: key, mode: "insensitive" };
    }
    if (filters.q) {
      const q = String(filters.q).trim();
      where.OR = [
        { externalId: { contains: q, mode: "insensitive" } },
        { networkSource: { contains: q, mode: "insensitive" } },
      ];
    }

    const [entities, total] = await Promise.all([
      this.db.entity.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip,
        take,
      }),
      this.db.entity.count({ where }),
    ]);

    return {
      rows: entities.map(toAdminProductListDtoFromEntity),
      total,
      contract: "v13-products-feeds",
      source: "entity-product",
    };
  }

  async getProduct(id) {
    const row = await this.db.product.findUnique({
      where: { id },
      include: {
        merchant: { select: { id: true, displayName: true } },
        productFeed: {
          select: {
            id: true,
            feedName: true,
            feedFormat: true,
            feedExternalId: true,
            feedStatus: true,
          },
        },
        campaignSource: {
          select: {
            id: true,
            canonicalCampaign: { select: { displayName: true } },
            supplierCampaign: { select: { campaignName: true, supplier: true, trackingUrl: true } },
          },
        },
        sources: {
          select: {
            id: true,
            supplier: true,
            sourceAccountLabel: true,
            supplierProductId: true,
            supplierSku: true,
            catalogId: true,
            title: true,
            price: true,
            currency: true,
            rawPayloadId: true,
            mapperVersion: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: "desc" },
        },
      },
    });
    if (!row) {
      const entity = await this.db.entity.findFirst({
        where: { id, entityType: "product" },
      });
      if (entity) return toAdminProductListDtoFromEntity(entity);
      throw fail("Product not found.", 404);
    }
    const [enriched] = await this.enrichMissingCampaignLinks([row]);
    const dto = toAdminProductListDto(enriched || row);
    return {
      ...dto,
      description: row.description || null,
      imageUrl: row.imageUrl || dto.imageUrl || null,
      url: row.url || dto.url || null,
      productFeed: row.productFeed || null,
      merchant: row.merchant || null,
    };
  }
}

export class DataQualityOpsService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  async getSummary() {
    const [
      assignmentsTotal,
      assignmentsMissingSource,
      conversionsOrphan,
      ordersMissingSupplierOrderId,
      openExceptions,
      criticalExceptions,
      highExceptions,
      products,
      productSources,
      ftCount,
      fxExceptions,
      reconExceptions,
    ] = await Promise.all([
      this.db.clientCampaignAssignment.count(),
      this.db.clientCampaignAssignment.count({ where: { campaignSourceId: null } }),
      this.db.conversion.count({ where: { attributionStatus: "ORPHAN" } }),
      this.db.order.count({ where: { supplierOrderId: { startsWith: "conv:" } } }),
      this.db.exceptionCase.count({ where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } } }),
      this.db.exceptionCase.count({
        where: { status: { in: ["OPEN", "ACKNOWLEDGED"] }, severity: "CRITICAL" },
      }),
      this.db.exceptionCase.count({
        where: { status: { in: ["OPEN", "ACKNOWLEDGED"] }, severity: "HIGH" },
      }),
      this.db.product.count(),
      this.db.productSource.count(),
      this.db.financialTransaction.count(),
      this.db.exceptionCase.count({
        where: {
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
          type: { in: ["MISSING_FX_RATE", "INVALID_CURRENCY"] },
        },
      }),
      this.db.exceptionCase.count({
        where: {
          status: { in: ["OPEN", "ACKNOWLEDGED"] },
          type: "FINANCIAL_RECONCILIATION_MISMATCH",
        },
      }),
    ]);

    const aging = await this.db.exceptionCase.findMany({
      where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      orderBy: { detectedAt: "asc" },
      take: 10,
      select: { id: true, type: true, severity: true, detectedAt: true, supplier: true },
    });

    return {
      assignments: {
        total: assignmentsTotal,
        missingCampaignSource: assignmentsMissingSource,
      },
      conversions: {
        orphaned: conversionsOrphan,
      },
      orders: {
        syntheticSupplierOrderIds: ordersMissingSupplierOrderId,
      },
      finance: {
        financialTransactions: ftCount,
        openFxExceptions: fxExceptions,
        reconciliationMismatches: reconExceptions,
      },
      products: {
        products,
        productSources,
      },
      exceptions: {
        open: openExceptions,
        critical: criticalExceptions,
        high: highExceptions,
        agingOldest: aging,
      },
    };
  }

  async getAssignmentCoverageDryRun() {
    const total = await this.db.clientCampaignAssignment.count();
    const withSource = await this.db.clientCampaignAssignment.count({
      where: { campaignSourceId: { not: null } },
    });
    const withoutSource = total - withSource;
    return {
      assignmentsWithSource: withSource,
      assignmentsWithoutSource: withoutSource,
      uniquelyResolvable: 0,
      ambiguous: 0,
      merchantConflict: 0,
      cmsOnly: withoutSource,
      autoModify: false,
      note: "Dry-run classification only — no production assignment mutations.",
    };
  }
}

export class SupplierHealthOpsService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  async getSupplierHealth() {
    const registered = listRegisteredSuppliers();
    const suppliers = await this.db.supplier.findMany();
    const byKey = new Map(suppliers.map((s) => [s.key, s]));
    const sync = getSyncStatus();

    return registered.map((key) => {
      const seed = byKey.get(key);
      const caps = getSupplierCapabilities(key);
      const tracking = getTrackingParamRule(key);
      return {
        supplier: key,
        registered: isSupplierRegistered(key),
        seedStatus: seed?.status ?? "UNKNOWN",
        displayName: seed?.displayName ?? key,
        capabilities: caps?.capabilities ?? [],
        trackingConfirmation: tracking.confirmation,
        trackingNotes: tracking.notes,
        adapterAvailable: true,
        lastSyncContext: sync?.status === "idle" ? null : {
          status: sync.status,
          jobName: sync.jobName,
          startedAt: sync.startedAt,
          finishedAt: sync.finishedAt,
          error: sync.error ?? null,
        },
      };
    });
  }

  async getJobHealth() {
    const byStatus = await this.db.jobRun.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const recent = await this.db.jobRun.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        jobName: true,
        status: true,
        attempt: true,
        lastError: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
      },
    });
    const sync = getSyncStatus();
    return {
      jobRunCounts: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      recentJobs: recent,
      syncStatus: sync,
    };
  }

  async getSystemOpsHealth() {
    const suppliers = await this.getSupplierHealth();
    const jobs = await this.getJobHealth();
    const dq = await new DataQualityOpsService({ prisma: this.db }).getSummary();
    const openCritical = dq.exceptions.critical;

    let overall = "HEALTHY";
    if (openCritical > 0 || syncHasError(jobs.syncStatus)) overall = "ERROR";
    else if (dq.exceptions.open > 0 || dq.finance.reconciliationMismatches > 0) overall = "WARNING";

    return {
      overall,
      suppliers: suppliers.map((s) => ({
        supplier: s.supplier,
        status: s.seedStatus === "ENABLED" ? "HEALTHY" : s.seedStatus === "PLANNED" ? "UNKNOWN" : "WARNING",
        tracking: s.trackingConfirmation,
      })),
      jobs: {
        status: syncHasError(jobs.syncStatus) ? "ERROR" : "HEALTHY",
        sync: jobs.syncStatus?.status ?? "idle",
      },
      exceptions: {
        status: openCritical > 0 ? "ERROR" : dq.exceptions.open > 0 ? "WARNING" : "HEALTHY",
        open: dq.exceptions.open,
        critical: openCritical,
      },
      finance: {
        status: dq.finance.reconciliationMismatches > 0 ? "WARNING" : "HEALTHY",
        reconciliationMismatches: dq.finance.reconciliationMismatches,
        openFxExceptions: dq.finance.openFxExceptions,
      },
      products: {
        status: "HEALTHY",
        count: dq.products.products,
      },
      mapping: {
        status: "HEALTHY",
        note: "File-based mapping configs; use Mapping Review for failures",
      },
      database: { status: "HEALTHY" },
    };
  }
}

function syncHasError(sync) {
  return Boolean(sync?.error) || sync?.status === "failed";
}
