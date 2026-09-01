import { z } from "zod";
import { supplierKeySchema } from "../../supplier/validators/schemas.js";

export const resourceIdSchema = z.string().min(1);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  cursor: z.string().optional(),
});

export const merchantStatusSchema = z.enum(["DRAFT", "ACTIVE", "MERGED", "ARCHIVED"]);
export const merchantVerificationStatusSchema = z.enum(["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"]);
export const merchantReviewStatusSchema = z.enum([
  "AUTO_MATCHED",
  "PENDING_REVIEW",
  "MANUALLY_MATCHED",
  "REJECTED",
  "MERGED",
]);

export const merchantListQuerySchema = paginationSchema.extend({
  status: merchantStatusSchema.optional(),
  verificationStatus: merchantVerificationStatusSchema.optional(),
  isVerified: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
  country: z.string().length(2).optional(),
  search: z.string().optional(),
  unmatched: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
});

export const merchantParamsSchema = z.object({
  id: resourceIdSchema,
});

export const createMerchantBodySchema = z.object({
  displayName: z.string().min(1).max(500),
  website: z.string().url().optional().nullable(),
  supplierTrackingLink: z.string().url().optional().nullable(),
  couponDescription: z.string().max(5000).optional().nullable(),
  category: z.string().max(200).optional().nullable(),
  logoUrl: z.string().url().optional().nullable(),
  country: z.string().length(2).optional().nullable(),
  status: merchantStatusSchema.optional(),
  verificationStatus: merchantVerificationStatusSchema.optional(),
  isVerified: z.boolean().optional(),
  notes: z.string().max(5000).optional().nullable(),
  /** Primary affiliate network this merchant is associated with (SupplierKey). */
  networkSource: supplierKeySchema.optional().nullable(),
});

export const updateMerchantBodySchema = createMerchantBodySchema.partial();

export const mergeMerchantBodySchema = z.object({
  targetMerchantId: resourceIdSchema,
  notes: z.string().max(5000).optional().nullable(),
});

export const runMatchingBodySchema = z.object({
  supplierCampaignIds: z.array(resourceIdSchema).optional(),
  batchSize: z.coerce.number().int().min(1).max(500).default(100),
  supplier: supplierKeySchema.optional(),
});

export const merchantReviewListQuerySchema = paginationSchema.extend({
  status: merchantReviewStatusSchema.optional(),
  supplier: supplierKeySchema.optional(),
  search: z.string().optional(),
});

export const merchantReviewParamsSchema = z.object({
  id: resourceIdSchema,
});

export const updateMerchantReviewBodySchema = z.object({
  status: z.enum(["MANUALLY_MATCHED", "REJECTED"]),
  merchantId: resourceIdSchema.optional(),
  notes: z.string().max(5000).optional().nullable(),
});
