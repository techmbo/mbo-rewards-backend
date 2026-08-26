import { z } from "zod";

export const resourceIdSchema = z.string().min(1);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  cursor: z.string().optional(),
});

export const clientStatusSchema = z.enum(["PROSPECT", "ACTIVE", "SUSPENDED", "OFFBOARDED"]);
export const commercialModelSchema = z.enum(["OFFERS_ONLY", "OFFERS_PLUS_COMMISSION"]);
export const brandRequestStatusSchema = z.enum([
  "REQUESTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "FULFILLED",
]);
export const assignmentStatusSchema = z.enum(["ASSIGNED", "ACTIVE", "PAUSED", "REVOKED"]);
export const assignmentLifecycleSchema = z.enum(["draft", "published", "paused", "archived"]);

export const clientListQuerySchema = paginationSchema.extend({
  status: clientStatusSchema.optional(),
  country: z.string().length(2).optional(),
  industry: z.string().optional(),
  search: z.string().optional(),
});

export const clientParamsSchema = z.object({
  id: resourceIdSchema,
});

export const clientDeliveryMethodSchema = z.enum([
  "PORTAL_ONLY",
  "API_ONLY",
  "API_AND_PORTAL",
]);

export const clientAgreementStatusSchema = z.enum([
  "NONE",
  "DRAFT",
  "SENT",
  "PENDING",
  "SIGNED",
]);

export const clientPaymentCycleSchema = z.enum(["MONTHLY", "QUARTERLY"]);
export const clientPaymentTriggerSchema = z.enum([
  "AFTER_NETWORK_PAYMENT",
  "CONTRACT_SPECIFIC",
]);

const apiEnvBlockSchema = z
  .object({
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
    campaignEndpoint: z.boolean().optional(),
    productEndpoint: z.boolean().optional(),
    reportingEndpoint: z.boolean().optional(),
  })
  .optional();

export const apiEnvironmentConfigSchema = z
  .object({
    SANDBOX: apiEnvBlockSchema,
    PRODUCTION: apiEnvBlockSchema,
    sandbox: apiEnvBlockSchema,
    production: apiEnvBlockSchema,
  })
  .optional();

export const createClientBodySchema = z.object({
  name: z.string().min(1).max(500),
  slug: z.string().min(1).max(200).optional(),
  legalName: z.string().max(500).optional().nullable(),
  industry: z.string().max(200).optional().nullable(),
  category: z.string().max(200).optional().nullable(),
  subCategory: z.string().max(200).optional().nullable(),
  country: z.string().length(2).optional().nullable(),
  currency: z.string().length(3).optional().nullable(),
  timezone: z.string().max(100).optional().nullable(),
  logoUrl: z.string().url().optional().nullable(),
  status: clientStatusSchema.optional(),
  deliveryMethod: clientDeliveryMethodSchema.optional(),
  agreementStatus: clientAgreementStatusSchema.optional(),
  agreementEffectiveAt: z.coerce.date().optional().nullable(),
  agreementRenewalAt: z.coerce.date().optional().nullable(),
  agreementDocumentUrl: z
    .union([z.string().url(), z.literal(""), z.null()])
    .optional(),
  paymentCycle: clientPaymentCycleSchema.optional().nullable(),
  paymentTrigger: clientPaymentTriggerSchema.optional().nullable(),
  apiEnvironmentConfig: apiEnvironmentConfigSchema,
});

export const updateClientBodySchema = createClientBodySchema.omit({ slug: true }).partial();

export const brandRequestListQuerySchema = paginationSchema.extend({
  clientId: resourceIdSchema.optional(),
  merchantId: resourceIdSchema.optional(),
  status: brandRequestStatusSchema.optional(),
  search: z.string().optional(),
});

export const brandRequestParamsSchema = z.object({
  id: resourceIdSchema,
});

