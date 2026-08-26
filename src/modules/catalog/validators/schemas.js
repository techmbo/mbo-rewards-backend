import { z } from "zod";
import { supplierKeySchema } from "../../supplier/validators/schemas.js";

export const resourceIdSchema = z.string().min(1);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  cursor: z.string().optional(),
});

export const canonicalCampaignStatusSchema = z.enum(["DRAFT", "PUBLISHED", "PAUSED", "ARCHIVED"]);
export const catalogVisibilitySchema = z.enum(["INTERNAL", "ASSIGNABLE", "HIDDEN"]);
export const campaignSourceStatusSchema = z.enum(["LINKED", "ACTIVE", "PREFERRED", "DEPRECATED"]);

export const catalogListQuerySchema = paginationSchema.extend({
  merchantId: resourceIdSchema.optional(),
  status: canonicalCampaignStatusSchema.optional(),
  visibility: catalogVisibilitySchema.optional(),
  category: z.string().optional(),
  country: z.string().length(2).optional(),
  supplier: supplierKeySchema.optional(),
  search: z.string().optional(),
  joined: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
  supportsCoupon: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
  supportsLink: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
});

export const catalogParamsSchema = z.object({
  id: resourceIdSchema,
});

export const createCatalogBodySchema = z.object({
  merchantId: resourceIdSchema,
  displayName: z.string().min(1).max(500),
  status: canonicalCampaignStatusSchema.optional(),
  visibility: catalogVisibilitySchema.optional(),
  category: z.string().max(200).optional().nullable(),
  countries: z.array(z.string().length(2)).optional(),
  defaultCurrency: z.string().length(3).optional().nullable(),
});

export const updateCatalogBodySchema = createCatalogBodySchema.omit({ merchantId: true }).partial();

export const attachSourceBodySchema = z.object({
  supplierCampaignId: resourceIdSchema,
  priority: z.coerce.number().int().min(1).max(1000).optional(),
  isPrimary: z.boolean().optional(),
});

export const campaignSourceParamsSchema = z.object({
  id: resourceIdSchema,
});

export const updateCampaignSourceBodySchema = z.object({
  priority: z.coerce.number().int().min(1).max(1000).optional(),
  isActive: z.boolean().optional(),
  status: campaignSourceStatusSchema.optional(),
  channelSupport: z.array(z.string().min(1).max(50)).optional(),
});
