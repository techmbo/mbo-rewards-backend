import axios from "axios";
import crypto from "crypto";
import { oauthCallbackUrl } from "../../config/urls.js";
import { prisma } from "../../database/prisma.js";
import { decryptText, encryptText } from "../../core/crypto.js";

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

function parseState(state) {
  const parts = String(state || "").split(".");
  if (parts.length === 2) {
    const [platform, nonce] = parts;
    if (!platform || !nonce) return null;
    return { platform, accountLabel: "default", nonce };
  }
  const [platform, accountLabel, nonce] = parts;
  if (!platform || !nonce) return null;
  return { platform, accountLabel: accountLabel || "default", nonce };
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

export function getOAuthConnectUrl(platformKey, requestedAccountLabel) {
  const config = assertPlatformConfig(platformKey);
  const accountLabel = normalizeAccountLabel(requestedAccountLabel);
  const nonce = crypto.randomBytes(12).toString("hex");
  const state = `${platformKey}.${accountLabel}.${nonce}`;
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
  const parsed = parseState(state);
  if (!parsed) throw new Error("Invalid OAuth state");
  const { platform, accountLabel } = parsed;
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

  await prisma.marketplaceAccount.upsert({
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

  return {
    platform,
    accountLabel,
    accountExternalId,
    tokenExpiresAt,
    provider: config.displayName,
  };
}

export async function listMarketplaceConnections() {
  const rows = await prisma.marketplaceAccount.findMany({
    orderBy: [{ platform: "asc" }, { connectedAt: "desc" }],
  });

  return rows.reduce((acc, row) => {
    if (!acc[row.platform]) acc[row.platform] = [];
    acc[row.platform].push({
      accountLabel: row.accountLabel,
      connected: true,
      authMethod: row.authType,
      connectedAt: row.connectedAt,
      accountExternalId: row.accountExternalId,
      maskedKey: row.maskedApiKey || null,
      tokenExpiresAt: row.tokenExpiresAt,
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

export async function listMarketplaceAccounts(platformKey) {
  return prisma.marketplaceAccount.findMany({
    where: { platform: platformKey },
    orderBy: [{ connectedAt: "desc" }],
  });
}
