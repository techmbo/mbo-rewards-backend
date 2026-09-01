import { getPagination, toPagedResponse } from "../core/pagination.js";
import { parseDateRangeQuery } from "../core/dateRange.js";
import { formatCouponsForDashboard } from "../modules/coupons/couponCms.service.js";
import { getEntitySummary } from "../modules/raw/entitySummary.js";
import { listEntities } from "../modules/raw/raw.service.js";
import {
  filterSummaryMetrics,
  sanitizeEntityRows,
} from "../auth/dataAccess.js";

function readEntityFilters(req) {
  const { fromDate, toDate } = parseDateRangeQuery({
    fromDate: req.query.from_date,
    toDate: req.query.to_date,
  });

  return {
    entityType: req.query.type ? String(req.query.type) : undefined,
    networkSource: req.query.network ? String(req.query.network) : undefined,
    accountLabel: req.query.account_label ? String(req.query.account_label) : undefined,
    fromDate,
    toDate,
    search: req.query.search ? String(req.query.search) : undefined,
    couponKind: req.query.coupon_kind ? String(req.query.coupon_kind) : undefined,
    brand: req.query.brand ? String(req.query.brand) : undefined,
  };
}

export async function getEntities(req, res, next) {
  try {
    const { page, pageSize } = getPagination(req.query);
    const filters = readEntityFilters(req);
    const { rows, total } = await listEntities({
      ...filters,
      page,
      pageSize,
    });

    const formattedRows = filters.entityType === "coupon" ? formatCouponsForDashboard(rows) : rows;
    const sanitizedRows = sanitizeEntityRows(formattedRows, req.permissions || []);
    res.json(toPagedResponse({ rows: sanitizedRows, total, page, pageSize }));
  } catch (error) {
    next(error);
  }
}

export async function getEntitySummaryHandler(req, res, next) {
  try {
    const filters = readEntityFilters(req);
    if (!filters.entityType) {
      res.status(400).json({ message: "Query parameter 'type' is required." });
      return;
    }

    const summary = await getEntitySummary(filters);
    const metrics = filterSummaryMetrics(summary.metrics, req.permissions || []);
    res.json({ ...summary, metrics });
  } catch (error) {
    next(error);
  }
}
