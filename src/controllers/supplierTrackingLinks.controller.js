import { z } from "zod";
import { ok } from "../core/apiResponse.js";
import {
  SUPPLIER_TRACKING_LINK_STATES,
  SUPPLIER_TRACKING_LINK_STATE,
  SupplierTrackingLinkValidationError,
  SUPPLIER_TRACKING_HOST_ALLOWLIST,
} from "../modules/tracking/supplierTrackingLink.contract.js";
import {
  DEFAULT_WORK_QUEUE_PAGE_SIZE,
  MAX_WORK_QUEUE_PAGE_SIZE,
  OPERATOR_SETTABLE_STATES,
  supplierTrackingLinkService,
} from "../modules/tracking/supplierTrackingLink.service.js";

const SUPPORTED_SUPPLIERS = Object.keys(SUPPLIER_TRACKING_HOST_ALLOWLIST);

/**
 * Query-string booleans. Zod's built-in boolean coercion is NOT usable here: it applies JS
 * truthiness, so the string "false" arrives as true and the filter is silently ignored.
 * Caught against a live database, not in review.
 */
const booleanFlag = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
  .transform((value) =>
    typeof value === "boolean" ? value : ["true", "1", "yes"].includes(value),
  );


const workQueueQuerySchema = z.object({
  supplier: z.enum(SUPPORTED_SUPPLIERS).default("PARTNERIZE"),
  state: z.enum(SUPPLIER_TRACKING_LINK_STATES).default(SUPPLIER_TRACKING_LINK_STATE.NOT_GENERATED),
  joinedOnly: booleanFlag.default(true),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_WORK_QUEUE_PAGE_SIZE).default(DEFAULT_WORK_QUEUE_PAGE_SIZE),
});

const paramsSchema = z.object({ id: z.string().uuid() });

// Strict: the caller supplies the URL and an optional reason. Supplier, publisher id, campaign id
// overrides, destination URL and provenance are server-controlled and rejected if sent.
const setLinkBodySchema = z
  .object({
    supplierTrackingUrl: z.string().min(1).max(2048),
    reason: z.string().max(500).optional(),
  })
  .strict();

const setStateBodySchema = z
  .object({
    state: z.enum(OPERATOR_SETTABLE_STATES),
    reason: z.string().max(500).optional(),
  })
  .strict();

function actorFrom(req) {
  return req.user ? { id: req.user.id ?? null, email: req.user.email ?? null } : null;
}

function handle(error, res, next) {
  if (error instanceof SupplierTrackingLinkValidationError) {
    const status = error.code === "SUPPLIER_CAMPAIGN_NOT_FOUND" ? 404 : 400;
    res.status(status).json({
      ok: false,
      code: error.code,
      message: error.message,
      details: error.details ?? undefined,
    });
    return;
  }
  next(error);
}

export async function listSupplierTrackingLinkQueueHandler(req, res, next) {
  try {
    const query = workQueueQuerySchema.parse(req.query);
    const result = await supplierTrackingLinkService.listWorkQueue(query);
    res.json(ok(result.rows, { pagination: result.pagination }));
  } catch (error) {
    handle(error, res, next);
  }
}

export async function setSupplierTrackingLinkHandler(req, res, next) {
  try {
    const { id } = paramsSchema.parse(req.params);
    const body = setLinkBodySchema.parse(req.body ?? {});
    const record = await supplierTrackingLinkService.setSupplierTrackingLink({
      supplierCampaignId: id,
      supplierTrackingUrl: body.supplierTrackingUrl,
      reason: body.reason ?? null,
      actor: actorFrom(req),
    });
    res.json(ok(record));
  } catch (error) {
    handle(error, res, next);
  }
}

export async function setSupplierTrackingLinkStateHandler(req, res, next) {
  try {
    const { id } = paramsSchema.parse(req.params);
    const body = setStateBodySchema.parse(req.body ?? {});
    const record = await supplierTrackingLinkService.setSupplierTrackingLinkState({
      supplierCampaignId: id,
      state: body.state,
      reason: body.reason ?? null,
      actor: actorFrom(req),
    });
    res.json(ok(record));
  } catch (error) {
    handle(error, res, next);
  }
}
