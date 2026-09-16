import { ok } from "../core/apiResponse.js";
import { measureAggregationDimensions } from "../modules/reporting/services/aggregationDimensionMeasurement.service.js";

/**
 * GET /sync/aggregation-measurement — TEMPORARY, Phase 6a-ter. Delete after the measurement.
 *
 * Takes nothing from the request: no query, no body, no params. The window is derived from the
 * clock server-side, the statement is read-only and the database enforces that, and the result is
 * fifteen rows of whitelisted integers. There is nothing here to sanitise; the guarantee lives in
 * the service, in one place.
 */
export async function aggregationMeasurementHandler(req, res, next) {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    const client = req?.app?.locals?.aggregationMeasurementClient ?? undefined;
    const result = await measureAggregationDimensions(client ? { client } : {});
    res.status(200).json(ok(result));
  } catch (error) {
    next(error);
  }
}
