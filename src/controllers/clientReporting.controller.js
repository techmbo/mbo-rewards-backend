import { ok } from "../core/apiResponse.js";
import { ClientReportingService } from "../modules/client/services/clientReporting.service.js";
import { PartnerCampaignService } from "../modules/client/services/partnerCampaign.service.js";

const reporting = new ClientReportingService();
const partnerCampaigns = new PartnerCampaignService();

function requirePartnerClient(req, res) {
  const clientId = req.partnerClientId;
  if (!clientId) {
    res.status(401).json({ ok: false, message: "Client authentication required." });
    return null;
  }
  // Never trust query/body clientId for authorization — reject mismatches.
  const claimed =
    req.query?.clientId ||
    req.query?.client_id ||
    req.body?.clientId ||
    req.body?.client_id ||
    null;
  if (claimed != null && String(claimed) && String(claimed) !== String(clientId)) {
    res.status(403).json({ ok: false, message: "clientId does not match authenticated tenant." });
    return null;
  }
  return clientId;
}

export async function clientListOrdersHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await reporting.listOrders(clientId, req.query ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function clientListPaymentsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await reporting.listPaymentStatus(clientId, req.query ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

/** Thin alias → PartnerCampaignService (no duplicated logic). */
export async function clientListCampaignsAliasHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await partnerCampaigns.listCampaigns(clientId, req.query ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function clientGetCampaignAliasHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await partnerCampaigns.getCampaign(clientId, req.params.id);
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

/** Canonical client performance — ClientReportingService (DailyReport grain, client-safe DTO). */
export async function clientPerformanceAliasHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await reporting.listPerformance(clientId, req.query ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

/** v20 Client Confirmed Orders — individual confirmed conversions only. */
export async function clientListConfirmedOrdersHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await reporting.listConfirmedOrders(clientId, req.query ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

/** Client-safe account profile (Company / Commercials / API metadata — no secrets). */
export async function clientGetAccountHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const { PortalDashboardService } = await import(
      "../modules/client/services/portalDashboard.service.js"
    );
    const portal = new PortalDashboardService();
    const settings = await portal.getSettings(clientId);
    const me = await portal.getMe(clientId, req.user);
    res.json(
      ok({
        account: {
          client: me.client,
          organisation: settings.organisation,
          commercials: settings.commercials,
          billing: {
            billingMethod: settings.billing?.billingMethod,
            billingCurrency: settings.billing?.billingCurrency,
            taxCountry: settings.billing?.taxCountry,
          },
          api: {
            deliveryMethod: settings.api?.deliveryMethod,
            clientId: settings.api?.clientId,
            clientCode: settings.api?.clientCode,
            authentication: settings.api?.authentication,
            apiStatus: settings.api?.apiStatus,
            productionBaseUrl: settings.api?.productionBaseUrl,
            sandboxBaseUrl: settings.api?.sandboxBaseUrl,
          },
          bankStatus: me.bankStatus,
        },
      }),
    );
  } catch (error) {
    next(error);
  }
}

function splitPerformanceItems(payload, kind) {
  const items = payload?.items || payload?.rows || payload?.performance || [];
  const filtered = items.filter((row) => {
    const type = String(row.campaignType || row.channelType || "").toLowerCase();
    const hasCoupon = Boolean(row.couponCode);
    const hasLink = Boolean(row.mboTrackingLink || row.trackingLink);
    if (kind === "affiliate") return type.includes("affiliate") || type.includes("link") || (hasLink && !hasCoupon);
    if (kind === "coupon") return type.includes("coupon") || hasCoupon;
    return true;
  });
  return { ...payload, items: filtered, filter: kind };
}

export async function clientPerformanceSummaryHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await reporting.listPerformance(clientId, req.query ?? {});
    res.json(
      ok({
        kpis: payload?.kpis || {},
        currency: payload?.kpis?.currency || payload?.currency || null,
        period: { from: req.query?.from || null, to: req.query?.to || null },
      }),
    );
  } catch (error) {
    next(error);
  }
}

export async function clientPerformanceCampaignsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await reporting.listPerformance(clientId, req.query ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function clientPerformanceAffiliateLinksHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await reporting.listPerformance(clientId, req.query ?? {});
    res.json(ok(splitPerformanceItems(payload, "affiliate")));
  } catch (error) {
    next(error);
  }
}

export async function clientPerformanceCouponsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await reporting.listPerformance(clientId, req.query ?? {});
    res.json(ok(splitPerformanceItems(payload, "coupon")));
  } catch (error) {
    next(error);
  }
}

export async function clientPerformanceOrdersHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await reporting.listOrders(clientId, req.query ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function clientListStatementsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const { PortalDashboardService } = await import(
      "../modules/client/services/portalDashboard.service.js"
    );
    const portal = new PortalDashboardService();
    const payload = await portal.listPayableStatements(clientId, req.query ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function clientGetStatementHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const { PortalDashboardService } = await import(
      "../modules/client/services/portalDashboard.service.js"
    );
    const portal = new PortalDashboardService();
    const payload = await portal.getPayableStatementDetail(clientId, req.params.id);
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function clientListWithdrawalsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const { PortalDashboardService } = await import(
      "../modules/client/services/portalDashboard.service.js"
    );
    const portal = new PortalDashboardService();
    const payload = await portal.listWithdrawalRequests(clientId, req.query ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function clientCreateWithdrawalHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const { PortalDashboardService } = await import(
      "../modules/client/services/portalDashboard.service.js"
    );
    const portal = new PortalDashboardService();
    const payload = await portal.requestWithdrawal(clientId, {
      amount: req.body?.amount,
      requestedBy: req.user?.id || null,
    });
    res.status(201).json(ok(payload));
  } catch (error) {
    next(error);
  }
}

/** Payout / withdrawal history (client-safe). Distinct from /payments billing status. */
export async function clientListPayoutsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const { PortalDashboardService } = await import(
      "../modules/client/services/portalDashboard.service.js"
    );
    const portal = new PortalDashboardService();
    const summary = await portal.getPaymentsSummary(clientId);
    res.json(
      ok({
        currency: summary.currency,
        kpis: summary.kpis,
        payouts: summary.withdrawals || [],
        byBrand: summary.byBrand || [],
      }),
    );
  } catch (error) {
    next(error);
  }
}
