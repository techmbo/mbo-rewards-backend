import { ok } from "../../core/apiResponse.js";
import { opsService } from "./ops.service.js";

export async function systemMetricsHandler(_req, res, next) {
  try {
    res.json(ok(await opsService.getSystemMetrics()));
  } catch (error) {
    next(error);
  }
}

export async function queueStatusHandler(_req, res, next) {
  try {
    res.json(ok(await opsService.getQueueStatus()));
  } catch (error) {
    next(error);
  }
}

export async function failedJobsHandler(req, res, next) {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const result = await opsService.getFailedJobs({ skip: (page - 1) * pageSize, take: pageSize });
    res.json(ok({ ...result, page, pageSize }));
  } catch (error) {
    next(error);
  }
}

export async function deadLetterHandler(req, res, next) {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Math.min(Number(req.query.pageSize) || 20, 100);
    const result = await opsService.getDeadLetterJobs({ skip: (page - 1) * pageSize, take: pageSize });
    res.json(ok({ ...result, page, pageSize }));
  } catch (error) {
    next(error);
  }
}

export async function aggregationStatusHandler(_req, res, next) {
  try {
    res.json(ok(await opsService.getAggregationStatus()));
  } catch (error) {
    next(error);
  }
}

export async function promotionStatusHandler(_req, res, next) {
  try {
    res.json(ok(await opsService.getPromotionStatus()));
  } catch (error) {
    next(error);
  }
}

export async function matchingQueueHandler(_req, res, next) {
  try {
    res.json(ok(await opsService.getMatchingQueue()));
  } catch (error) {
    next(error);
  }
}

export async function storageUsageHandler(_req, res, next) {
  try {
    res.json(ok(await opsService.getStorageUsage()));
  } catch (error) {
    next(error);
  }
}

export async function databaseStatsHandler(_req, res, next) {
  try {
    res.json(ok(await opsService.getDatabaseStatistics()));
  } catch (error) {
    next(error);
  }
}

export async function workerStatusHandler(_req, res, next) {
  try {
    res.json(ok(await opsService.getWorkerStatus()));
  } catch (error) {
    next(error);
  }
}

export async function dispatchOutboxHandler(req, res, next) {
  try {
    const take = Math.min(Number(req.body?.take) || 50, 200);
    res.json(ok(await opsService.dispatchOutbox({ take })));
  } catch (error) {
    next(error);
  }
}
