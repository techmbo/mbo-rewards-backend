import { prisma } from "../../database/prisma.js";

/**
 * Master Catalog dashboard summary — matches MBO Rewards Master Catalog v11 workbook.
 */
export class MasterCatalogDashboardService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  async #countDistinctBrands(whereClause = "") {
    const extra = whereClause ? `WHERE ${whereClause}` : "";
    const rows = await this.db.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS total
      FROM (
        SELECT
          CASE
            WHEN sc."merchantId" IS NOT NULL THEN sc."merchantId"::text
            ELSE 'raw:' || LOWER(TRIM(sc."merchantNameRaw"))
          END AS brand_key
        FROM supplier_campaigns sc
        ${extra}
        GROUP BY brand_key
      ) brands
    `);
    return Number(rows?.[0]?.total ?? 0);
  }

  async #countAssignmentReadyCampaigns() {
    const rows = await this.db.$queryRaw`
      SELECT COUNT(DISTINCT cc.id)::int AS total
      FROM canonical_campaigns cc
      INNER JOIN campaign_sources cs
        ON cs."canonicalCampaignId" = cc.id
        AND cs."isActive" = true
        AND cs."relationshipStatus" = 'JOINED'
      INNER JOIN supplier_campaigns sc
        ON sc.id = cs."supplierCampaignId"
        AND sc."campaignStatus" = 'ACTIVE'
      WHERE cc."deletedAt" IS NULL
        AND (
          cs."supportsLink" = true
          OR cs."supportsCoupon" = true
          OR cs."channelSupport" @> ARRAY['DEEPLINK']::text[]
          OR sc."trackingUrl" IS NOT NULL
        )
        AND (
          cs."grossCommission" IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM supplier_commission_rules scr
            WHERE scr."campaignSourceId" = cs.id
          )
          OR sc."defaultCommissionValue" IS NOT NULL
        )
    `;
    return Number(rows?.[0]?.total ?? 0);
  }

  async getSummary() {
    const [
      brandsTotal,
      brandsNeedsReview,
      networkCampaignsTotal,
      masterCampaignsTotal,
      assignmentReady,
      newCodeAlertsTotal,
      assignmentReviewDrafts,
    ] = await Promise.all([
      this.#countDistinctBrands(),
      this.#countDistinctBrands(`sc."merchantId" IS NULL`),
      this.db.supplierCampaign.count(),
      this.db.canonicalCampaign.count({ where: { deletedAt: null } }),
      this.#countAssignmentReadyCampaigns(),
      this.db.couponCodeMaster.count({ where: { newCodeAlert: true } }),
      this.db.clientCampaignAssignment.count({
        where: { published: false, status: { not: "REVOKED" } },
      }),
    ]);

    const brandsReady = Math.max(0, brandsTotal - brandsNeedsReview);
    const masterCampaignsReady = assignmentReady;
    const masterCampaignsNeedsReview = Math.max(0, masterCampaignsTotal - masterCampaignsReady);

    return {
      kpis: {
        brands: brandsTotal,
        networkCampaigns: networkCampaignsTotal,
        masterCampaigns: masterCampaignsTotal,
        assignmentReady,
        newCodeAlerts: newCodeAlertsTotal,
      },
      navCounts: {
        brands: brandsTotal,
        masterCampaigns: masterCampaignsTotal,
        assignmentReview: assignmentReviewDrafts,
        newCodeAlerts: newCodeAlertsTotal,
      },
      operationalSummary: [
        {
          area: "Brands",
          total: brandsTotal,
          healthyReady: brandsReady,
          needsReview: brandsNeedsReview,
          needsReviewLabel:
            brandsNeedsReview > 0 ? `${brandsNeedsReview} mapping/brand review` : "—",
          actionLabel: "Open Brands",
          actionPath: "/master/brands",
        },
        {
          area: "Master Campaigns",
          total: masterCampaignsTotal,
          healthyReady: masterCampaignsReady,
          needsReview: masterCampaignsNeedsReview,
          needsReviewLabel:
            masterCampaignsNeedsReview > 0
              ? `${masterCampaignsNeedsReview} source/asset issues`
              : "—",
          actionLabel: "Open Master Campaigns",
          actionPath: "/master/campaigns",
        },
        {
          area: "Coupon Alerts",
          total: newCodeAlertsTotal,
          healthyReady: null,
          needsReview: newCodeAlertsTotal,
          needsReviewLabel: newCodeAlertsTotal > 0 ? String(newCodeAlertsTotal) : "—",
          actionLabel: "Review Alerts",
          actionPath: "/master/code-alerts",
          actionVariant: "alert",
        },
      ],
    };
  }
}
