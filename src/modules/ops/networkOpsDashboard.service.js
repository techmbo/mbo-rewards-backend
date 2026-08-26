import { prisma } from "../../database/prisma.js";
import { listRegisteredSuppliers } from "../../adapters/registry.js";

const DATA_FLOW_STAGES = Object.freeze([
  { key: "network_api", label: "Network API Response" },
  { key: "raw_payload", label: "Full Raw Payload" },
  { key: "source_schema", label: "Source Schema" },
  { key: "mapping_engine", label: "Mapping Engine" },
  { key: "mbo_standard", label: "MBO Standard Fields" },
  { key: "client_safe", label: "Client-Safe Model" },
]);

/**
 * Daily Network Operations dashboard — KPI counts + separated source layers.
 * Counts are live from DB; never grouped into a single “asset” aggregate.
 */
export class NetworkOpsDashboardService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  async getSummary() {
    const [
      marketplaceAccounts,
      connectedAccounts,
      campaignSources,
      supplierCommissionRules,
      openMappingExceptions,
      entityTypeGroups,
      trackingLinks,
      conversions,
      rawPayloads,
      productFeedItems,
      financialTransactions,
    ] = await Promise.all([
      this.db.marketplaceAccount.count(),
      this.db.marketplaceAccount.count({
        where: {
          OR: [
            { encryptedAccessToken: { not: "" } },
            { maskedApiKey: { not: null } },
          ],
        },
      }),
      this.db.campaignSource.count({ where: { isActive: true } }),
      this.db.supplierCommissionRule.count(),
      this.db.mapperError.count({
        where: { status: { in: ["OPEN", "RETRYING"] } },
      }),
      this.db.entity.groupBy({
        by: ["entityType"],
        _count: { _all: true },
      }),
      this.db.trackingLink.count().catch(() => 0),
      this.db.conversion.count().catch(() => 0),
      this.db.rawPayload.count().catch(() => 0),
      this.db.productFeedItem.count().catch(() => 0),
      this.db.financialTransaction.count().catch(() => 0),
    ]);

    const entityCounts = Object.fromEntries(
      (entityTypeGroups || []).map((row) => [String(row.entityType || "").toLowerCase(), row._count._all]),
    );

    const countFor = (...types) =>
      types.reduce((sum, type) => sum + (entityCounts[String(type).toLowerCase()] || 0), 0);

    const sourceLayers = Object.freeze([
      { key: "campaign", label: "Campaign", count: countFor("campaign") },
      { key: "commission", label: "Commission", count: supplierCommissionRules },
      { key: "coupon", label: "Coupon", count: countFor("coupon") },
      { key: "link", label: "Link", count: trackingLinks },
      { key: "offer", label: "Offer", count: countFor("offer", "promotion", "deal") },
      { key: "product", label: "Product", count: productFeedItems || countFor("product") },
      {
        key: "performance",
        label: "Performance",
        count: countFor("performance", "report", "reporting"),
      },
      { key: "order", label: "Order", count: conversions || countFor("conversion", "order") },
      { key: "payment", label: "Payment", count: financialTransactions || countFor("payment") },
    ]);

    return {
      kpis: {
        networkSources: {
          count: marketplaceAccounts,
          connectedCount: connectedAccounts,
          registeredNetworks: listRegisteredSuppliers().length,
          hint: "Connected / implementation profiles",
        },
        campaignSources: {
          count: campaignSources,
          hint: "Active source records from networks",
        },
        supplierCommissionRules: {
          count: supplierCommissionRules,
          hint: "Separate rule records",
        },
        openMappingExceptions: {
          count: openMappingExceptions,
          hint: "Require review",
        },
      },
      dataFlow: {
        stages: DATA_FLOW_STAGES,
        operationalRule:
          "Raw supplier/network data is never discarded. MBO standard controls naming and client meaning; network-specific fields remain in raw/source layers unless explicitly mapped.",
      },
      sourceLayers,
      evidence: {
        rawPayloads,
        importedEntities: Object.values(entityCounts).reduce((a, b) => a + b, 0),
      },
    };
  }
}
