import { ok, okPaged } from "../core/apiResponse.js";
import { ImportedRecordsService } from "../modules/ops/importedRecords.service.js";

const service = new ImportedRecordsService();

function readFilters(query = {}) {
  return {
    page: query.page,
    pageSize: query.pageSize || query.page_size,
    networkSource: query.network || query.networkSource,
    recordType: query.recordType || query.record_type || query.type || query.entityType,
    mappingStatus: query.mappingStatus || query.mapping_status,
    sourceStatus: query.sourceStatus || query.source_status,
    brand: query.brand,
    campaign: query.campaign,
    issue: query.issue,
    search: query.search || query.q,
    preset: query.preset,
    fromDate: query.fromDate || query.from_date,
    toDate: query.toDate || query.to_date,
    country: query.country,
    campaignStatus: query.campaignStatus || query.campaign_status,
    relationshipStatus: query.relationshipStatus || query.relationship_status,
    mboReady: query.mboReady || query.mbo_ready,
    campaignType: query.campaignType || query.campaign_type,
    category: query.category,
    currency: query.currency,
    isAssignable: query.isAssignable || query.is_assignable,
    groupBy: query.groupBy || query.group_by,
  };
}

export async function listImportedRecordsHandler(req, res, next) {
  try {
    const result = await service.list(readFilters(req.query));
    const totalPages = Math.max(1, Math.ceil(Number(result.total || 0) / Number(result.pageSize || 1)));
    res.json(
      okPaged({
        data: result.rows,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          totalPages,
          hasMore: result.hasMore,
        },
      }),
    );
  } catch (error) {
    next(error);
  }
}

export async function getImportedRecordHandler(req, res, next) {
  try {
    const detail = await service.getById(req.params.id);
    res.json(ok(detail));
  } catch (error) {
    next(error);
  }
}

export async function importedRecordsSummaryHandler(req, res, next) {
  try {
    const summary = await service.summary(readFilters(req.query));
    res.json(ok(summary));
  } catch (error) {
    next(error);
  }
}

export async function importedRecordsFacetsHandler(req, res, next) {
  try {
    const facets = await service.facets(readFilters(req.query));
    res.json(ok(facets));
  } catch (error) {
    next(error);
  }
}

export async function reprocessImportedRecordsHandler(req, res, next) {
  try {
    const body = req.body ?? {};
    const summary = await service.reprocess({
      entityIds: body.entityIds || body.entity_ids,
      networkSource: body.networkSource || body.network_source || body.network,
    });
    res.json(ok({ summary }));
  } catch (error) {
    next(error);
  }
}

export async function importedRecordsColumnsHandler(req, res, next) {
  try {
    const recordType =
      req.query.recordType || req.query.record_type || req.query.entityType || "campaign";
    res.json(ok(service.getColumnCatalog(recordType)));
  } catch (error) {
    next(error);
  }
}
