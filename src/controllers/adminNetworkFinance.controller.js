import { toStandardPagedResponse } from "../core/pagination.js";
import { AdminNetworkFinanceService } from "../modules/ops/adminNetworkFinance.service.js";

const svc = new AdminNetworkFinanceService();

function pageParams(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export async function adminListNetworkBillingHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await svc.listNetworkBilling({
      network: req.query.network || null,
      paymentStatus: req.query.payment_status || req.query.paymentStatus || null,
      q: req.query.q || null,
      billingMonth: req.query.billing_month ?? req.query.billingMonth ?? null,
      billingYear: req.query.billing_year ?? req.query.billingYear ?? null,
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

export async function adminListNetworkPaymentsReceivedHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await svc.listNetworkPaymentsReceived({
      network: req.query.network || null,
      reconciliationStatus: req.query.reconciliation_status || req.query.reconciliationStatus || null,
      q: req.query.q || null,
      billingMonth: req.query.billing_month ?? req.query.billingMonth ?? null,
      billingYear: req.query.billing_year ?? req.query.billingYear ?? null,
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

export async function adminListMboReceiptsHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await svc.listMboReceipts({
      network: req.query.network || null,
      q: req.query.q || null,
      billingMonth: req.query.billing_month ?? req.query.billingMonth ?? null,
      billingYear: req.query.billing_year ?? req.query.billingYear ?? null,
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
      contract: result.contract,
    });
  } catch (error) {
    next(error);
  }
}

