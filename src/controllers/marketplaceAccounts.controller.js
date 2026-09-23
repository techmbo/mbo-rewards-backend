import { prisma } from "../database/prisma.js";
import { encryptText } from "../core/crypto.js";
import {
  networkAccountStampData,
  normalizeEnvironment,
  toNetworkAccountDto,
} from "../modules/networkOps/networkAccount.contract.js";
import { CLIENT_CREDENTIALS_AUTH_TYPE } from "../modules/integrations/oauth.service.js";

/**
 * Network account connect / disconnect.
 *
 * Every network the platform syncs can be connected here. What each network needs, and which
 * MarketplaceAccount column it lands in, is fixed below and mirrors exactly what that network's
 * sync and certification resolvers read back:
 *
 *   boostiny     apiKey                                        -> primary secret
 *   optimise_*   apiKey + agencyId + contactId                 -> primary secret, agencyId, contactId
 *   trackier     apiKey (Trackier / vCommission)               -> primary secret
 *   partnerize   applicationKey + userApiKey [+ publisherId]   -> primary, second secret, accountExternalId
 *   impact       accountSid + authToken                        -> primary (SID), second secret (token)
 *   awin         apiKey (OAuth2 token) + publisherId           -> primary secret, accountExternalId
 *   admitad      clientId + clientSecret [+ scope]             -> accountExternalId, primary (client secret), scope
 *                or apiKey (an access token already issued)    -> primary secret
 *   cj           apiKey (personal access token) + companyId + websiteId
 *                                                              -> primary secret, accountExternalId, contactId
 *   rakuten      apiKey (access token) [+ securityToken] [+ publisherId]
 *                                                              -> primary, second secret, accountExternalId
 *
 * Secrets are encrypted at rest and never returned; the response carries masked values only.
 */
export const SUPPORTED_PLATFORMS = new Set([
  "boostiny",
  "optimise_sea",
  "optimise_mena",
  "optimise_uk",
  "trackier",
  "partnerize",
  "impact",
  "awin",
  "admitad",
  "cj",
  "rakuten",
]);

const MAX_ID_LENGTH = 120;
const MAX_SCOPE_LENGTH = 500;
const NUMERIC_ID = /^\d{1,20}$/;

