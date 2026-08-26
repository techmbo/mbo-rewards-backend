import { z } from "zod";

export const resourceIdSchema = z.string().min(1);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  cursor: z.string().optional(),
});

export const dateRangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const moneySchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine((value) => /^-?\d+(\.\d{1,4})?$/.test(value), "Invalid money format");

export const deviceTypeSchema = z.enum(["DESKTOP", "MOBILE", "TABLET", "APP", "OTHER", "UNKNOWN"]);
export const conversionStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "PAID", "UNKNOWN"]);
export const attributionStatusSchema = z.enum(["PENDING", "ATTRIBUTED", "ORPHAN", "REATTRIBUTED"]);
export const supplierKeySchema = z.enum([
  "OPTIMISE",
  "BOOSTINY",
  "TRACKIER",
  "UNKNOWN",
]);

export const clickListQuerySchema = paginationSchema.extend({
  trackingLinkId: resourceIdSchema.optional(),
  clientAssignmentId: resourceIdSchema.optional(),
  campaignSourceId: resourceIdSchema.optional(),
  subId: z.string().optional(),
  search: z.string().optional(),
  country: z.string().length(2).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const recordClickBodySchema = z.object({
  trackingLinkId: resourceIdSchema,
  subId: z.string().optional(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
  country: z.string().length(2).optional().nullable(),
  device: deviceTypeSchema.optional(),
  referrer: z.string().optional().nullable(),
  clickedAt: z.coerce.date().optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export const conversionListQuerySchema = paginationSchema.extend({
  trackingLinkId: resourceIdSchema.optional(),
  clientAssignmentId: resourceIdSchema.optional(),
  campaignSourceId: resourceIdSchema.optional(),
  status: conversionStatusSchema.optional(),
  attributionStatus: attributionStatusSchema.optional(),
  supplier: supplierKeySchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const ingestConversionBodySchema = z.object({
  supplier: supplierKeySchema,
  supplierConversionId: z.string().min(1),
  sourceAccountLabel: z.string().default("default"),
  clickId: resourceIdSchema.optional().nullable(),
  subId: z.string().optional().nullable(),
  trackingLinkId: resourceIdSchema.optional().nullable(),
  supplierCommission: moneySchema,
  approvedCommission: moneySchema.optional().nullable(),
  currency: z.string().length(3).optional().nullable(),
  status: conversionStatusSchema.optional(),
  conversionDate: z.coerce.date(),
  approvedDate: z.coerce.date().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export const reportListQuerySchema = paginationSchema.extend({
  clientId: resourceIdSchema.optional(),
  merchantId: resourceIdSchema.optional(),
  canonicalCampaignId: resourceIdSchema.optional(),
  campaignSourceId: resourceIdSchema.optional(),
  country: z.string().length(2).optional(),
  supplier: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** UI aliases used by Campaign Summary date inputs */
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  sortBy: z.enum(["reportDate", "clickCount", "conversionCount", "grossCommission"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

export const aggregationRunBodySchema = z.object({
  date: z.coerce.date().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  clientId: resourceIdSchema.optional(),
});

export const aggregationRebuildBodySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  clientId: resourceIdSchema.optional(),
  retryFailed: z.boolean().optional(),
});
