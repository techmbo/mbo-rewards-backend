import { prisma } from "../../database/prisma.js";
import { getMarketplaceAccountIdentifiers, getMarketplaceApiKey, getOAuthAccessToken } from "./oauth.service.js";
import { CREDENTIAL_SLOTS } from "./credentials/credentialCatalog.js";
import { legacyEnvCredential } from "./credentials/credentialResolver.js";

/** Official Optimise agency IDs — docs.optimisemedia.com/docs/tools/apireference#agencyid */
export const OPTIMISE_REGION_AGENCY_IDS = {
  sea: "118",
  mena: "172",
  uk: "1",
};

function normalizeAccountLabel(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "default";
  return raw.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "").slice(0, 40) || "default";
}

export async function resolveOptimiseCredentials(region, accountLabel = "default") {
  const regionKey = String(region || "").toLowerCase();
  const normalizedLabel = normalizeAccountLabel(accountLabel);

  const marketplaceAccount = await prisma.marketplaceAccount.findUnique({
    where: {
      platform_accountLabel: {
        platform: `optimise_${regionKey}`,
        accountLabel: normalizedLabel,
      },
    },
    select: {
      id: true,
      agencyId: true,
      contactId: true,
      authType: true,
      maskedApiKey: true,
      syncEnabled: true,
      financeSyncEnabled: true,
      credentialSource: true,
      pausedAt: true,
    },
  });

  const platform = `optimise_${regionKey}`;
  // No connection record: the legacy fallback reads the catalogued names through the env provider.
  const legacyApiKey = await legacyEnvCredential(platform, CREDENTIAL_SLOTS.PRIMARY_SECRET);
  const connectionApiKey = marketplaceAccount
    ? (await getMarketplaceApiKey(platform, normalizedLabel)) ||
      (await getOAuthAccessToken(platform, normalizedLabel)) ||
      null
    : null;
  const apiKey = connectionApiKey || legacyApiKey;

  const agencyId = marketplaceAccount?.agencyId
    ? String(marketplaceAccount.agencyId)
    : OPTIMISE_REGION_AGENCY_IDS[regionKey] || null;

  const connectionContactId = marketplaceAccount
    ? (await getMarketplaceAccountIdentifiers(platform, normalizedLabel))?.contactId || null
    : null;
  const legacyContactId = await legacyEnvCredential(platform, CREDENTIAL_SLOTS.CONTACT_ID);
  const contactId = connectionContactId ? String(connectionContactId) : legacyContactId || null;

  const expectedAgencyId = OPTIMISE_REGION_AGENCY_IDS[regionKey];
  const agencyMismatch =
    expectedAgencyId && agencyId && String(agencyId) !== String(expectedAgencyId);

  // Where each value came from, without naming a variable or secret.
  const apiKeySource = connectionApiKey
    ? `network_connection:${marketplaceAccount.credentialSource || "ENCRYPTED_DB"}`
    : legacyApiKey
      ? "legacy_env_profile"
      : "missing";
  const contactIdSource = connectionContactId ? "network_connection" : legacyContactId ? "legacy_env_profile" : "missing";

  return {
    region: regionKey,
    accountLabel: normalizedLabel,
    apiKey,
    agencyId,
    contactId,
    baseURL: process.env.OPTIMISE_BASE_URL || "https://public.api.optimisemedia.com/v1",
    sources: {
      apiKey: apiKeySource,
      agencyId: marketplaceAccount?.agencyId ? "network_connection" : agencyId ? "catalog_default" : "missing",
      contactId: contactIdSource,
    },
    expectedAgencyId,
    agencyMismatch,
    hasMarketplaceAccount: Boolean(marketplaceAccount) || Boolean(legacyApiKey),
    networkAccountId: marketplaceAccount?.id ?? null,
    paused: Boolean(marketplaceAccount?.pausedAt),
    syncEnabled: marketplaceAccount ? marketplaceAccount.syncEnabled !== false && !marketplaceAccount.pausedAt : true,
    financeSyncEnabled: marketplaceAccount ? marketplaceAccount.financeSyncEnabled !== false : true,
  };
}
