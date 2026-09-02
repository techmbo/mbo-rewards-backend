import { z } from "zod";

export const resourceIdSchema = z.string().min(1);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  cursor: z.string().optional(),
});

export const moneySchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine((value) => /^-?\d+(\.\d{1,4})?$/.test(value), "Invalid money format");

export const trackingLinkStatusSchema = z.enum(["GENERATED", "ACTIVE", "REVOKED"]);
export const trackingTypeSchema = z.enum(["STANDARD", "DEEPLINK", "HYBRID", "UNKNOWN"]);
export const couponAssignmentStatusSchema = z.enum(["ASSIGNED", "ACTIVE", "EXPIRED", "REVOKED"]);
export const commissionRuleStatusSchema = z.enum(["DRAFT", "EFFECTIVE", "SUPERSEDED"]);
export const commissionRuleTypeSchema = z.enum([
  "PERCENT",
  "FIXED",
  "TIERED",
  "UNKNOWN",
  "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
  "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE",
  "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER",
  "MANUAL_APPROVED_CLIENT_COMMISSION",
  "DISPLAY_RANGE_WITH_ACTUAL_SPLIT",
]);
export const couponTypeSchema = z.enum(["CODE", "LINK", "UNKNOWN"]);

export const clientCommercialConditionTypeSchema = z.enum([
  "DEFAULT",
  "COUNTRY",
  "REGION",
  "CATEGORY",
  "PRODUCT",
  "SKU",
  "CUSTOMER_TYPE",
  "COUPON",
  "ORDER_VALUE",
  "QUANTITY",
  "ACTION_TYPE",
  "CAMPAIGN",
  "DATE",
  "TRAFFIC_TYPE",
  "CUSTOM_FIELD",
]);

export const clientCommercialOperatorSchema = z.enum([
  "EQ",
  "IN",
  "NEQ",
  "NOT_IN",
  "CONTAINS",
  "STARTS_WITH",
  "GT",
  "GTE",
  "LT",
  "LTE",
  "BETWEEN",
  "EXISTS",
  "NOT_EXISTS",
]);

export const clientCommercialConditionSchema = z.object({
  conditionType: clientCommercialConditionTypeSchema,
  operator: clientCommercialOperatorSchema.optional().default("EQ"),
  value: z.any().optional().nullable(),
  field: z.string().trim().max(200).optional().nullable(),
  metadata: z.record(z.any()).optional().nullable(),
});

export const clientCommercialTierMetricSchema = z.enum([
  "ORDER_COUNT",
  "ORDER_VALUE",
  "SUPPLIER_COMMISSION",
  "CLIENT_REVENUE",
]);
export const clientCommercialTierPeriodSchema = z.enum([
  "TRANSACTION",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "LIFETIME",
]);
export const clientCommercialTierPayoutTypeSchema = z.enum([
  "PERCENT_OF_SUPPLIER_COMMISSION",
  "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
  "PERCENT_OF_ORDER_VALUE",
  "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE",
  "FIXED_AMOUNT",
  "FIXED",
  "FIXED_PER_ORDER",
]);

export const clientCommercialTierSchema = z
  .object({
    sequence: z.coerce.number().int().min(1).optional(),
    minInclusive: z.coerce.number().nonnegative(),
    maxExclusive: z.coerce.number().positive().optional().nullable(),
    payoutType: clientCommercialTierPayoutTypeSchema,
    sharePercent: z.coerce.number().nonnegative().optional().nullable(),
    orderValuePercent: z.coerce.number().nonnegative().optional().nullable(),
    fixedAmount: z.coerce.number().nonnegative().optional().nullable(),
    metadata: z.record(z.any()).optional().nullable(),
  })
  .superRefine((tier, ctx) => {
    if (tier.maxExclusive != null && tier.maxExclusive <= tier.minInclusive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "maxExclusive must be greater than minInclusive",
        path: ["maxExclusive"],
      });
    }
    if (
      ["PERCENT_OF_SUPPLIER_COMMISSION", "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION"].includes(tier.payoutType) &&
      tier.sharePercent == null
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sharePercent is required", path: ["sharePercent"] });
    }
    if (
      ["PERCENT_OF_ORDER_VALUE", "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE"].includes(tier.payoutType) &&
      tier.orderValuePercent == null &&
      tier.sharePercent == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "orderValuePercent is required",
        path: ["orderValuePercent"],
      });
    }
    if (["FIXED_AMOUNT", "FIXED", "FIXED_PER_ORDER"].includes(tier.payoutType) && tier.fixedAmount == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fixedAmount is required", path: ["fixedAmount"] });
    }
  });

