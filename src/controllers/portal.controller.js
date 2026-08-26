import { ok } from "../core/apiResponse.js";
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
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalOverviewHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getOverview(clientId);
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalPerformanceHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getPerformance(clientId, req.query ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalPaymentsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getPaymentsSummary(clientId);
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalSaveBankHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.saveBankDetails(clientId, req.body ?? {});
    res.json(ok(payload));
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
    res.status(201).json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalSettingsGetHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getSettings(clientId);
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalSettingsPatchHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.updateSettings(clientId, req.body ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalTeamHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.listTeam(clientId);
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalSupportHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.createSupportRequest(clientId, {
      ...(req.body ?? {}),
      createdBy: req.user?.id || req.user?.email || null,
    });
    res.status(201).json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalApiDocsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getApiDocs(clientId);
    res.json(ok(payload));
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
    const payload = await credentialService.listPortalApiCredentials(clientId);
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalListPayableStatementsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.listPayableStatements(clientId, req.query ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalListWithdrawalRequestsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.listWithdrawalRequests(clientId, req.query ?? {});
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalGetPayableStatementHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getPayableStatementDetail(clientId, req.params.id);
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalGetWithdrawalRequestHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getWithdrawalRequestDetail(clientId, req.params.id);
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalNotificationsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.listNotifications(clientId);
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function portalDashboardSummaryHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await portal.getDashboardSummary(clientId);
    res.json(ok(payload));
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
    res.status(201).json(ok(payload));
  } catch (error) {
    next(error);
  }
}
