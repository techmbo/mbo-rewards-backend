import { ok } from "../core/apiResponse.js";
import { toStandardPagedResponse } from "../core/pagination.js";
import { ExceptionCaseService } from "../modules/order/exceptionCase.service.js";
import { toExceptionDto } from "../modules/ops/alertException.contract.js";
import {
  MappingReviewOpsService,
  FinanceOpsService,
  ProductOpsService,
  DataQualityOpsService,
  SupplierHealthOpsService,
  SyncRunOpsService,
} from "../modules/ops/index.js";
import { REPROCESS_MODES } from "../modules/networkOps/reprocessing.contract.js";

const exceptions = new ExceptionCaseService();
const mappingOps = new MappingReviewOpsService();
const financeOps = new FinanceOpsService();
const productOps = new ProductOpsService();
const dataQuality = new DataQualityOpsService();
const supplierHealth = new SupplierHealthOpsService();
const syncRunOps = new SyncRunOpsService();

function pageParams(query) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 50));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export async function listExceptionsHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await exceptions.list(req.query, { skip, take });
    res.json(ok({ ...result, rows: result.rows.map(toExceptionDto), page, pageSize }));
  } catch (error) {
    next(error);
  }
}

export async function getExceptionHandler(req, res, next) {
  try {
    const record = await exceptions.getById(req.params.id);
    const retryPolicy = exceptions.getRetryPolicy(record.type);
    res.json(ok({ record: toExceptionDto(record), retryPolicy }));
  } catch (error) {
    next(error);
  }
}

export async function acknowledgeExceptionHandler(req, res, next) {
  try {
    const record = await exceptions.acknowledge(req.params.id, { actorId: req.user?.id });
    res.json(ok(record));
  } catch (error) {
    next(error);
  }
}

export async function assignExceptionHandler(req, res, next) {
  try {
    const record = await exceptions.assign(req.params.id, {
      assignedTo: req.body?.assignedTo,
      actorId: req.user?.id,
    });
    res.json(ok(record));
  } catch (error) {
    next(error);
  }
}

export async function resolveExceptionHandler(req, res, next) {
  try {
    const record = await exceptions.resolve(req.params.id, {
      reason: req.body?.reason,
      status: req.body?.status,
      actorId: req.user?.id,
    });
    res.json(ok(record));
  } catch (error) {
    next(error);
  }
}

export async function reopenExceptionHandler(req, res, next) {
  try {
    const record = await exceptions.reopen(req.params.id, {
      reason: req.body?.reason,
      actorId: req.user?.id,
    });
    res.json(ok(record));
  } catch (error) {
    next(error);
  }
}

export async function retryExceptionHandler(req, res, next) {
  try {
    const result = await mappingOps.retryException(req.params.id, { actorId: req.user?.id });
    res.json(ok(result));
  } catch (error) {
    next(error);
  }
}

export async function listMappingReviewHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await mappingOps.listMappingExceptions(req.query, { skip, take });
    res.json(ok({ ...result, page, pageSize }));
  } catch (error) {
    next(error);
  }
}

export async function listRawPayloadsHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await mappingOps.listRawPayloads(req.query, { skip, take });
    res.json(ok({ ...result, page, pageSize }));
  } catch (error) {
    next(error);
  }
}

export async function getRawPayloadHandler(req, res, next) {
  try {
    res.json(ok(await mappingOps.getRawPayload(req.params.id)));
  } catch (error) {
    next(error);
  }
}

export async function replayRawPayloadHandler(req, res, next) {
  try {
    const mode = String(req.body?.mode || REPROCESS_MODES.MAP_ONLY).toUpperCase();
    const result = await mappingOps.replay(req.params.id, {
      mappingVersion: req.body?.mappingVersion ?? null,
      mode,
      actorId: req.user?.id,
    });
    res.json(ok(result));
  } catch (error) {
    next(error);
  }
}

export async function reprocessHandler(req, res, next) {
  try {
    const result = await mappingOps.reprocessBatch(req.body || {}, { actorId: req.user?.id });
    res.json(ok(result));
  } catch (error) {
    next(error);
  }
}

