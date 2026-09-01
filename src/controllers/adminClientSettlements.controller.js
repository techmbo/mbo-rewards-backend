import { toStandardPagedResponse } from "../core/pagination.js";
import { AdminClientSettlementsService } from "../modules/ops/adminClientSettlements.service.js";

const svc = new AdminClientSettlementsService();

function pageParams(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export async function adminListPayableOrdersHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await svc.listPayableOrders({
      clientId: req.query.clientId || req.query.client_id || null,
      settlementPeriod: req.query.settlementPeriod || req.query.settlement_period || null,
      q: req.query.q || req.query.search || null,
      skip,
      take,
    });

    res.json({
      ...toStandardPagedResponse({
        rows: result.items,
        total: result.total,
        page,
        pageSize,
        hasMore: skip + result.items.length < result.total,
      }),
      kpis: result.kpis,
    });
  } catch (error) {
    next(error);
  }
}

export async function adminListWithdrawalInvoiceRequestsHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await svc.listWithdrawalInvoiceRequests({
      clientId: req.query.clientId || req.query.client_id || null,
      requestStatus: req.query.requestStatus || req.query.request_status || null,
      q: req.query.q || req.query.search || null,
      skip,
      take,
    });

    res.json({
      ...toStandardPagedResponse({
        rows: result.items,
        total: result.total,
        page,
        pageSize,
        hasMore: skip + result.items.length < result.total,
      }),
      kpis: result.kpis,
    });
  } catch (error) {
    next(error);
  }
}

export async function adminListPayoutsHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await svc.listPayouts({
      clientId: req.query.clientId || req.query.client_id || null,
      payoutStatus: req.query.payoutStatus || req.query.payout_status || null,
      skip,
      take,
    });

    res.json({
      ...toStandardPagedResponse({
        rows: result.items,
        total: result.total,
        page,
        pageSize,
        hasMore: skip + result.items.length < result.total,
      }),
      kpis: result.kpis,
    });
  } catch (error) {
    next(error);
  }
}

