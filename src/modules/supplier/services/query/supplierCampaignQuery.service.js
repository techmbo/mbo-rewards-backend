import { prisma } from "../../../../database/prisma.js";
import { decodeCursor, encodeCursor } from "../../../../core/cursorPagination.js";
import { getPagination, toStandardPagedResponse } from "../../../../core/pagination.js";
import { applySupplierCampaignAccess } from "../../../../auth/supplierDataAccess.js";
import {
  toMasterSupplierCampaignDto,
  toNetworkBrandDto,
  toSupplierCampaignDto,
} from "../../dto/supplierCampaign.dto.js";
import { SupplierCampaignRepository } from "../../repositories/supplierCampaign.repository.js";

function normalizeListQuery(query = {}) {
  return {
    ...query,
    supplier: query.supplier || query.networkSource || undefined,
    search: query.search || query.q || undefined,
  };
}

function buildBrandWhere(query = {}) {
  const clauses = [
    `sc."archivedAt" IS NULL`,
    `(sc."merchantNameRaw" IS NOT NULL OR sc."merchantId" IS NOT NULL)`,
  ];
  const params = [];
  let index = 1;
  const supplier = query.supplier || query.networkSource;
  if (supplier) {
    clauses.push(`sc.supplier = $${index++}::"SupplierKey"`);
    params.push(supplier);
  }
  if (query.search) {
    clauses.push(`(sc."merchantNameRaw" ILIKE $${index} OR m."displayName" ILIKE $${index})`);
    params.push(`%${String(query.search).trim()}%`);
    index += 1;
  }
  if (query.country) {
    clauses.push(`(m.country = $${index} OR $${index} = ANY(sc."countryCodes"))`);
    params.push(String(query.country).trim());
    index += 1;
  }
  if (query.status) {
    const status = String(query.status).trim().toUpperCase();
    if (status === "NETWORK") {
      clauses.push(`sc."merchantId" IS NULL`);
    } else {
      clauses.push(`m.status = $${index++}::"MerchantStatus"`);
      params.push(status);
    }
  }
  return { whereSql: clauses.join(" AND "), params };
}

export class SupplierCampaignQueryService {
  constructor(deps = {}) {
    this.campaignRepo = deps.campaignRepo ?? new SupplierCampaignRepository();
  }

  buildFilters(query) {
    const normalized = normalizeListQuery(query);
    return {
      supplier: normalized.supplier,
      supplierRegion: normalized.supplierRegion,
      sourceAccountLabel: normalized.sourceAccountLabel,
      campaignStatus: normalized.campaignStatus,
      participationStatus: normalized.participationStatus,
      search: normalized.search,
      includeArchived: normalized.includeArchived,
      merchantId: normalized.merchantId,
      brandKey: normalized.brandKey,
    };
  }

  project(record, permissions, options) {
    const dto = options?.forMaster
      ? toMasterSupplierCampaignDto(record)
      : toSupplierCampaignDto(record);
    return applySupplierCampaignAccess(dto, permissions, options);
  }

  async list(query, permissions = []) {
    const filters = this.buildFilters(query);
    const { page, pageSize, skip } = getPagination(query);
    const includePayloads = query.includePayloads === true;
    const forMaster = query.forMaster === true || query.forMaster === "true";
    const useCursor = Boolean(query.cursor);

    if (useCursor) {
      const cursor = decodeCursor(query.cursor, ["lastSyncedAt", "id"]);
      const { rows, hasMore } = await this.campaignRepo.findManyCursor(filters, {
        take: pageSize,
        cursor,
      });

      const data = rows.map((row) =>
        this.project(row, permissions, { includePayloads, forMaster }),
      );
      const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1], ["lastSyncedAt", "id"]) : null;

