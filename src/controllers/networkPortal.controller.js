import { NetworkPortalService } from "../modules/networkPortal/networkPortal.service.js";
import { toStandardPagedResponse } from "../core/pagination.js";

/**
 * Network portal HTTP handlers mounted on canonical routes only
 * (/admin/coupons/pool, /ops/admin/campaigns/..., /ops/finance/reconcile/network, /ops/mapping-review/rules).
 * Duplicate /network-ops wrappers were removed in P1.13; orphan handlers cleaned in P1.15.
 */

const service = new NetworkPortalService();

function ok(res, data, meta = undefined) {
  return res.json({ ok: true, data, ...(meta ? { meta } : {}) });
}

function parsePaging(query) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

function paged(res, { items, total, page, pageSize, ...extras }) {
  return res.json({
    ...toStandardPagedResponse({
      rows: items || [],
      total: total ?? (items || []).length,
      page,
      pageSize,
      hasMore: page * pageSize < (total ?? 0),
    }),
    ...extras,
  });
}

export async function certifyMappingHandler(req, res, next) {
  try {
    const data = await service.certifyMapping(req.params.supplierCampaignId, {
      actorId: req.user?.id || req.user?.email || null,
      reason: req.body?.reason,
    });
    return ok(res, data);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, message: e.message, details: e.details });
    next(e);
  }
}

export async function revokeMappingHandler(req, res, next) {
  try {
    const data = await service.revokeMapping(req.params.supplierCampaignId, {
      actorId: req.user?.id || req.user?.email || null,
      reason: req.body?.reason,
    });
    return ok(res, data);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, message: e.message });
    next(e);
  }
}

export async function approveCatalogHandler(req, res, next) {
  try {
    const ids = Array.isArray(req.body?.supplierCampaignIds) ? req.body.supplierCampaignIds : [];
    const data = await service.approveToMasterCatalog(ids, {
      actorId: req.user?.id || req.user?.email || null,
    });
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function couponPoolHandler(req, res, next) {
  try {
    const { skip, take, page, pageSize } = parsePaging(req.query);
    const data = await service.listCouponPool({
      network: req.query.network || null,
      q: req.query.q || req.query.search || null,
      newCodeAlert: req.query.newCodeAlert ?? req.query.alert,
      status: req.query.status || null,
      source: req.query.source || null,
      scope: req.query.scope || null,
      campaign: req.query.campaign || null,
      validity: req.query.validity || null,
      skip,
      take,
    });
    return paged(res, {
      items: data.items,
      total: data.total,
      page,
      pageSize,
      kpis: data.kpis,
    });
  } catch (e) {
    next(e);
  }
}

export async function reviewCouponAlertHandler(req, res, next) {
  try {
    const data = await service.reviewCouponAlert(req.params.id, {
      actorId: req.user?.id || req.user?.email || null,
    });
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function patchCouponInventoryHandler(req, res, next) {
  try {
    const data = await service.setCouponInventory(req.params.id, req.body || {});
    return ok(res, data);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, message: e.message });
    next(e);
  }
}

export async function networkReconHandler(req, res, next) {
  try {
    const { skip, take, page, pageSize } = parsePaging(req.query);
    const billingMonth = req.query.billingMonth || null;
    const billingYear = req.query.billingYear || null;
    const network = req.query.network || null;

    let data = await service.listNetworkReconciliation({
      billingMonth,
      billingYear,
      network,
      skip,
      take,
    });

    // Auto-build from orders/facts when table is empty so Finance pages are usable without a manual rebuild.
    if ((data.total || 0) === 0) {
      try {
        await service.rebuildNetworkReconciliation({
          billingMonth: billingMonth || undefined,
          billingYear: billingYear || undefined,
        });
        data = await service.listNetworkReconciliation({
          billingMonth,
          billingYear,
          network,
          skip,
          take,
        });
      } catch {
        // Keep empty list if rebuild cannot run (e.g. DB flake); UI still renders.
      }
    }

    return paged(res, { items: data.items, total: data.total, page, pageSize });
  } catch (e) {
    next(e);
  }
}

export async function rebuildNetworkReconHandler(req, res, next) {
  try {
    const data = await service.rebuildNetworkReconciliation({
      billingMonth: req.body?.billingMonth || req.query.billingMonth,
      billingYear: req.body?.billingYear || req.query.billingYear,
    });
    return ok(res, data);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ ok: false, message: e.message });
    next(e);
  }
}

export async function mappingRulesHandler(req, res, next) {
  try {
    const data = await service.listMappingRules({ network: req.query.network || null });
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function supplierCommissionRulesHandler(req, res, next) {
  try {
    const { skip, take, page, pageSize } = parsePaging(req.query);
    const data = await service.listSupplierCommissionRules({
      network: req.query.network || req.query.supplier || null,
      q: req.query.q || req.query.search || null,
      skip,
      take,
    });
    return paged(res, { ...data, page, pageSize });
  } catch (e) {
    next(e);
  }
}

export async function createTestSupplierCommissionRuleHandler(req, res, next) {
  try {
    const data = await service.createTestSupplierCommissionRule(req.body || {});
    return ok(res, data);
  } catch (e) {
    next(e);
  }
}

export async function networkTrackingLinksHandler(req, res, next) {
  try {
    const { TrackingLinksOpsService } = await import("../modules/ops/trackingLinksOps.service.js");
    const { skip, take, page, pageSize } = parsePaging(req.query);
    const trackingOps = new TrackingLinksOpsService();
    const data = await trackingOps.listTrackingLinks(
      {
        network: req.query.network || req.query.supplier || null,
        q: req.query.q || req.query.search || null,
        linkStatus: req.query.linkStatus || null,
      },
      { skip, take },
    );
    return paged(res, {
      items: data.rows,
      total: data.total,
      page,
      pageSize,
      contract: data.contract,
    });
  } catch (e) {
    next(e);
  }
}
