import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { getSupplierCapabilities, listRegisteredSuppliers, isSupplierRegistered } from "../../adapters/registry.js";
import { getTrackingParamRule } from "../tracking/trackingParamRules.js";
import { getSyncStatus } from "../../jobs/syncState.js";

/**
 * How a product's campaign link was arrived at. A stored Product.campaignSourceId is a real
 * relation; anything inferred from a tracking URL is not, and the two are never reported as the
 * same thing.
 */
export const CAMPAIGN_LINK_NATIVE = "NATIVE_CAMPAIGN_SOURCE_FK";
export const CAMPAIGN_LINK_DERIVED = "DERIVED_BY_TRACKING_URL_PID_MATCH";
/** Non-enumerable marker key, so the flag never leaks into a spread or a JSON dump of the row. */
const CAMPAIGN_LINK_PROVENANCE = Symbol("campaignLinkProvenance");

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
    campaignLinkProvenance: product[CAMPAIGN_LINK_PROVENANCE] || (product.campaignSourceId ? CAMPAIGN_LINK_NATIVE : null),
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

/**
 * Wave G — product admin + data quality + supplier/job health.
 */
export class ProductOpsService {
  // No promotion/ingestion dependency: this service is read-only, and not holding one makes that
  // structural rather than a convention a future edit could quietly break.
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  /**
   * PURE READ. This method must never write.
   *
   * It previously called promotion.promoteBatch() before querying, which created and updated
   * Product and ProductSource rows and set RawPayload.processingStatus to PROMOTED — a write
   * performed during a GET, on every page load, filter change and pagination click. Promotion now
   * belongs only to the sync jobs and the explicit POST endpoints that already run it
   * (waveESupplierSync for Impact, optimiseProductFeedSync for Optimise feeds,
   * POST /ops/products/sync-feeds).
   *
   * The staged-Entity fallback is also gone: this endpoint returns canonical Product rows or an
   * empty page, never unpromoted RAW rows dressed in the same contract.
   */
  async listProducts(filters = {}, { skip = 0, take = 50 } = {}) {
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

    // Canonical only. An empty catalog returns an empty page: staged Entity(product) rows are a
    // different truth level and are not served under this contract.
    const enriched = await this.enrichMissingCampaignLinks(rows);
    return {
      rows: enriched.map(toAdminProductListDto),
      total,
      contract: "v13-products-feeds",
      truthLevel: "CANONICAL_PRODUCT",
    };
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
      // In memory only. This link is inferred by matching the publisher PID inside a campaign's
      // tracking URL; it is not a stored relation, and it used to be written back to the row from
      // inside a GET, which both wrote during a read and turned a heuristic into something
      // indistinguishable from a native foreign key. It is now returned with its provenance
      // attached and persisted nowhere.
      product.campaignSourceId = hit.campaignSourceId;
      product.campaignSource = hit.campaignSource;
      product[CAMPAIGN_LINK_PROVENANCE] = CAMPAIGN_LINK_DERIVED;
    }
    return rows;
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
    // Canonical only, like the listing: a staged Entity(product) row is not a Product, and
    // returning one here would reintroduce the mixed truth level under a single contract.
    if (!row) throw fail("Product not found.", 404);
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