      return toStandardPagedResponse({
        rows: data,
        total: null,
        page: null,
        pageSize,
        nextCursor,
        hasMore,
      });
    }

    const { rows, total } = await this.campaignRepo.findMany(filters, {
      skip,
      take: pageSize,
      includeMaster: forMaster,
    });
    const data = rows.map((row) => this.project(row, permissions, { includePayloads, forMaster }));

    return toStandardPagedResponse({ rows: data, total, page, pageSize, hasMore: skip + rows.length < total });
  }

  async getById(id, permissions = [], options = {}) {
    const forMaster = options.forMaster === true;
    const record = await this.campaignRepo.findById(id, { includeMaster: forMaster });
    if (!record) return null;
    return this.project(record, permissions, options);
  }

  async listNetworkBrands(query) {
    const { page, pageSize, skip } = getPagination(query);
    const { whereSql, params } = buildBrandWhere(query);

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM (
        SELECT
          CASE
            WHEN sc."merchantId" IS NOT NULL THEN sc."merchantId"::text
            ELSE 'raw:' || LOWER(TRIM(sc."merchantNameRaw"))
          END AS brand_key
        FROM supplier_campaigns sc
        LEFT JOIN merchants m ON sc."merchantId" = m.id
        WHERE ${whereSql}
        GROUP BY brand_key
      ) brands
    `;

    const listSql = `
      SELECT
        brand_key AS id,
        MAX("merchantId"::text) AS "merchantId",
        MAX(display_name) AS "displayName",
        MAX(logo_url) AS "logoUrl",
        MAX(website) AS website,
        MAX(category) AS category,
        MAX(country) AS country,
        MAX(status) AS status,
        BOOL_OR(is_verified) AS "isVerified",
        array_agg(DISTINCT supplier) AS "networkSources",
        COUNT(*)::int AS "campaignCount",
        COUNT(*) FILTER (WHERE campaign_status = 'ACTIVE')::int AS "activeCampaignCount",
        COUNT(*) FILTER (WHERE has_coupon)::int AS "couponCampaignCount",
        COUNT(*) FILTER (WHERE has_link)::int AS "linkCampaignCount",
        COUNT(*) FILTER (WHERE has_product)::int AS "productCampaignCount",
        COUNT(DISTINCT canonical_campaign_id)::int AS "masterCampaignCount",
        MAX("lastSyncedAt") AS "lastSyncedAt"
      FROM (
        SELECT
          CASE
            WHEN sc."merchantId" IS NOT NULL THEN sc."merchantId"::text
            ELSE 'raw:' || LOWER(TRIM(sc."merchantNameRaw"))
          END AS brand_key,
          sc."merchantId",
          COALESCE(
            m."displayName",
            sc."merchantNameRaw",
            CASE
              WHEN sc."campaignName" LIKE '%|%' THEN TRIM(SPLIT_PART(sc."campaignName", '|', 1))
              WHEN sc."campaignName" ~* '^(.+?)\s+(Partners?|Affiliates?|Programme|Program|Network)\b' THEN
                TRIM(REGEXP_REPLACE(sc."campaignName", '\s+(Partners?|Affiliates?|Programme|Program|Network).*$', '', 'i'))
              ELSE NULL
            END
          ) AS display_name,
          COALESCE(m."logoUrl", sc."campaignLogoUrl") AS logo_url,
          COALESCE(
            m.website,
            CASE WHEN sc."merchantId" IS NULL AND sc."merchantNameRaw" ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]+[.][a-zA-Z]{2,}$'
              THEN 'https://' || LOWER(TRIM(sc."merchantNameRaw"))
            END
          ) AS website,
          COALESCE(m.category, sc."categoryName") AS category,
          COALESCE(m.country, sc."countryCodes"[1]) AS country,
          CASE WHEN m.id IS NOT NULL THEN m.status::text ELSE 'NETWORK' END AS status,
          COALESCE(m."isVerified", false) AS is_verified,
          sc.supplier,
          sc."campaignStatus"::text AS campaign_status,
          EXISTS (
            SELECT 1 FROM supplier_coupons scp WHERE scp."supplierCampaignId" = sc.id
          ) OR COALESCE(cs."supportsCoupon", false)
            OR LOWER(COALESCE(sc."campaignType", '')) LIKE '%coupon%' AS has_coupon,
          COALESCE(cs."supportsLink", false)
            OR (sc."trackingUrl" IS NOT NULL AND LENGTH(TRIM(sc."trackingUrl")) > 0)
            OR COALESCE(sc."deepLinkingEnabled", false) AS has_link,
          EXISTS (
            SELECT 1 FROM products p WHERE p."campaignSourceId" = cs.id
          ) OR EXISTS (
            SELECT 1 FROM product_feeds pf WHERE pf."campaignSourceId" = cs.id
          ) AS has_product,
          cs."canonicalCampaignId" AS canonical_campaign_id,
          sc."lastSyncedAt"
        FROM supplier_campaigns sc
        LEFT JOIN merchants m ON sc."merchantId" = m.id
        LEFT JOIN LATERAL (
          SELECT cs0.id, cs0."canonicalCampaignId", cs0."supportsCoupon", cs0."supportsLink"
          FROM campaign_sources cs0
          WHERE cs0."supplierCampaignId" = sc.id
          ORDER BY cs0."isPrimary" DESC, cs0.priority ASC
          LIMIT 1
        ) cs ON TRUE
        WHERE ${whereSql}
      ) brand_rows
      GROUP BY brand_key
      ORDER BY MAX("lastSyncedAt") DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const [countRows, brandRows] = await Promise.all([
      prisma.$queryRawUnsafe(countSql, ...params),
      prisma.$queryRawUnsafe(listSql, ...params, pageSize, skip),
    ]);

    const total = Number(countRows?.[0]?.total ?? 0);
    const data = brandRows.map((row) => toNetworkBrandDto(row));

    return toStandardPagedResponse({
      rows: data,
      total,
      page,
      pageSize,
      hasMore: skip + data.length < total,
    });
  }

  /**
   * Brand Workspace (Master Catalog v11) — overview KPIs, brand info, network summary.
   * brandKey is merchants.id or `raw:<lower-trimmed-merchantNameRaw>`.
   */
  async getNetworkBrandWorkspace(brandKey) {
    const key = decodeURIComponent(String(brandKey || "").trim());
    if (!key) return null;

    const isRaw = key.startsWith("raw:");
    const rawName = isRaw ? key.slice(4) : null;
    const merchantId = isRaw ? null : key;

    const brandClause = isRaw
      ? `sc."merchantId" IS NULL AND LOWER(TRIM(sc."merchantNameRaw")) = $1`
      : `sc."merchantId"::text = $1`;
    const brandParam = isRaw ? rawName : merchantId;

    const baseWhere = `sc."archivedAt" IS NULL AND (${brandClause})`;

    const brandSql = `
      SELECT
        brand_key AS id,
        MAX("merchantId"::text) AS "merchantId",
        MAX(display_name) AS "displayName",
        MAX(logo_url) AS "logoUrl",
        MAX(website) AS website,
        MAX(category) AS category,
        MAX(country) AS country,
        MAX(status) AS status,
        BOOL_OR(is_verified) AS "isVerified",
        MAX(notes) AS notes,
        array_agg(DISTINCT supplier) FILTER (WHERE supplier IS NOT NULL) AS "networkSources",
        COUNT(*)::int AS "campaignCount",
        COUNT(*) FILTER (WHERE campaign_status = 'ACTIVE')::int AS "activeCampaignCount",
        COUNT(*) FILTER (WHERE has_coupon)::int AS "couponCampaignCount",
        COUNT(*) FILTER (WHERE has_link)::int AS "linkCampaignCount",
        COUNT(*) FILTER (WHERE has_product)::int AS "productCampaignCount",
        COUNT(DISTINCT canonical_campaign_id)::int AS "masterCampaignCount",
        MAX("lastSyncedAt") AS "lastSyncedAt"
      FROM (
        SELECT
          CASE
            WHEN sc."merchantId" IS NOT NULL THEN sc."merchantId"::text
            ELSE 'raw:' || LOWER(TRIM(sc."merchantNameRaw"))
          END AS brand_key,
          sc."merchantId",
          COALESCE(m."displayName", sc."merchantNameRaw") AS display_name,
          COALESCE(m."logoUrl", sc."campaignLogoUrl") AS logo_url,
          m.website,
          COALESCE(m.category, sc."categoryName") AS category,
          COALESCE(m.country, sc."countryCodes"[1]) AS country,
          CASE WHEN m.id IS NOT NULL THEN m.status::text ELSE 'NETWORK' END AS status,
          COALESCE(m."isVerified", false) AS is_verified,
          m.notes,
          sc.supplier,
          sc."campaignStatus"::text AS campaign_status,
          EXISTS (SELECT 1 FROM supplier_coupons scp WHERE scp."supplierCampaignId" = sc.id)
            OR COALESCE(cs."supportsCoupon", false)
            OR LOWER(COALESCE(sc."campaignType", '')) LIKE '%coupon%' AS has_coupon,
          COALESCE(cs."supportsLink", false)
            OR (sc."trackingUrl" IS NOT NULL AND LENGTH(TRIM(sc."trackingUrl")) > 0)
            OR COALESCE(sc."deepLinkingEnabled", false) AS has_link,
          EXISTS (SELECT 1 FROM products p WHERE p."campaignSourceId" = cs.id)
            OR EXISTS (SELECT 1 FROM product_feeds pf WHERE pf."campaignSourceId" = cs.id) AS has_product,
          cs."canonicalCampaignId" AS canonical_campaign_id,
          sc."lastSyncedAt"
        FROM supplier_campaigns sc
        LEFT JOIN merchants m ON sc."merchantId" = m.id
        LEFT JOIN LATERAL (
          SELECT cs0.id, cs0."canonicalCampaignId", cs0."supportsCoupon", cs0."supportsLink"
          FROM campaign_sources cs0
          WHERE cs0."supplierCampaignId" = sc.id
          ORDER BY cs0."isPrimary" DESC, cs0.priority ASC
          LIMIT 1
        ) cs ON TRUE
        WHERE ${baseWhere}
      ) brand_rows
      GROUP BY brand_key
      LIMIT 1
    `;

    const networkSql = `
      SELECT
        supplier AS network,
        COUNT(*)::int AS campaigns,
        COUNT(*) FILTER (WHERE has_coupon)::int AS "couponCampaigns",
        COUNT(*) FILTER (WHERE has_link)::int AS "linkCampaigns",
        COUNT(*) FILTER (WHERE has_product)::int AS "productCampaigns",
        MAX("lastSyncedAt") AS "lastSyncedAt"
      FROM (
        SELECT
          sc.supplier,
          EXISTS (SELECT 1 FROM supplier_coupons scp WHERE scp."supplierCampaignId" = sc.id)
            OR COALESCE(cs."supportsCoupon", false)
            OR LOWER(COALESCE(sc."campaignType", '')) LIKE '%coupon%' AS has_coupon,
          COALESCE(cs."supportsLink", false)
            OR (sc."trackingUrl" IS NOT NULL AND LENGTH(TRIM(sc."trackingUrl")) > 0)
            OR COALESCE(sc."deepLinkingEnabled", false) AS has_link,
          EXISTS (SELECT 1 FROM products p WHERE p."campaignSourceId" = cs.id)
            OR EXISTS (SELECT 1 FROM product_feeds pf WHERE pf."campaignSourceId" = cs.id) AS has_product,
          sc."lastSyncedAt"
        FROM supplier_campaigns sc
        LEFT JOIN LATERAL (
          SELECT cs0.id, cs0."supportsCoupon", cs0."supportsLink"
          FROM campaign_sources cs0
          WHERE cs0."supplierCampaignId" = sc.id
          ORDER BY cs0."isPrimary" DESC, cs0.priority ASC
          LIMIT 1
        ) cs ON TRUE
        WHERE ${baseWhere}
      ) net_rows
      GROUP BY supplier
      ORDER BY COUNT(*) DESC
    `;

    const couponCountSql = `
      SELECT COUNT(*)::int AS total
      FROM supplier_coupons c
      INNER JOIN supplier_campaigns sc ON c."supplierCampaignId" = sc.id
      WHERE ${baseWhere}
    `;

    const productCountSql = isRaw
      ? `
        SELECT COUNT(*)::int AS total
        FROM products p
        WHERE LOWER(TRIM(COALESCE(p.brand, ''))) = $1
           OR EXISTS (
             SELECT 1 FROM campaign_sources cs
             INNER JOIN supplier_campaigns sc ON cs."supplierCampaignId" = sc.id
             WHERE cs.id = p."campaignSourceId"
               AND sc."merchantId" IS NULL
               AND LOWER(TRIM(sc."merchantNameRaw")) = $1
           )
      `
      : `
        SELECT COUNT(*)::int AS total
        FROM products p
        WHERE p."merchantId"::text = $1
           OR EXISTS (
             SELECT 1 FROM campaign_sources cs
             INNER JOIN supplier_campaigns sc ON cs."supplierCampaignId" = sc.id
             WHERE cs.id = p."campaignSourceId" AND sc."merchantId"::text = $1
           )
      `;

    const countriesSql = `
      SELECT DISTINCT UNNEST(sc."countryCodes") AS country
      FROM supplier_campaigns sc
      WHERE ${baseWhere}
        AND sc."countryCodes" IS NOT NULL
        AND cardinality(sc."countryCodes") > 0
    `;

    const [brandRows, networkRows, couponRows, productRows, countryRows, aliases] =
      await Promise.all([
        prisma.$queryRawUnsafe(brandSql, brandParam),
        prisma.$queryRawUnsafe(networkSql, brandParam),
        prisma.$queryRawUnsafe(couponCountSql, brandParam),
        prisma.$queryRawUnsafe(productCountSql, brandParam),
        prisma.$queryRawUnsafe(countriesSql, brandParam),
        merchantId
          ? prisma.merchantAlias.findMany({
              where: { merchantId, status: { in: ["CONFIRMED", "CANDIDATE"] } },
              select: { aliasValue: true },
              take: 50,
            })
          : Promise.resolve([]),
      ]);

    const brandRow = brandRows?.[0];
    if (!brandRow) return null;

    const brand = toNetworkBrandDto(brandRow);
    const primaryCountry = brand.primaryCountry || brand.country;
    const secondaryCountries = (countryRows || [])
      .map((r) => r.country)
      .filter((c) => c && c !== primaryCountry);
    const networkSummary = (networkRows || []).map((row) => {
      const last = row.lastSyncedAt ? new Date(row.lastSyncedAt) : null;
      const stale =
        !last || Number.isNaN(last.getTime()) || Date.now() - last.getTime() > 7 * 24 * 60 * 60 * 1000;
      return {
        network: row.network,
        campaigns: Number(row.campaigns ?? 0),
        couponCampaigns: Number(row.couponCampaigns ?? 0),
        linkCampaigns: Number(row.linkCampaigns ?? 0),
        productCampaigns: Number(row.productCampaigns ?? 0),
        sourceHealth: stale ? "Warning" : "Healthy",
        lastSyncedAt: brand.lastSyncedAt,
      };
    });

    const aliasNames = (aliases || []).map((a) => a.aliasValue).filter(Boolean);
    const networkNames = (brand.networkSources || [])
      .map((s) =>
        String(s)
          .replaceAll("_", " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()),
      )
      .join(", ");

    return {
      ...brand,
      description:
        brandRow.notes ||
        (brand.category ? `${brand.category} brand` : null) ||
        "Network brand from supplier campaigns",
      secondaryCategory: null,
      secondaryCountries,
      aliases: aliasNames,
      couponRecordCount: Number(couponRows?.[0]?.total ?? 0),
      productRecordCount: Number(productRows?.[0]?.total ?? 0),
      networkNames,
      networkSummary,
      brandKey: brand.id || key,
    };
  }
}
