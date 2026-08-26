import { ok } from "../core/apiResponse.js";
import { BoostinyPartnerPaymentService } from "../modules/boostiny/partnerPayment.service.js";
import { BOOSTINY_PARTNER_PAYMENT_FIELDS } from "../modules/boostiny/partnerPayment.fields.js";

const service = new BoostinyPartnerPaymentService();

function sendError(res, error) {
  const status = error?.statusCode || 500;
  res.status(status).json({
    ok: false,
    message: error?.message || "Unexpected error",
    ...(error?.details ? { details: error.details } : {}),
  });
}

export async function boostinyListPaymentMappingsHandler(req, res) {
  try {
    const rows = await service.listMappings({
      sourceAccountLabel: req.query.sourceAccountLabel,
    });
    res.json(ok(rows, { requiredFields: [...BOOSTINY_PARTNER_PAYMENT_FIELDS] }));
  } catch (error) {
    sendError(res, error);
  }
}

export async function boostinyUpsertPaymentMappingHandler(req, res) {
  try {
    const row = await service.upsertMapping(req.body || {});
    res.status(201).json(ok(row));
  } catch (error) {
    sendError(res, error);
  }
}

export async function boostinyListPartnerSettlementsHandler(req, res) {
  try {
    const rows = await service.listSettlements({
      clientId: req.query.clientId,
      paymentSource: req.query.paymentSource,
      cycle: req.query.cycle,
      status: req.query.status,
      take: req.query.take,
    });
    res.json(ok(rows));
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * Body: { csvText: string, sourceAccountLabel?: string }
 * Never creates individual Order rows.
 */
export async function boostinyUploadPartnerPaymentHandler(req, res) {
  try {
    const csvText = req.body?.csvText ?? req.body?.csv ?? "";
    if (!String(csvText).trim()) {
      res.status(400).json({ ok: false, message: "csvText is required." });
      return;
    }
    const summary = await service.uploadCsv(csvText, {
      sourceAccountLabel: req.body?.sourceAccountLabel,
      actorId: req.user?.id,
    });
    res.status(201).json(ok(summary));
  } catch (error) {
    sendError(res, error);
  }
}
