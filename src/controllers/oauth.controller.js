import { FRONTEND_INTEGRATIONS_URL } from "../config/urls.js";
import {
  getOAuthConnectUrl,
  handleOAuthCallback,
  listMarketplaceConnections,
} from "../modules/integrations/oauth.service.js";
import { logger } from "../platform/logging/logger.js";
import { sanitizeSecretError } from "../modules/networkOps/networkAccount.contract.js";

export async function oauthConnect(req, res, next) {
  try {
    const { platform } = req.params;
    const { accountLabel } = req.query;
    const { url } = await getOAuthConnectUrl(platform, accountLabel ? String(accountLabel) : undefined, {
      userId: req.user?.id ?? null,
    });
    res.redirect(url);
  } catch (error) {
    next(error);
  }
}

export async function oauthCallback(req, res, next) {
  try {
    const { platform } = req.params;
    const { code, state } = req.query;
    const result = await handleOAuthCallback({
      code: String(code || ""),
      state: String(state || ""),
      platformFromPath: platform,
    });
    const redirect = new URL(FRONTEND_INTEGRATIONS_URL);
    redirect.searchParams.set("oauth", "success");
    redirect.searchParams.set("platform", result.platform);
    redirect.searchParams.set("accountLabel", result.accountLabel);
    res.redirect(redirect.toString());
  } catch (error) {
    // The message lands in a URL, so it outlives the response in history and Referer headers.
    // Sanitize it for the same reason the log line is sanitized.
    const safeMessage = sanitizeSecretError(error?.message) || "OAuth callback failed";
    const redirect = new URL(FRONTEND_INTEGRATIONS_URL);
    redirect.searchParams.set("oauth", "error");
    redirect.searchParams.set("message", safeMessage);
    res.redirect(redirect.toString());
    logger.error({ err: safeMessage }, "oauth callback failed");
  }
}

export async function getConnections(_req, res, next) {
  try {
    const result = await listMarketplaceConnections();
    res.json({ ok: true, result });
  } catch (error) {
    next(error);
  }
}
