import { sendClientBoundaryJson } from "../modules/client/clientBoundaryResponse.js";
import { PortalDashboardService } from "../modules/client/services/portalDashboard.service.js";

const portal = new PortalDashboardService();

function requirePartnerClient(req, res) {
  const clientId = req.partnerClientId;
  if (!clientId) {
    res.status(401).json({ ok: false, message: "Client authentication required." });
    return null;
  }
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

export async function portalMeHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getMe(clientId, req.user);
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalOverviewHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getOverview(clientId);
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalPerformanceHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getPerformance(clientId, req.query ?? {});
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalPaymentsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getPaymentsSummary(clientId);
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalSaveBankHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.saveBankDetails(clientId, req.body ?? {});
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalWithdrawHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.requestWithdrawal(clientId, {
      amount: req.body?.amount,
      requestedBy: req.user?.id || null,
    });
    sendClientBoundaryJson(res, payload, { surface: "withdrawals", status: 201 });
  } catch (error) {
    next(error);
  }
}

export async function portalSettingsGetHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getSettings(clientId);
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalSettingsPatchHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.updateSettings(clientId, req.body ?? {});
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalTeamHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.listTeam(clientId);
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalSupportHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    sendClientBoundaryJson(res, payload, { surface: "support", status: 201 });
  } catch (error) {
    next(error);
  }
}

export async function portalApiDocsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getApiDocs(clientId);
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalListApiKeysHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    // Only full portal users (not bare API key auth) can fetch/reveal credentials.
    if (req.partnerAuth?.type === "api_key") {
      res.status(403).json({ ok: false, message: "Use the client portal login to view API credentials." });
      return;
    }
    const { ClientCredentialService } = await import(
      "../modules/client/services/clientCredential.service.js"
    );
    const credentialService = new ClientCredentialService();
    sendClientBoundaryJson(res, payload, { surface: "credentials_list" });
  } catch (error) {
    next(error);
  }
}

export async function portalListPayableStatementsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.listPayableStatements(clientId, req.query ?? {});
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalListWithdrawalRequestsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.listWithdrawalRequests(clientId, req.query ?? {});
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalGetPayableStatementHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getPayableStatementDetail(clientId, req.params.id);
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalGetWithdrawalRequestHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getWithdrawalRequestDetail(clientId, req.params.id);
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalNotificationsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.listNotifications(clientId);
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalDashboardSummaryHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getDashboardSummary(clientId);
    sendClientBoundaryJson(res, payload, { surface: "portal" });
  } catch (error) {
    next(error);
  }
}

export async function portalRotateApiKeyHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    if (req.partnerAuth?.type === "api_key") {
      res.status(403).json({ ok: false, message: "Use the client portal login to rotate API credentials." });
      return;
    }
    const { ClientCredentialService } = await import(
      "../modules/client/services/clientCredential.service.js"
    );
    const credentialService = new ClientCredentialService();
    const payload = await credentialService.rotatePortalApiCredential(clientId, {
      createdBy: req.user?.id || null,
      name: req.body?.name,
      environment: req.body?.environment,
    });
    sendClientBoundaryJson(res, payload, { surface: "credential_rotate", status: 201 });
  } catch (error) {
    next(error);
  }
}