export const trackingLinkListQuerySchema = paginationSchema.extend({
  assignmentId: resourceIdSchema.optional(),
  clientId: resourceIdSchema.optional(),
  canonicalCampaignId: resourceIdSchema.optional(),
  status: trackingLinkStatusSchema.optional(),
  search: z.string().trim().max(200).optional(),
  isPrimary: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
});

export const trackingLinkParamsSchema = z.object({ id: resourceIdSchema });

export const trackingLinkDefaultsQuerySchema = z.object({ assignmentId: resourceIdSchema });

export const createTrackingLinkBodySchema = z.object({
  assignmentId: resourceIdSchema,
  campaignSourceId: resourceIdSchema.optional().nullable(),
  supplierTrackingUrl: z.string().url().optional().nullable(),
  mboTrackingUrl: z.string().url().optional(),
  deeplinkTemplate: z.string().optional().nullable(),
  trackingType: trackingTypeSchema.optional(),
  isPrimary: z.boolean().optional(),
  expiresAt: z.coerce.date().optional().nullable(),
});

export const updateTrackingLinkBodySchema = z.object({
  status: trackingLinkStatusSchema.optional(),
  isPrimary: z.boolean().optional(),
  mboTrackingUrl: z.string().url().optional(),
  deeplinkTemplate: z.string().optional().nullable(),
  expiresAt: z.coerce.date().optional().nullable(),
  rotate: z.boolean().optional(),
  regenerateToken: z.boolean().optional(),
});

export const couponAssignmentListQuerySchema = paginationSchema.extend({
  assignmentId: resourceIdSchema.optional(),
  status: couponAssignmentStatusSchema.optional(),
  couponType: couponTypeSchema.optional(),
});

export const couponAssignmentParamsSchema = z.object({ id: resourceIdSchema });

export const createCouponAssignmentBodySchema = z
  .object({
    assignmentId: resourceIdSchema,
    supplierCouponId: resourceIdSchema.optional().nullable(),
    supplierCouponCode: z.string().optional().nullable(),
    clientCouponCode: z.string().optional().nullable(),
    couponType: couponTypeSchema.optional(),
    discountPercentage: z.string().optional().nullable(),
    validFrom: z.coerce.date().optional().nullable(),
    validUntil: z.coerce.date().optional().nullable(),
  })
  .superRefine((value, ctx) => {
    const type = value.couponType ?? "UNKNOWN";
    const code = String(value.clientCouponCode ?? "").trim();
    if (type === "CODE" && !code) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Code is required for CODE type.", path: ["clientCouponCode"] });
    }
    if (type === "LINK" && !code) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Link is required for LINK type.", path: ["clientCouponCode"] });
    }
    if (type === "LINK" && value.discountPercentage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Discount percentage applies only to CODE type.",
        path: ["discountPercentage"],
      });
    }
  });

export const updateCouponAssignmentBodySchema = z.object({
  status: couponAssignmentStatusSchema.optional(),
  clientCouponCode: z.string().optional().nullable(),
  validFrom: z.coerce.date().optional().nullable(),
  validUntil: z.coerce.date().optional().nullable(),
  activate: z.boolean().optional(),
  deactivate: z.boolean().optional(),
});

export const commissionRuleListQuerySchema = paginationSchema.extend({
  assignmentId: resourceIdSchema.optional(),
  status: commissionRuleStatusSchema.optional(),
});

export const commissionRuleParamsSchema = z.object({ id: resourceIdSchema });

const commercialLineageFields = {
  priority: z.coerce.number().int().optional().nullable(),
  priorityVerified: z.boolean().optional(),
  agreementRef: z.string().trim().max(500).optional().nullable(),
  agreementApprovedAt: z.coerce.date().optional().nullable(),
  agreementApprovedBy: z.string().trim().max(200).optional().nullable(),
  subsidyApproved: z.boolean().optional(),
  subsidyApprovalRef: z.string().trim().max(500).optional().nullable(),
  subsidyApprovedAt: z.coerce.date().optional().nullable(),
  subsidyApprovedBy: z.string().trim().max(200).optional().nullable(),
  tierMetric: clientCommercialTierMetricSchema.optional().nullable(),
  tierPeriod: clientCommercialTierPeriodSchema.optional().nullable(),
  metadata: z.record(z.any()).optional().nullable(),
  conditions: z.array(clientCommercialConditionSchema).max(100).optional(),
  tiers: z.array(clientCommercialTierSchema).max(100).optional(),
};

