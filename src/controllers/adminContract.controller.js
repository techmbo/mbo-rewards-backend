import { ok } from "../core/apiResponse.js";
import { toStandardPagedResponse } from "../core/pagination.js";
import { AdminContractService } from "../modules/ops/adminContract.service.js";
import { AdminClientReportingService } from "../modules/ops/adminClientReporting.service.js";

const admin = new AdminContractService();
const adminClientReporting = new AdminClientReportingService();

function pageParams(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export async function adminListCampaignsHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await admin.listCampaigns({
      q: req.query.q,
      status: req.query.status,
      catalogStatus: req.query.catalogStatus,
      campaignStatus: req.query.campaignStatus,
      networkSource: req.query.networkSource || req.query.network,
      relationshipStatus: req.query.relationshipStatus,
      campaignType: req.query.campaignType,
      country: req.query.country,
      isAssignable: req.query.isAssignable,
      linkSupport: req.query.linkSupport,
      couponSupport: req.query.couponSupport,
      deeplinkSupport: req.query.deeplinkSupport,
      mappingStatus: req.query.mappingStatus,
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
      contract: result.contract,
      unavailableFields: result.unavailableFields,
      openExceptionsPlatform: result.openExceptionsPlatform,
    });
  } catch (error) {
    next(error);
  }
}

export async function adminGetCampaignHandler(req, res, next) {
  try {
    res.json(ok(await admin.getCampaign(req.params.id)));
  } catch (error) {
    next(error);
  }
}

export async function adminListPerformanceHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await admin.listPerformance(
      {
        from: req.query.from,
        to: req.query.to,
        date: req.query.date,
        clientId: req.query.clientId,
        merchantId: req.query.merchantId,
        brand: req.query.brand,
        network: req.query.network || req.query.networkSource,
        campaignId: req.query.campaignId || req.query.canonicalCampaignId,
        country: req.query.country,
        currency: req.query.currency,
        campaignType: req.query.campaignType,
        status: req.query.status,
        q: req.query.q || req.query.search,
        grain: req.query.grain || null,
        skip,
        take,
      },
      req.permissions || [],
    );
    res.json({
      ...toStandardPagedResponse({
        rows: result.items,
        total: result.total,
        page,
        pageSize,
        hasMore: skip + result.items.length < result.total,
      }),
      includeFinancial: result.includeFinancial,
      contract: result.contract,
      unavailableFields: result.unavailableFields,
      grainNote: result.grainNote,
      migrationRequired: result.migrationRequired,
      kpis: result.kpis,
    });
  } catch (error) {
    next(error);
  }
}

export async function adminListOrdersHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await admin.listOrders(
      {
        clientId: req.query.clientId,
        network: req.query.network || req.query.networkSource || null,
        q: req.query.q || null,
        validationStatus: req.query.validationStatus || null,
        supplierPaymentStatus: req.query.supplierPaymentStatus || null,
        confirmedOnly: req.query.confirmed === "true" || req.query.confirmedOnly === "true",
        paidOnly: req.query.paid === "true" || req.query.paidOnly === "true",
        from: req.query.from || null,
        to: req.query.to || null,
        skip,
        take,
      },
      req.permissions || [],
    );
    res.json({
      ...toStandardPagedResponse({
        rows: result.items,
        total: result.total,
        page,
        pageSize,
        hasMore: skip + result.items.length < result.total,
      }),
      includeFinancial: result.includeFinancial,
      contract: result.contract,
    });
  } catch (error) {
    next(error);
  }
}

export async function adminListProductFeedsHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await admin.listProductFeeds({ skip, take });
    res.json({
      ...toStandardPagedResponse({
        rows: result.items,
        total: result.total,
        page,
        pageSize,
        hasMore: skip + result.items.length < result.total,
      }),
      contract: result.contract,
    });
  } catch (error) {
    next(error);
  }
}

export async function adminCommissionVocabularyHandler(req, res, next) {
  try {
    res.json(ok(admin.getCommissionRuleVocabulary()));
  } catch (error) {
    next(error);
  }
}

export async function adminListPaymentStatusHandler(req, res, next) {
  try {
    const { page, pageSize, skip, take } = pageParams(req.query);
    const result = await admin.listPaymentStatus({
      billingMonth: req.query.billing_month ?? req.query.billingMonth,
      billingYear: req.query.billing_year ?? req.query.billingYear,
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
      contract: result.contract,
      unavailableFields: result.unavailableFields,
      note: result.note,
      grainNote: result.grainNote,
    });
  } catch (error) {
    next(error);
  }
}

/** v20 Admin — Client Overview (one row per client, includes network/MBO commission). */
export async function adminListClientOverviewHandler(req, res, next) {
  try {
    const result = await adminClientReporting.listClientOverview(req.query ?? {}, req.permissions || []);
    const { page, pageSize } = pageParams(req.query);
    res.json({
      ...toStandardPagedResponse({
        rows: result.items,
        total: result.pagination?.total ?? result.items.length,
        page,
        pageSize,
        hasMore:
          (result.pagination?.page || 1) * (result.pagination?.pageSize || pageSize) <
          (result.pagination?.total || 0),
      }),
      items: result.items,
      kpis: result.kpis,
      contract: result.contract,
      grainNote: result.grainNote,
      dataAvailable: result.dataAvailable,
    });
  } catch (error) {
    next(error);
  }
}

/** v20 Admin — Client Performance (campaign grain for selected client). */
export async function adminListClientPerformanceHandler(req, res, next) {
  try {
    const result = await adminClientReporting.listClientPerformance(req.query ?? {});
    const { page, pageSize } = pageParams(req.query);
    const items = result.items || [];
    res.json({
      ...toStandardPagedResponse({
        rows: items,
        total: result.pagination?.total ?? items.length,
        page,
        pageSize,
        hasMore: false,
      }),
      ...result,
    });
  } catch (error) {
    next(error);
  }
}

/** v20 Admin — Client Confirmed Orders. */
export async function adminListClientConfirmedOrdersHandler(req, res, next) {
  try {
    const result = await adminClientReporting.listClientConfirmedOrders(req.query ?? {});
    const { page, pageSize } = pageParams(req.query);
    res.json({
      ...toStandardPagedResponse({
        rows: result.items,
        total: result.pagination?.total ?? result.items.length,
        page,
        pageSize,
        hasMore:
          (result.pagination?.page || 1) * (result.pagination?.pageSize || pageSize) <
          (result.pagination?.total || 0),
      }),
      items: result.items,
      clients: result.clients,
      kpis: result.kpis,
      contract: result.contract,
      grainNote: result.grainNote,
      dataAvailable: result.dataAvailable,
    });
  } catch (error) {
    next(error);
  }
}

/** v20 Admin — Reporting Overview (all-network summary). */
export async function adminReportingOverviewHandler(req, res, next) {
  try {
    const result = await adminClientReporting.getReportingOverview(req.query ?? {});
    res.json(ok(result));
  } catch (error) {
    next(error);
  }
}