export const createBrandRequestBodySchema = z.object({
  clientId: resourceIdSchema,
  merchantId: resourceIdSchema.optional().nullable(),
  requestedBrandName: z.string().min(1).max(500),
  requestedBy: z.string().max(200).optional().nullable(),
  priority: z.coerce.number().int().min(1).max(1000).optional(),
  notes: z.string().max(5000).optional().nullable(),
});

export const updateBrandRequestBodySchema = z.object({
  status: brandRequestStatusSchema.optional(),
  notes: z.string().max(5000).optional().nullable(),
  priority: z.coerce.number().int().min(1).max(1000).optional(),
  fulfilledAssignmentId: resourceIdSchema.optional().nullable(),
});

export const assignmentListQuerySchema = paginationSchema.extend({
  clientId: resourceIdSchema.optional(),
  canonicalCampaignId: resourceIdSchema.optional(),
  status: assignmentStatusSchema.optional(),
  published: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
  visibleToClient: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
  search: z.string().trim().min(1).max(200).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  network: z.string().trim().min(1).max(80).optional(),
  networkSource: z.string().trim().min(1).max(80).optional(),
  commercialModel: z.string().trim().min(1).max(40).optional(),
  channel: z.enum(["LINK", "COUPON", "DEEPLINK", "COUPON_LINK", "LINK_AND_COUPON"]).optional(),
  trackingStatus: z.enum(["READY", "PENDING", "MISSING", "REVOKED"]).optional(),
  couponStatus: z.enum(["ASSIGNED", "PENDING", "NOT_AVAILABLE"]).optional(),
  /** Derived lifecycle filter (applied after projection on the page window). */
  lifecycle: z
    .enum([
      "ASSIGNED",
      "COMMISSION_READY",
      "TRACKING_READY",
      "PROVISIONED",
      "CLIENT_VISIBLE",
      "PAUSED",
      "REVOKED",
    ])
    .optional(),
  assignmentLifecycle: z
    .enum([
      "ASSIGNED",
      "COMMISSION_READY",
      "TRACKING_READY",
      "PROVISIONED",
      "CLIENT_VISIBLE",
      "PAUSED",
      "REVOKED",
    ])
    .optional(),
});

export const assignmentParamsSchema = z.object({
  id: resourceIdSchema,
});

export const clientFacingSnapshotSchema = z
  .object({
    campaignName: z.string().trim().max(500).optional().nullable(),
    campaignType: z.string().trim().max(120).optional().nullable(),
    customerOffer: z.string().trim().max(500).optional().nullable(),
    offerDescription: z.string().trim().max(5000).optional().nullable(),
    couponCode: z.string().trim().max(200).optional().nullable(),
    termsAndConditions: z.string().trim().max(20000).optional().nullable(),
    expiry: z.string().trim().max(40).optional().nullable(),
    countries: z.array(z.string().trim().max(80)).max(50).optional(),
    brandLogoUrl: z.string().trim().max(2000).optional().nullable(),
    clientCommissionPercent: z.coerce.number().min(0).max(100).optional().nullable(),
  })
  .strict()
  .optional()
  .nullable();

export const createAssignmentBodySchema = z
  .object({
    clientId: resourceIdSchema,
    canonicalCampaignId: resourceIdSchema.optional(),
    /** Wave B — preferred assignment SoT together with canonicalCampaignId. */
    campaignSourceId: resourceIdSchema.optional(),
    supplierCampaignId: resourceIdSchema.optional(),
    /**
     * LEGACY / READ-ONLY / MIGRATION CANDIDATE — Coupon CMS Entity id.
     * Still accepted for wizard compatibility; resolves via SupplierCoupon→CampaignSource when possible.
     */
    couponEntityId: resourceIdSchema.optional(),
    startDate: z.coerce.date().optional().nullable(),
    endDate: z.coerce.date().optional().nullable(),
    channel: z.string().max(100).optional().nullable(),
    notes: z.string().max(5000).optional().nullable(),
    clientFacing: clientFacingSnapshotSchema,
    /** When true, publish the grant immediately after draft create. */
    publish: z.boolean().optional(),
  })
  .refine(
    (value) =>
      Boolean(
        value.canonicalCampaignId ||
          value.campaignSourceId ||
          value.supplierCampaignId ||
          value.couponEntityId,
      ),
    {
      message:
        "Provide canonicalCampaignId, campaignSourceId, supplierCampaignId, or couponEntityId.",
    },
  );

