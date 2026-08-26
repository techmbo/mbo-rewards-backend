import { Prisma } from "@prisma/client";

export function normalizeCouponKindParam(couponKind) {
  const value = String(couponKind ?? "").trim().toLowerCase();
  if (value === "link") return "Link";
  if (value === "code") return "Coupon";
  return null;
}

export function buildCouponKindPrismaWhere(entityType, couponKind) {
  const subtype = normalizeCouponKindParam(couponKind);
  if (entityType !== "coupon" || !subtype) return null;

  if (subtype === "Link") {
    return {
      OR: [{ entitySubType: "Link" }, { normalizedData: { path: ["code_type"], equals: "Link" } }],
    };
  }

  return {
    OR: [
      { entitySubType: "Coupon" },
      { normalizedData: { path: ["code_type"], equals: "Coupon" } },
      {
        AND: [
          { OR: [{ entitySubType: null }, { entitySubType: "" }] },
          {
            NOT: {
              OR: [
                { entitySubType: "Link" },
                { normalizedData: { path: ["code_type"], equals: "Link" } },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function buildCouponKindSqlCondition(entityType, couponKind) {
  const subtype = normalizeCouponKindParam(couponKind);
  if (entityType !== "coupon" || !subtype) return null;

  if (subtype === "Link") {
    return Prisma.sql`(
      "entitySubType" = 'Link'
      OR "normalizedData"#>>'{code_type}' = 'Link'
    )`;
  }

  return Prisma.sql`(
    "entitySubType" = 'Coupon'
    OR "normalizedData"#>>'{code_type}' = 'Coupon'
    OR (
      COALESCE("entitySubType", '') = ''
      AND COALESCE("normalizedData"#>>'{code_type}', '') NOT IN ('Link')
    )
  )`;
}

export function getCouponSummaryLabel(couponKind) {
  return normalizeCouponKindParam(couponKind) === "Link" ? "Total Link Coupons" : "Total Coupon Codes";
}
