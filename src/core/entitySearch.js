import { Prisma } from "@prisma/client";
import { buildCouponKindSqlCondition } from "./couponKind.js";

function buildAccountLabelCondition(accountLabel) {
  const normalized = accountLabel ? String(accountLabel).trim().toLowerCase() : "";
  if (!normalized) return null;

  if (normalized === "default") {
    return Prisma.sql`"externalId" NOT LIKE '%:%'`;
  }

  return Prisma.sql`"externalId" LIKE ${`${normalized}:%`}`;
}

function buildDateCondition({ fromDate, toDate, entityType }) {
  if (!fromDate && !toDate) return null;

  if (entityType === "campaign") {
    const eventRange = [];
    if (fromDate) eventRange.push(Prisma.sql`"eventDate" >= ${fromDate}`);
    if (toDate) eventRange.push(Prisma.sql`"eventDate" <= ${toDate}`);

    const createdRange = [];
    if (fromDate) createdRange.push(Prisma.sql`"createdAt" >= ${fromDate}`);
    if (toDate) createdRange.push(Prisma.sql`"createdAt" <= ${toDate}`);

    if (eventRange.length === 0 && createdRange.length === 0) return null;

    const eventClause =
      eventRange.length > 0
        ? Prisma.sql`(${Prisma.join(eventRange, " AND ")})`
        : Prisma.sql`"eventDate" IS NOT NULL`;

    const createdClause =
      createdRange.length > 0
        ? Prisma.sql`("eventDate" IS NULL AND ${Prisma.join(createdRange, " AND ")})`
        : Prisma.sql`"eventDate" IS NULL`;

    return Prisma.sql`(${eventClause} OR ${createdClause})`;
  }

  const range = [];
  if (fromDate) range.push(Prisma.sql`"eventDate" >= ${fromDate}`);
  if (toDate) range.push(Prisma.sql`"eventDate" <= ${toDate}`);
  return range.length > 0 ? Prisma.sql`(${Prisma.join(range, " AND ")})` : null;
}

/**
 * Resolve display brand for campaigns:
 * Optimise → advertiserName; Boostiny/Trackier → entityName (fallback advertiserName).
 */
export function buildCampaignBrandExpression() {
  return Prisma.sql`
    CASE
      WHEN LOWER(COALESCE("networkSource", '')) LIKE 'optimise%' THEN
        NULLIF(TRIM(COALESCE("advertiserName", '')), '')
      ELSE
        COALESCE(
          NULLIF(TRIM(COALESCE("advertiserName", '')), ''),
          NULLIF(TRIM(COALESCE("entityName", '')), '')
        )
    END
  `;
}

function buildBrandCondition(brand) {
  const value = brand ? String(brand).trim() : "";
  if (!value) return null;
  return Prisma.sql`LOWER(${buildCampaignBrandExpression()}) = LOWER(${value})`;
}

export function buildEntitySearchCondition(search) {
  const query = String(search ?? "").trim();
  if (!query) return null;

  const pattern = `%${query}%`;
  return Prisma.sql`(
    COALESCE("entityName", '') ILIKE ${pattern}
    OR COALESCE("campaignName", '') ILIKE ${pattern}
    OR COALESCE("advertiserName", '') ILIKE ${pattern}
    OR COALESCE("entityStatus", '') ILIKE ${pattern}
    OR COALESCE("entitySubType", '') ILIKE ${pattern}
    OR COALESCE("code", '') ILIKE ${pattern}
    OR COALESCE("discount", '') ILIKE ${pattern}
    OR COALESCE("networkSource", '') ILIKE ${pattern}
    OR COALESCE("externalId", '') ILIKE ${pattern}
    OR CAST("revenue" AS TEXT) ILIKE ${pattern}
    OR CAST("commission" AS TEXT) ILIKE ${pattern}
    OR "rawData"::text ILIKE ${pattern}
    OR "normalizedData"::text ILIKE ${pattern}
  )`;
}

export function buildEntityListWhere({
  entityType,
  networkSource,
  accountLabel,
  fromDate,
  toDate,
  search,
  couponKind,
  brand,
}) {
  const conditions = [];

  if (entityType) {
    conditions.push(Prisma.sql`"entityType" = ${entityType}`);
  }

  if (networkSource) {
    conditions.push(Prisma.sql`"networkSource" = ${networkSource}`);
  }

  const accountCondition = buildAccountLabelCondition(accountLabel);
  if (accountCondition) conditions.push(accountCondition);

  const dateCondition = buildDateCondition({ fromDate, toDate, entityType });
  if (dateCondition) conditions.push(dateCondition);

  const couponKindCondition = buildCouponKindSqlCondition(entityType, couponKind);
  if (couponKindCondition) conditions.push(couponKindCondition);

  const searchCondition = buildEntitySearchCondition(search);
  if (searchCondition) conditions.push(searchCondition);

  if (entityType === "campaign") {
    const brandCondition = buildBrandCondition(brand);
    if (brandCondition) conditions.push(brandCondition);
  }

  if (conditions.length === 0) return Prisma.empty;
  return Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
}

export function buildEntityListOrderBy(networkSource) {
  if (networkSource) {
    return Prisma.sql`ORDER BY "updatedAt" DESC`;
  }

  return Prisma.sql`ORDER BY "networkSource" ASC, "updatedAt" DESC`;
}