export const createPortalUserBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters."),
  name: z.string().trim().min(1).max(120).optional(),
});

export const createApiCredentialBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  environment: z.enum(["SANDBOX", "PRODUCTION"]).optional().default("PRODUCTION"),
});

export const apiCredentialParamsSchema = z.object({
  id: resourceIdSchema,
  credentialId: resourceIdSchema,
});

export const updateAssignmentBodySchema = z.object({
  lifecycle: assignmentLifecycleSchema.optional(),
  status: assignmentStatusSchema.optional(),
  startDate: z.coerce.date().optional().nullable(),
  endDate: z.coerce.date().optional().nullable(),
  channel: z.string().max(100).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  campaignSourceId: resourceIdSchema.optional().nullable(),
  clientFacing: clientFacingSnapshotSchema,
});

export const setCommercialModelBodySchema = z
  .object({
    commercialModel: commercialModelSchema,
    clientSharePercent: z.coerce.number().min(0).max(100).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.commercialModel === "OFFERS_PLUS_COMMISSION" && value.clientSharePercent == null) {
      // Optional — service applies default 70 when omitted.
      return;
    }
    if (value.commercialModel === "OFFERS_ONLY" && value.clientSharePercent != null && value.clientSharePercent !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientSharePercent"],
        message: "Offers Only always uses 0% client share.",
      });
    }
  });

export const inviteAdminBodySchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(120).optional(),
});

export const allotCampaignsBodySchema = z
  .object({
    /**
     * LEGACY wizard path — Coupon CMS Entity ids.
     * Backend bridges to CanonicalCampaign + CampaignSource when supplier links exist.
     */
    couponEntityIds: z.array(resourceIdSchema).max(200).optional(),
    /** Wave B / Epic 7 canonical allotment — { canonicalCampaignId? , campaignSourceId?, couponEntityId? }. */
    assignments: z
      .array(
        z
          .object({
            canonicalCampaignId: resourceIdSchema.optional(),
            campaignSourceId: resourceIdSchema.optional(),
            supplierCampaignId: resourceIdSchema.optional(),
            /** Optional coupon Entity for ClientCouponAssignment / catalog ensure. */
            couponEntityId: resourceIdSchema.optional(),
          })
          .superRefine((item, ctx) => {
            if (
              !item.canonicalCampaignId &&
              !item.campaignSourceId &&
              !item.supplierCampaignId &&
              !item.couponEntityId
            ) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Each assignment needs canonicalCampaignId, campaignSourceId, supplierCampaignId, or couponEntityId.",
              });
            }
          }),
      )
      .max(200)
      .optional(),
  })
  .superRefine((value, ctx) => {
    const hasCoupons = Array.isArray(value.couponEntityIds) && value.couponEntityIds.length > 0;
    const hasAssignments = Array.isArray(value.assignments) && value.assignments.length > 0;
    if (!hasCoupons && !hasAssignments) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide couponEntityIds or assignments.",
      });
    }
  });

export const setPasswordBodySchema = z.object({
  token: z.string().min(16),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

/** Partner API — tenant resolved from credentials, never from clientId query. */
export const partnerCampaignListQuerySchema = paginationSchema.extend({
  search: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(200).optional(),
  brand: z.string().trim().min(1).max(200).optional(),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase())
    .optional(),
  status: z.enum(["ASSIGNED", "ACTIVE", "PAUSED"]).optional(),
  published: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
  includeInactive: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
});

export const partnerCampaignParamsSchema = z.object({
  id: resourceIdSchema,
});
