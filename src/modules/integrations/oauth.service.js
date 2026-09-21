import axios from "axios";
import crypto from "crypto";
import { oauthCallbackUrl } from "../../config/urls.js";
import { prisma } from "../../database/prisma.js";
import { decryptText, encryptText } from "../../core/crypto.js";
import {
  networkAccountStampData,
  toNetworkAccountDto,
} from "../networkOps/networkAccount.contract.js";

const PLATFORM_CONFIG = {
  boostiny: {
    displayName: "Boostiny",
    authUrl: process.env.BOOSTINY_OAUTH_AUTH_URL,
    tokenUrl: process.env.BOOSTINY_OAUTH_TOKEN_URL,
    clientId: process.env.BOOSTINY_OAUTH_CLIENT_ID,
    clientSecret: process.env.BOOSTINY_OAUTH_CLIENT_SECRET,
    scope: process.env.BOOSTINY_OAUTH_SCOPE || "",
  },
  optimise_sea: {
    displayName: "Optimise SEA",
    authUrl: process.env.OPTIMISE_SEA_OAUTH_AUTH_URL,
    tokenUrl: process.env.OPTIMISE_SEA_OAUTH_TOKEN_URL,
    clientId: process.env.OPTIMISE_SEA_OAUTH_CLIENT_ID,
    clientSecret: process.env.OPTIMISE_SEA_OAUTH_CLIENT_SECRET,
    scope: process.env.OPTIMISE_SEA_OAUTH_SCOPE || "",
  },
  optimise_mena: {
    displayName: "Optimise MENA",
    authUrl: process.env.OPTIMISE_MENA_OAUTH_AUTH_URL,
    tokenUrl: process.env.OPTIMISE_MENA_OAUTH_TOKEN_URL,
    clientId: process.env.OPTIMISE_MENA_OAUTH_CLIENT_ID,
    clientSecret: process.env.OPTIMISE_MENA_OAUTH_CLIENT_SECRET,
    scope: process.env.OPTIMISE_MENA_OAUTH_SCOPE || "",
  },
  optimise_uk: {
    displayName: "Optimise UK",
    authUrl: process.env.OPTIMISE_UK_OAUTH_AUTH_URL,
    tokenUrl: process.env.OPTIMISE_UK_OAUTH_TOKEN_URL,
    clientId: process.env.OPTIMISE_UK_OAUTH_CLIENT_ID,
    clientSecret: process.env.OPTIMISE_UK_OAUTH_CLIENT_SECRET,
    scope: process.env.OPTIMISE_UK_OAUTH_SCOPE || "",
  },
};

/** How long an issued `state` stays usable. Long enough for a human consent screen, no longer. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** The refusal for every state that cannot be proven to be one we issued and have not yet used. */
export const OAUTH_STATE_REFUSAL = "Invalid or expired OAuth state";

export function hashOAuthNonce(nonce) {
  return crypto.createHash("sha256").update(String(nonce)).digest("hex");
}

/**
 * The nonce inside an inbound `state`, or null.
 *
 * This is deliberately the ONLY thing read out of the inbound string. It is a lookup key, not a
 * claim: the platform and accountLabel that credentials get written under are read from the stored
 * row. Anything a caller puts in the other segments is ignored.
 */
export function extractStateNonce(state) {
  const parts = String(state || "").split(".");
  if (parts.length < 2) return null;
  const nonce = parts[parts.length - 1];
  return /^[0-9a-f]{32,128}$/.test(nonce) ? nonce : null;
}

function normalizeAccountLabel(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "default";
  return raw.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "default";
}

function assertPlatformConfig(platformKey) {
  const config = PLATFORM_CONFIG[platformKey];
  if (!config) throw new Error(`Unsupported platform: ${platformKey}`);
  if (!config.authUrl || !config.clientId) {
    throw new Error(`OAuth auth config missing for platform: ${platformKey}`);
  }
  return {
    ...config,
    redirectUri: oauthCallbackUrl(platformKey),
  };
}