function refineCommercialRule(data, ctx) {
  const type = data.commissionType || "PERCENT";
  const needsRatio =
    type === "PERCENT" ||
    type === "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION" ||
    type === "DISPLAY_RANGE_WITH_ACTUAL_SPLIT" ||
    type === "UNKNOWN" ||
    (type === "FIXED" && (data.fixedAmount == null || data.fixedAmount === ""));

  if (needsRatio && (data.grossCommission == null || data.clientCommission == null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "grossCommission and clientCommission are required for this rule type",
      path: ["grossCommission"],
    });
  }
  if (type === "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE" && data.orderValuePercent == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "orderValuePercent is required", path: ["orderValuePercent"] });
  }
  if (type === "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER" && (data.fixedAmount == null || data.fixedAmount === "")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fixedAmount is required", path: ["fixedAmount"] });
  }
  if (type === "MANUAL_APPROVED_CLIENT_COMMISSION" && (data.manualAmount == null || data.manualAmount === "")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "manualAmount is required", path: ["manualAmount"] });
  }
  if (type === "TIERED") {
    if (!data.tierMetric) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "tierMetric is required for TIERED rules", path: ["tierMetric"] });
    }
    if (!data.tierPeriod) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "tierPeriod is required for TIERED rules", path: ["tierPeriod"] });
    }
    if (!Array.isArray(data.tiers) || data.tiers.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "At least one tier is required for TIERED rules", path: ["tiers"] });
    }
  }

  if (data.activate === true) {
    if (!data.agreementRef) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agreementRef is required to activate a commercial rule", path: ["agreementRef"] });
    }
    if (!data.agreementApprovedAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agreementApprovedAt is required to activate a commercial rule", path: ["agreementApprovedAt"] });
    }
    if (!data.agreementApprovedBy) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "agreementApprovedBy is required to activate a commercial rule", path: ["agreementApprovedBy"] });
    }
  }

  if (data.subsidyApproved === true) {
    if (!data.subsidyApprovalRef || !data.subsidyApprovedAt || !data.subsidyApprovedBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Approved subsidy requires subsidyApprovalRef, subsidyApprovedAt and subsidyApprovedBy",
        path: ["subsidyApproved"],
      });
    }
  }
}

export const createCommissionRuleBodySchema = z
  .object({
    assignmentId: resourceIdSchema,
    grossCommission: moneySchema.optional(),
    clientCommission: moneySchema.optional(),
    commissionType: commissionRuleTypeSchema.optional(),
    currency: z.string().length(3).optional().nullable(),
    orderValuePercent: z.coerce.number().nonnegative().optional().nullable(),
    fixedAmount: moneySchema.optional().nullable(),
    manualAmount: moneySchema.optional().nullable(),
    manualApproved: z.boolean().optional(),
    manualApprovedBy: z.string().max(200).optional().nullable(),
    displayRangeMin: moneySchema.optional().nullable(),
    displayRangeMax: moneySchema.optional().nullable(),
    displayLabel: z.string().max(200).optional().nullable(),
    effectiveFrom: z.coerce.date(),
    effectiveUntil: z.coerce.date().optional().nullable(),
    activate: z.boolean().optional(),
    ...commercialLineageFields,
  })
  .superRefine(refineCommercialRule);

export const updateCommissionRuleBodySchema = z
  .object({
    status: commissionRuleStatusSchema.optional(),
    effectiveUntil: z.coerce.date().optional().nullable(),
    activate: z.boolean().optional(),
    supersede: z.boolean().optional(),
    orderValuePercent: z.coerce.number().nonnegative().optional().nullable(),
    fixedAmount: moneySchema.optional().nullable(),
    manualAmount: moneySchema.optional().nullable(),
    manualApproved: z.boolean().optional(),
    manualApprovedBy: z.string().max(200).optional().nullable(),
    displayRangeMin: moneySchema.optional().nullable(),
    displayRangeMax: moneySchema.optional().nullable(),
    displayLabel: z.string().max(200).optional().nullable(),
    currency: z.string().length(3).optional().nullable(),
    ...commercialLineageFields,
  });
