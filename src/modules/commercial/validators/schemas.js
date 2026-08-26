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

/** Epic 6-A — explicit error code for blocked TIERED activation. */
export const TIERED_CLIENT_RULE_NOT_IMPLEMENTED = "TIERED_CLIENT_RULE_NOT_IMPLEMENTED";

export const TIERED_NOT_IMPLEMENTED_MESSAGE =
  "TIERED_CLIENT_RULE_NOT_IMPLEMENTED: Client TIERED band calculation is not implemented. Use PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION for supplier-tiered campaigns.";
export const couponTypeSchema = z.enum(["CODE", "LINK", "UNKNOWN"]);

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

export const trackingLinkDefaultsQuerySchema = z.object({
  assignmentId: resourceIdSchema,
});

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
  })
  .superRefine((data, ctx) => {
    const t = data.commissionType || "PERCENT";
    if (t === "TIERED" && data.activate === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "TIERED_CLIENT_RULE_NOT_IMPLEMENTED: Client TIERED rules cannot be activated. Use PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION for supplier-tiered campaigns.",
        path: ["activate"],
      });
    }
    // DRAFT TIERED may still store ratio placeholders for schema compatibility;
    // they never calculate as PERCENT and cannot become EFFECTIVE via activate.
    const needsRatio =
      t === "PERCENT" ||
      t === "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION" ||
      t === "DISPLAY_RANGE_WITH_ACTUAL_SPLIT" ||
      t === "UNKNOWN" ||
      t === "TIERED" ||
      (t === "FIXED" && (data.fixedAmount == null || data.fixedAmount === ""));

    if (needsRatio) {
      if (data.grossCommission == null || data.clientCommission == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "grossCommission and clientCommission are required for this rule type",
          path: ["grossCommission"],
        });
      }
    }
    if (t === "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE" && data.orderValuePercent == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "orderValuePercent is required",
        path: ["orderValuePercent"],
      });
    }
    if (
      (t === "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER" || t === "FIXED") &&
      data.fixedAmount != null &&
      data.fixedAmount !== "" &&
      Number(data.fixedAmount) < 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fixedAmount must be >= 0",
        path: ["fixedAmount"],
      });
    }
    if (t === "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER" && (data.fixedAmount == null || data.fixedAmount === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fixedAmount is required",
        path: ["fixedAmount"],
      });
    }
    if (t === "MANUAL_APPROVED_CLIENT_COMMISSION" && (data.manualAmount == null || data.manualAmount === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "manualAmount is required",
        path: ["manualAmount"],
      });
    }
  });

export const updateCommissionRuleBodySchema = z.object({
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
});