export async function getOAuthConnectUrl(platformKey, requestedAccountLabel, { userId = null } = {}) {
  const config = assertPlatformConfig(platformKey);
  const accountLabel = normalizeAccountLabel(requestedAccountLabel);
  const nonce = crypto.randomBytes(32).toString("hex");

  // Persist BEFORE redirecting. A state that was never stored is not one we issued, and the
  // callback refuses it — so the store must be written while we still control the flow.
  await prisma.oAuthState.create({
    data: {
      nonceHash: hashOAuthNonce(nonce),
      platform: platformKey,
      accountLabel,
      initiatedByUserId: userId,
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    },
  });

  // The label is NOT carried in the state: it is read back from the row at callback time, so a
  // caller cannot retarget the write by editing this string.
  const state = `${platformKey}.${nonce}`;
  const url = new URL(config.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  if (config.scope) {
    url.searchParams.set("scope", config.scope);
  }
  return { url: url.toString(), state };
}

export async function handleOAuthCallback({ code, state, platformFromPath }) {
  if (!code) throw new Error("Missing OAuth code in callback");

  // The inbound string is trusted only to locate a row we issued.
  const nonce = extractStateNonce(state);
  if (!nonce) throw new Error(OAUTH_STATE_REFUSAL);

  const nonceHash = hashOAuthNonce(nonce);
  const issued = await prisma.oAuthState.findUnique({ where: { nonceHash } });

  // One refusal for never-issued, already-consumed and expired alike: a caller learns only that
  // the state is not usable, not which of the three it was.
  if (!issued) throw new Error(OAUTH_STATE_REFUSAL);
  if (issued.consumedAt) throw new Error(OAUTH_STATE_REFUSAL);
  if (issued.expiresAt.getTime() <= Date.now()) throw new Error(OAUTH_STATE_REFUSAL);

  // Authorization comes from the stored row, never from the inbound text.
  const platform = issued.platform;
  const accountLabel = issued.accountLabel;
  if (platformFromPath && platform !== platformFromPath) {
    throw new Error("OAuth state/platform mismatch");
  }
  const config = assertPlatformConfig(platform);
  if (!config.tokenUrl || !config.clientSecret) {
    throw new Error(`OAuth token config missing for platform: ${platform}`);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });

  const tokenResponse = await axios.post(config.tokenUrl, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30000,
  });

  const tokenData = tokenResponse.data || {};
  const accessToken = tokenData.access_token;
  if (!accessToken) {
    throw new Error("Provider did not return access_token");
  }
  const refreshToken = tokenData.refresh_token || null;
  const expiresIn = Number(tokenData.expires_in || 0);
  const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
  const accountExternalId =
    tokenData.account_id || tokenData.user_id || tokenData.merchant_id || tokenData.advertiser_id || null;

  // Consume the state and write the credentials in ONE transaction. The consume is a conditional
  // update, so two concurrent callbacks carrying the same state race on a single row: exactly one
  // sees count === 1 and proceeds, the other aborts before any credential is touched. The token
  // exchange above stays outside the transaction — a network call must not hold one open.
  const stamped = await prisma.$transaction(async (tx) => {
    const consumed = await tx.oAuthState.updateMany({
      where: { nonceHash, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw new Error(OAUTH_STATE_REFUSAL);

    const row = await tx.marketplaceAccount.upsert({
      where: { platform_accountLabel: { platform, accountLabel } },
      update: {
        accountLabel,
        authType: "oauth",
        accountExternalId,
        encryptedAccessToken: encryptText(accessToken),
        encryptedRefreshToken: refreshToken ? encryptText(refreshToken) : null,
        tokenExpiresAt,
        scope: tokenData.scope || config.scope || null,
        connectedAt: new Date(),
      },
      create: {
        platform,
        accountLabel,
        authType: "oauth",
        accountExternalId,
        encryptedAccessToken: encryptText(accessToken),
        encryptedRefreshToken: refreshToken ? encryptText(refreshToken) : null,
        tokenExpiresAt,
        scope: tokenData.scope || config.scope || null,
      },
    });

    return tx.marketplaceAccount.update({
      where: { id: row.id },
      data: networkAccountStampData(row, { tokenExpiresAt }),
    });
  });

  return {
    platform,
    accountLabel,
    accountExternalId,
    tokenExpiresAt,
    provider: config.displayName,
    environment: stamped.environment,
    credentialHealth: stamped.credentialHealth,
    secretRef: stamped.secretRef,
  };
}

export async function listMarketplaceConnections() {
  const rows = await prisma.marketplaceAccount.findMany({
    orderBy: [{ platform: "asc" }, { connectedAt: "desc" }],
  });

  return rows.reduce((acc, row) => {
    if (!acc[row.platform]) acc[row.platform] = [];
    const dto = toNetworkAccountDto(row);
    acc[row.platform].push({
      ...dto,
      connected: true,
      authMethod: dto.authType,
      maskedKey: dto.maskedApiKey,
    });
    return acc;
  }, {});
}

async function findMarketplaceAccount(platformKey, accountLabel = "default") {
  const normalizedAccountLabel = normalizeAccountLabel(accountLabel);
  const exact = await prisma.marketplaceAccount.findUnique({
    where: { platform_accountLabel: { platform: platformKey, accountLabel: normalizedAccountLabel } },
  });
  if (exact) return exact;

  // Only fall back when the default account was requested.
  if (normalizedAccountLabel === "default") {
    return prisma.marketplaceAccount.findFirst({
      where: { platform: platformKey },
      orderBy: { connectedAt: "desc" },
    });
  }

  return null;
}

export async function getMarketplaceExternalId(platformKey, accountLabel = "default") {
  const account = await findMarketplaceAccount(platformKey, accountLabel);
  return account?.accountExternalId || null;
}

export async function getMarketplaceApiKey(platformKey, accountLabel = "default") {
  const account = await findMarketplaceAccount(platformKey, accountLabel);
  if (!account?.encryptedAccessToken) return null;
  return decryptText(account.encryptedAccessToken);
}

/** Second secret for Basic-auth networks (Partnerize user API key, Impact auth token). */
export async function getMarketplaceRefreshToken(platformKey, accountLabel = "default") {
  const account = await findMarketplaceAccount(platformKey, accountLabel);
  if (!account?.encryptedRefreshToken) return null;
  return decryptText(account.encryptedRefreshToken);
}

export async function getOAuthAccessToken(platformKey, accountLabel = "default") {
  const account = await findMarketplaceAccount(platformKey, accountLabel);
  if (!account?.encryptedAccessToken || account.authType !== "oauth") return null;
  return decryptText(account.encryptedAccessToken);
}

export async function getNetworkAccountSyncFlags(platformKey, accountLabel = "default") {
  const account = await findMarketplaceAccount(platformKey, accountLabel);
  return {
    exists: Boolean(account),
    syncEnabled: account ? account.syncEnabled !== false : true,
    financeSyncEnabled: account ? account.financeSyncEnabled !== false : true,
    environment: account?.environment || "PRODUCTION",
  };
}

export async function listMarketplaceAccounts(platformKey, options = {}) {
  const purpose = options.purpose || "catalog";
  const where = { platform: platformKey };
  if (purpose === "finance") {
    where.financeSyncEnabled = true;
  } else if (purpose !== "all") {
    where.syncEnabled = true;
  }
  return prisma.marketplaceAccount.findMany({
    where,
    orderBy: [{ connectedAt: "desc" }],
  });
}
