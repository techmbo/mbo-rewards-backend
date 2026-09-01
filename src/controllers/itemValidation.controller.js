import { ok } from "../core/apiResponse.js";
import { ItemValidationService } from "../modules/order/itemValidation.service.js";

const itemValidation = new ItemValidationService();

const ALLOWED = new Set([
  "VALIDATION_APPROVED",
  "VALIDATION_REJECTED",
  "VALIDATION_PENDING",
  "VALIDATION_NEEDS_REVIEW",
]);

/**
 * Staff/ops — POST /ops/admin/order-items/:id/validation
 * Body: { status, reason? }
 * Permission: ops:manage (not CLIENT).
 */
export async function adminTransitionOrderItemValidationHandler(req, res, next) {
  try {
    const itemId = req.params.id;
    const status = String(req.body?.status || "").toUpperCase();
    if (!ALLOWED.has(status)) {
      return res.status(400).json({
        ok: false,
        message: "status must be VALIDATION_APPROVED|REJECTED|PENDING|NEEDS_REVIEW",
      });
    }
    // Never trust body clientId for auth — staff route uses JWT permissions only.
    if (req.body?.clientId || req.query?.clientId) {
      // Ignore spoofed clientId; do not use for authorization.
    }
    const result = await itemValidation.transitionItem(itemId, status, {
      reason: req.body?.reason || null,
      actorId: req.user?.id || null,
    });
    res.json(
      ok({
        orderItemId: result.item.id,
        orderId: result.order?.id ?? result.item.orderId,
        validationStatus: result.item.validationStatus,
        unchanged: Boolean(result.unchanged),
        financeSync: result.financeResult
          ? { orderId: result.financeResult.orderId, results: result.financeResult.results }
          : null,
      }),
    );
  } catch (error) {
    next(error);
  }
}