export async function listSyncRunsHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await syncRunOps.list({ ...req.query, skip, take });
    res.json(ok({ ...result, page, pageSize }));
  } catch (error) {
    next(error);
  }
}

export async function getSyncRunHandler(req, res, next) {
  try {
    res.json(ok(await syncRunOps.getById(req.params.id)));
  } catch (error) {
    next(error);
  }
}

export async function financeDashboardHandler(req, res, next) {
  try {
    res.json(ok(await financeOps.getDashboard(req.query)));
  } catch (error) {
    next(error);
  }
}

export async function reconcileTransactionHandler(req, res, next) {
  try {
    res.json(ok(await financeOps.reconcileTransaction(req.params.id)));
  } catch (error) {
    next(error);
  }
}

export async function reconcileConversionHandler(req, res, next) {
  try {
    res.json(ok(await financeOps.reconcileConversion(req.params.conversionId)));
  } catch (error) {
    next(error);
  }
}

export async function reconcileClientHandler(req, res, next) {
  try {
    res.json(ok(await financeOps.reconcileClient(req.params.clientId, req.query)));
  } catch (error) {
    next(error);
  }
}

export async function reconcileSupplierHandler(req, res, next) {
  try {
    res.json(ok(await financeOps.reconcileSupplier(req.params.supplier, req.query)));
  } catch (error) {
    next(error);
  }
}

export async function portalCutoverReadinessHandler(req, res, next) {
  try {
    res.json(ok(await financeOps.getPortalCutoverReadiness(req.query)));
  } catch (error) {
    next(error);
  }
}

export async function dailyReportCutoverReadinessHandler(req, res, next) {
  try {
    res.json(ok(await financeOps.getDailyReportCutoverReadiness(req.query)));
  } catch (error) {
    next(error);
  }
}

export async function historicalFinanceCoverageHandler(req, res, next) {
  try {
    res.json(ok(await financeOps.getHistoricalFinanceCoverage(req.query)));
  } catch (error) {
    next(error);
  }
}

export async function syncProductFeedsHandler(req, res, next) {
  try {
    const { syncAllOptimiseProductFeeds } = await import("../jobs/optimiseProductFeedSync.js");
    const options = {
      maxFeeds: req.body?.maxFeeds || req.query.maxFeeds,
      maxRowsPerFeed: req.body?.maxRowsPerFeed || req.query.maxRowsPerFeed,
    };
    // Keep the HTTP response bounded — long feed downloads must not starve detail/list requests.
    const result = await Promise.race([
      syncAllOptimiseProductFeeds(options),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Product feed sync timed out after 90s — try fewer feeds")), 90_000);
      }),
    ]);
    res.json(ok(result));
  } catch (error) {
    next(error);
  }
}

export async function listProductsHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await productOps.listProducts(req.query, { skip, take });
    res.json({
      ...toStandardPagedResponse({
        rows: result.rows,
        total: result.total,
        page,
        pageSize,
        hasMore: skip + result.rows.length < result.total,
      }),
      contract: result.contract,
    });
  } catch (error) {
    next(error);
  }
}

export async function getProductHandler(req, res, next) {
  try {
    res.json(ok(await productOps.getProduct(req.params.id)));
  } catch (error) {
    next(error);
  }
}

export async function dataQualityHandler(req, res, next) {
  try {
    res.json(ok(await dataQuality.getSummary()));
  } catch (error) {
    next(error);
  }
}

export async function assignmentCoverageHandler(req, res, next) {
  try {
    res.json(ok(await dataQuality.getAssignmentCoverageDryRun()));
  } catch (error) {
    next(error);
  }
}

export async function supplierHealthHandler(req, res, next) {
  try {
    res.json(ok(await supplierHealth.getSupplierHealth()));
  } catch (error) {
    next(error);
  }
}

export async function jobHealthHandler(req, res, next) {
  try {
    res.json(ok(await supplierHealth.getJobHealth()));
  } catch (error) {
    next(error);
  }
}

export async function systemOpsHealthHandler(req, res, next) {
  try {
    res.json(ok(await supplierHealth.getSystemOpsHealth()));
  } catch (error) {
    next(error);
  }
}