function maskApiKey(apiKey) {
  const key = String(apiKey);
  if (key.length <= 8) return `${"*".repeat(Math.max(0, key.length - 2))}${key.slice(-2)}`;
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

function normalizeAccountLabel(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "default";
  return raw.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "default";
}

function text(body, key) {
  const value = body?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim() : "";
}

function checkId(value, label, { numeric = false } = {}) {
  if (value.length > MAX_ID_LENGTH) return `${label} is too long.`;
  if (numeric && !NUMERIC_ID.test(value)) return `${label} must be numeric.`;
  return null;
}

/** Splits "a:b" into two parts; used for the older single-field Partnerize / Impact form. */
function splitPair(value) {
  const idx = value.indexOf(":");
  return idx > 0 ? [value.slice(0, idx), value.slice(idx + 1)] : [null, null];
}

/**
 * Validates one connect request and returns what to store, or `{ error }`.
 * Pure: no I/O and no encryption — the caller encrypts `primarySecret` / `secondarySecret`.
 */
export function buildMarketplaceAccountData(platform, body = {}) {
  const apiKey = text(body, "apiKey");
  const base = {
    authType: "api_key",
    primarySecret: null,
    secondarySecret: null,
    accountExternalId: null,
    agencyId: null,
    contactId: null,
    scope: null,
    maskedKey: null,
  };

  switch (platform) {
    case "boostiny":
    case "trackier": {
      if (!apiKey) return { error: "Missing apiKey" };
      return { ...base, primarySecret: apiKey, maskedKey: maskApiKey(apiKey) };
    }

    case "optimise_sea":
    case "optimise_mena":
    case "optimise_uk": {
      const agencyId = text(body, "agencyId");
      const contactId = text(body, "contactId");
      if (!agencyId || !contactId) return { error: `Missing optimise agencyId/contactId for ${platform}` };
      if (!apiKey) return { error: "Missing apiKey" };
      const idError = checkId(agencyId, "Agency ID") || checkId(contactId, "Contact ID");
      if (idError) return { error: idError };
      return { ...base, primarySecret: apiKey, agencyId, contactId, maskedKey: maskApiKey(apiKey) };
    }

    case "partnerize": {
      let applicationKey = text(body, "applicationKey");
      let userApiKey = text(body, "userApiKey");
      if (!applicationKey || !userApiKey) {
        const [a, b] = splitPair(apiKey);
        applicationKey = applicationKey || a || "";
        userApiKey = userApiKey || b || "";
      }
      if (!applicationKey || !userApiKey) {
        return { error: "Partnerize requires both User Application Key (username) and User API Key (password)." };
      }
      const publisherId = text(body, "publisherId");
      const idError = publisherId ? checkId(publisherId, "Publisher ID") : null;
      if (idError) return { error: idError };
      return {
        ...base,
        primarySecret: applicationKey,
        secondarySecret: userApiKey,
        accountExternalId: publisherId || null,
        maskedKey: `${maskApiKey(applicationKey)} / ${maskApiKey(userApiKey)}`,
      };
    }

    case "impact": {
      let accountSid = text(body, "accountSid");
      let authToken = text(body, "authToken");
      if (!accountSid || !authToken) {
        const [a, b] = splitPair(apiKey);
        accountSid = accountSid || a || "";
        authToken = authToken || b || "";
      }
      if (!accountSid || !authToken) return { error: "Impact requires both Account SID and Auth Token." };
      const idError = checkId(accountSid, "Account SID");
      if (idError) return { error: idError };
      return {
        ...base,
        primarySecret: accountSid,
        secondarySecret: authToken,
        accountExternalId: accountSid,
        maskedKey: `${maskApiKey(accountSid)} / ${maskApiKey(authToken)}`,
      };
    }

    case "awin": {
      const publisherId = text(body, "publisherId");
      if (!apiKey) return { error: "Awin requires the API token (OAuth2 token)." };
      if (!publisherId) return { error: "Awin requires the Publisher ID." };
      const idError = checkId(publisherId, "Publisher ID", { numeric: true });
      if (idError) return { error: idError };
      return { ...base, primarySecret: apiKey, accountExternalId: publisherId, maskedKey: maskApiKey(apiKey) };
    }

    case "admitad": {
      const clientId = text(body, "clientId");
      const clientSecret = text(body, "clientSecret");
      const scope = text(body, "scope");
      if (clientId || clientSecret) {
        if (!clientId || !clientSecret) return { error: "Admitad requires both Client ID and Client Secret." };
        const idError = checkId(clientId, "Client ID");
        if (idError) return { error: idError };
        if (scope.length > MAX_SCOPE_LENGTH) return { error: "Scope is too long." };
        return {
          ...base,
          authType: CLIENT_CREDENTIALS_AUTH_TYPE,
          primarySecret: clientSecret,
          accountExternalId: clientId,
          scope: scope || null,
          maskedKey: maskApiKey(clientSecret),
        };
      }
      if (!apiKey) return { error: "Admitad requires Client ID and Client Secret (or an access token)." };
      return { ...base, primarySecret: apiKey, maskedKey: maskApiKey(apiKey) };
    }

    case "cj": {
      const companyId = text(body, "companyId");
      const websiteId = text(body, "websiteId");
      if (!apiKey) return { error: "CJ requires the Personal Access Token." };
      if (!companyId || !websiteId) return { error: "CJ requires the Company ID (CID) and Website ID (PID)." };
      const idError =
        checkId(companyId, "Company ID", { numeric: true }) || checkId(websiteId, "Website ID", { numeric: true });
      if (idError) return { error: idError };
      return {
        ...base,
        primarySecret: apiKey,
        accountExternalId: companyId,
        contactId: websiteId,
        maskedKey: maskApiKey(apiKey),
      };
    }

    case "rakuten": {
      const securityToken = text(body, "securityToken");
      const publisherId = text(body, "publisherId");
      if (!apiKey) return { error: "Rakuten requires the API access token." };
      const idError = publisherId ? checkId(publisherId, "Publisher ID (SID)") : null;
      if (idError) return { error: idError };
      return {
        ...base,
        primarySecret: apiKey,
        secondarySecret: securityToken || null,
        accountExternalId: publisherId || null,
        maskedKey: securityToken ? `${maskApiKey(apiKey)} / ${maskApiKey(securityToken)}` : maskApiKey(apiKey),
      };
    }

    default:
      return { error: `Unsupported platform: ${platform}` };
  }
}

export async function connectMarketplaceAccount(req, res, next) {
  try {
    const { platform } = req.params;
    if (!SUPPORTED_PLATFORMS.has(platform)) {
      return res.status(400).json({ ok: false, message: `Unsupported platform: ${platform}` });
    }

    const data = buildMarketplaceAccountData(platform, req.body ?? {});
    if (data.error) return res.status(400).json({ ok: false, message: data.error });

    const accountLabel = normalizeAccountLabel(req.body?.accountLabel);
    const environment = normalizeEnvironment(req.body?.environment);
    const stored = {
      accountLabel,
      authType: data.authType,
      encryptedAccessToken: encryptText(data.primarySecret),
      encryptedRefreshToken: data.secondarySecret ? encryptText(data.secondarySecret) : null,
      tokenExpiresAt: null,
      scope: data.scope,
      accountExternalId: data.accountExternalId,
      agencyId: data.agencyId,
      contactId: data.contactId,
      maskedApiKey: data.maskedKey,
      environment,
      connectedAt: new Date(),
    };

    const result = await prisma.marketplaceAccount.upsert({
      where: { platform_accountLabel: { platform, accountLabel } },
      update: stored,
      create: { platform, ...stored },
    });

    const stamped = await prisma.marketplaceAccount.update({
      where: { id: result.id },
      data: networkAccountStampData(result, { environment, tokenExpiresAt: null }),
    });

    const dto = toNetworkAccountDto(stamped);
    return res.json({
      ok: true,
      result: {
        ...dto,
        connected: true,
        authMethod: dto.authType,
        maskedKey: dto.maskedApiKey,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function disconnectMarketplaceAccount(req, res, next) {
  try {
    const { platform, accountLabel } = req.params;
    if (!SUPPORTED_PLATFORMS.has(platform)) {
      return res.status(400).json({ ok: false, message: `Unsupported platform: ${platform}` });
    }

    const normalizedLabel = normalizeAccountLabel(accountLabel);
    const deleted = await prisma.marketplaceAccount.deleteMany({
      where: { platform, accountLabel: normalizedLabel },
    });

    if (deleted.count === 0) {
      return res.status(404).json({ ok: false, message: "Account not connected" });
    }

    return res.json({
      ok: true,
      result: { platform, accountLabel: normalizedLabel, connected: false },
    });
  } catch (error) {
    next(error);
  }
}
