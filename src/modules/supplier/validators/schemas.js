import { z } from "zod";

export const supplierKeySchema = z.enum(["BOOSTINY", "OPTIMISE", "TRACKIER", "PARTNERIZE", "IMPACT", "UNKNOWN"]);
export const supplierRegionSchema = z.enum(["GLOBAL", "SEA", "MENA", "UK", "UNKNOWN"]);
export const campaignStatusSchema = z.enum(["ACTIVE", "PAUSED", "PENDING", "RETIRED", "UNKNOWN"]);
export const participationStatusSchema = z.enum(["JOINED", "NOT_JOINED", "PENDING", "UNKNOWN"]);
export const couponTypeSchema = z.enum(["CODE", "LINK", "UNKNOWN"]);
export const couponStatusSchema = z.enum(["ACTIVE", "EXPIRED", "SCHEDULED", "UNKNOWN"]);
export const mapperErrorStatusSchema = z.enum(["OPEN", "RETRYING", "RESOLVED", "DISCARDED"]);

export const resourceIdSchema = z.string().min(1);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  cursor: z.string().optional(),
});

export const includePayloadsSchema = z
  .union([z.literal("true"), z.literal("false")])
  .transform((value) => value === "true")
  .optional();

export const moneySchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine((value) => /^-?\d+(\.\d{1,4})?$/.test(value), "Invalid money format");

export const supplierListQuerySchema = paginationSchema.extend({
  status: z.enum(["PLANNED", "ENABLED", "DEPRECATED"]).optional(),
});

export const supplierCampaignListQuerySchema = paginationSchema.extend({
  supplier: supplierKeySchema.optional(),
  supplierRegion: supplierRegionSchema.optional(),
  sourceAccountLabel: z.string().optional(),
  campaignStatus: campaignStatusSchema.optional(),
  participationStatus: participationStatusSchema.optional(),
  search: z.string().optional(),
  q: z.string().optional(),
  networkSource: supplierKeySchema.optional(),
  merchantId: z.string().uuid().optional(),
  brandKey: z.string().trim().min(1).max(200).optional(),
  includeArchived: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
  includePayloads: includePayloadsSchema,
  forMaster: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
});

export const supplierCampaignBrandParamsSchema = z.object({
  brandKey: z.string().trim().min(1).max(200),
});

export const supplierCampaignBrandsListQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
  supplier: supplierKeySchema.optional(),
  networkSource: supplierKeySchema.optional(),
  country: z.string().trim().min(1).max(8).optional(),
  status: z.string().trim().min(1).max(40).optional(),
});

export const supplierCampaignParamsSchema = z.object({
  id: resourceIdSchema,
});

export const supplierCouponListQuerySchema = paginationSchema.extend({
  supplierCampaignId: z.string().optional(),
  couponType: couponTypeSchema.optional(),
  couponStatus: couponStatusSchema.optional(),
  networkSource: z.string().optional(),
  search: z.string().optional(),
  includePayloads: includePayloadsSchema,
});

export const promoteCampaignsBodySchema = z.object({
  networkSource: z.string().optional(),
  entityIds: z.array(z.string()).optional(),
  entityTypes: z.array(z.enum(["campaign", "coupon"])).optional(),
});

export const promotionRunBodySchema = z.object({
  networkSource: z.string().optional(),
  entityIds: z.array(z.string()).optional(),
  entityTypes: z.array(z.enum(["campaign", "coupon"])).default(["campaign", "coupon"]),
  batchSize: z.coerce.number().int().min(1).max(500).optional(),
});

export const promotionRetryBodySchema = z.object({
  mapperErrorIds: z.array(z.string()).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const mapperErrorListQuerySchema = paginationSchema.extend({
  status: mapperErrorStatusSchema.optional(),
  supplier: supplierKeySchema.optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});

export const mapperErrorRetryParamsSchema = z.object({
  id: resourceIdSchema,
});
