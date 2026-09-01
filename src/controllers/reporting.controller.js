import { ok } from "../core/apiResponse.js";
import { runTrackedJob } from "../platform/bootstrap.js";
import { AttributionService } from "../modules/reporting/services/attribution.service.js";
import { ReportingQueryService } from "../modules/reporting/services/query/reportingQuery.service.js";
import {
  aggregationRebuildBodySchema,
  aggregationRunBodySchema,
  clickListQuerySchema,
  conversionListQuerySchema,
  ingestConversionBodySchema,
  recordClickBodySchema,
  reportListQuerySchema,
} from "../modules/reporting/validators/schemas.js";
import { toClickDto } from "../modules/reporting/dto/reporting.dto.js";
import { applyConversionAccess } from "../auth/reportingDataAccess.js";

const attributionService = new AttributionService();
const reportingQuery = new ReportingQueryService();

export async function listClicksHandler(req, res, next) {
  try {
    const query = clickListQuerySchema.parse(req.query);
    const response = await reportingQuery.listClicks(query);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function recordClickHandler(req, res, next) {
  try {
    const body = recordClickBodySchema.parse(req.body ?? {});
    const record = await attributionService.recordClick(body);
    res.status(201).json(ok(toClickDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function listConversionsHandler(req, res, next) {
  try {
    const query = conversionListQuerySchema.parse(req.query);
    const response = await reportingQuery.listConversions(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function ingestConversionHandler(req, res, next) {
  try {
    const body = ingestConversionBodySchema.parse(req.body ?? {});
    const record = await attributionService.ingestConversion(body);
    res.status(201).json(ok(applyConversionAccess(record, req.permissions || [])));
  } catch (error) {
    next(error);
  }
}

export async function listDailyReportsHandler(req, res, next) {
  try {
    const query = reportListQuerySchema.parse(req.query);
    const response = await reportingQuery.listDailyReports(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function listClientReportsHandler(req, res, next) {
  try {
    const query = reportListQuerySchema.parse(req.query);
    const response = await reportingQuery.listClientReports(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function listMerchantReportsHandler(req, res, next) {
  try {
    const query = reportListQuerySchema.parse(req.query);
    const response = await reportingQuery.listMerchantReports(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function listCampaignReportsHandler(req, res, next) {
  try {
    const query = reportListQuerySchema.parse(req.query);
    const response = await reportingQuery.listCampaignReports(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function listSourceReportsHandler(req, res, next) {
  try {
    const query = reportListQuerySchema.parse(req.query);
    const response = await reportingQuery.listSourceReports(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function runAggregationHandler(req, res, next) {
  try {
    const body = aggregationRunBodySchema.parse(req.body ?? {});
    const job = await runTrackedJob("aggregation", body);
    res.json(ok(job.result ?? job));
  } catch (error) {
    next(error);
  }
}

export async function rebuildAggregationHandler(req, res, next) {
  try {
    const body = aggregationRebuildBodySchema.parse(req.body ?? {});
    const job = await runTrackedJob("aggregation", { ...body, rebuild: true });
    res.json(ok(job.result ?? job));
  } catch (error) {
    next(error);
  }
}
