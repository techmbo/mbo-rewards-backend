import { prisma } from "../../database/prisma.js";
import { getMarketplaceApiKey, getOAuthAccessToken } from "./oauth.service.js";

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
      agencyId: true,
      contactId: true,
      authType: true,
      maskedApiKey: true,
    },
  });

  const regionEnvKey = {
    sea: process.env.OPTIMISE_API_KEY,
    mena: process.env.OPTIMISE_MENA_API_KEY,
    uk: process.env.OPTIMISE_UK_API_KEY,
  }[regionKey] || null;

  const apiKey = marketplaceAccount
    ? (await getMarketplaceApiKey(`optimise_${regionKey}`, normalizedLabel)) ||
      (await getOAuthAccessToken(`optimise_${regionKey}`, normalizedLabel)) ||
      regionEnvKey
    : regionEnvKey;

  const agencyId = marketplaceAccount?.agencyId
    ? String(marketplaceAccount.agencyId)
    : OPTIMISE_REGION_AGENCY_IDS[regionKey] || null;

  const contactIdEnvKey = {
    sea: process.env.OPTIMISE_SEA_CONTACT_ID,
    mena: process.env.OPTIMISE_MENA_CONTACT_ID,
    uk: process.env.OPTIMISE_UK_CONTACT_ID,
  }[regionKey] || null;
  const contactId = marketplaceAccount?.contactId
    ? String(marketplaceAccount.contactId)
    : contactIdEnvKey || null;

  const expectedAgencyId = OPTIMISE_REGION_AGENCY_IDS[regionKey];
  const agencyMismatch =
    expectedAgencyId && agencyId && String(agencyId) !== String(expectedAgencyId);

  const apiKeySource = marketplaceAccount
    ? `marketplace_account:${marketplaceAccount.authType}`
    : regionEnvKey
      ? `env:OPTIMISE_${regionKey.toUpperCase()}_API_KEY`
      : "missing";

  return {
    region: regionKey,
    accountLabel: normalizedLabel,
    apiKey,
    agencyId,
    contactId,
    baseURL: process.env.OPTIMISE_BASE_URL || "https://public.api.optimisemedia.com/v1",
    sources: {
      apiKey: apiKeySource,
      agencyId: agencyId ? "marketplace_account" : "missing",
      contactId: contactId ? "marketplace_account" : "missing",
    },
    expectedAgencyId,
    agencyMismatch,
    hasMarketplaceAccount: Boolean(marketplaceAccount) || Boolean(regionEnvKey),
  };
}
