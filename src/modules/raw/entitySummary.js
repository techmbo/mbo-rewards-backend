import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { buildCampaignBrandExpression, buildEntityListWhere } from "../../core/entitySearch.js";
import { getCouponSummaryLabel } from "../../core/couponKind.js";
import { sumColumn } from "../../core/jsonNumericSql.js";

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function countMetric(label, value) {
  return { label, value: toNumber(value), format: "count" };
}

function currencyMetric(label, value) {
  return { label, value: toNumber(value), format: "currency" };
}

async function runAggregate(whereClause, selectSql) {
  const [row] = await prisma.$queryRaw(
    Prisma.sql`
      SELECT ${selectSql}
      FROM "Entity"
      ${whereClause}
    `,
  );
  return row ?? {};
}

async function listCampaignBrands(filters) {
  const brandExpr = buildCampaignBrandExpression();
  const whereClause = buildEntityListWhere({ ...filters, brand: undefined });

  const rows = await prisma.$queryRaw(
    Prisma.sql`
      SELECT brand
      FROM (
        SELECT ${brandExpr} AS brand
        FROM "Entity"
        ${whereClause}
      ) brands
      WHERE brand IS NOT NULL
      GROUP BY brand
      ORDER BY brand ASC
      LIMIT 2000
    `,
  );

  return (rows || []).map((row) => row.brand).filter(Boolean);
}

export async function getEntitySummary({
  entityType,
  networkSource,
  accountLabel,
  fromDate,
  toDate,
  search,
  couponKind,
  brand,
}) {
  const filters = {
    entityType,
    networkSource,
    accountLabel,
    fromDate,
    toDate,
    search,
    couponKind,
    brand,
  };
  const whereClause = buildEntityListWhere(filters);

  if (entityType === "campaign") {
    const brandExpr = buildCampaignBrandExpression();
    const [row, brands] = await Promise.all([
      runAggregate(
        whereClause,
        Prisma.sql`
          COUNT(*)::int AS total,
          COUNT(DISTINCT ${brandExpr})::int AS unique_brands
        `,
      ),
      listCampaignBrands(filters),
    ]);

    return {
      metrics: [
        countMetric("Total Campaigns", row.total),
        countMetric("Unique Brands", row.unique_brands),
      ],
      brands,
    };
  }

  if (entityType === "coupon") {
    const row = await runAggregate(whereClause, Prisma.sql`COUNT(*)::int AS total`);
    return { metrics: [countMetric(getCouponSummaryLabel(couponKind), row.total)] };
  }

  if (entityType === "conversion") {
    const row = await runAggregate(
      whereClause,
      Prisma.sql`
        COUNT(*)::int AS total,
        ${sumColumn(["orders", "totalConversions"])} AS gross_orders,
        ${sumColumn(["net_orders", "validatedConversions"])} AS net_orders,
        ${sumColumn([
          "conversionValue.amount",
          "origConversionValue.amount",
          "rawConversionValue.amount",
          "sales_amount_usd",
          "sales_amount",
          "revenue",
        ])} AS order_value,
        ${sumColumn(["net_sales_amount_usd", "net_sales_amount"])} AS net_order_value,
        ${sumColumn(["commission.amount", "net_revenue", "revenue", "validatedCommission"])} AS commission
      `,
    );

    return {
      metrics: [
        countMetric("Total Conversions", row.total),
        countMetric("Total Gross Orders", row.gross_orders),
        countMetric("Total Net Orders", row.net_orders),
        currencyMetric("Total Order Value", row.order_value),
        currencyMetric("Total Net Order Value", row.net_order_value),
        currencyMetric("Total Commission", row.commission),
      ],
    };
  }

  if (entityType === "performance") {
    const row = await runAggregate(
      whereClause,
      Prisma.sql`
        COUNT(*)::int AS total,
        ${sumColumn(["clicks"])} AS clicks,
        ${sumColumn(["orders", "totalConversions"])} AS gross_orders,
        ${sumColumn(["net_orders", "validatedConversions"])} AS net_orders,
        ${sumColumn(["sales_amount_usd", "originalOrderValue"])} AS gross_order_value,
        ${sumColumn(["net_sales_amount_usd"])} AS net_order_value,
        ${sumColumn(["validatedCommission", "net_revenue"])} AS net_commission,
        ${sumColumn(["pendingConversions"])} AS non_validated_orders,
        ${sumColumn(["rejectedConversions"])} AS cancelled_orders
      `,
    );

    return {
      metrics: [
        countMetric("Total Records", row.total),
        countMetric("Total Clicks", row.clicks),
        countMetric("Total Gross Orders", row.gross_orders),
        countMetric("Total Net Orders", row.net_orders),
        currencyMetric("Total Gross Order Value", row.gross_order_value),
        currencyMetric("Total Net Order Value", row.net_order_value),
        currencyMetric("Total Net Commission", row.net_commission),
        countMetric("Total Non Validated Orders", row.non_validated_orders),
        countMetric("Total Cancelled Orders", row.cancelled_orders),
      ],
    };
  }

  if (entityType === "payment") {
    const row = await runAggregate(
      whereClause,
      Prisma.sql`
        COUNT(*)::int AS total,
        ${sumColumn(["netPayout", "net", "net_revenue", "revenue"])} AS net_payout,
        ${sumColumn(["vatPayout", "vat"])} AS vat_payout,
        ${sumColumn(["total", "gross", "sales_amount_usd", "sales_amount"])} AS total_amount
      `,
    );

    return {
      metrics: [
        countMetric("Total Payments", row.total),
        currencyMetric("Total Net Payout", row.net_payout),
        currencyMetric("Total VAT Payout", row.vat_payout),
        currencyMetric("Total Amount", row.total_amount),
      ],
    };
  }

  const row = await runAggregate(whereClause, Prisma.sql`COUNT(*)::int AS total`);
  return { metrics: [countMetric("Total Records", row.total)] };
}
