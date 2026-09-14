import { getMarketplaceApiKey, getOAuthAccessToken } from "./oauth.service.js";

/**
 * Admitad credentials for certification.
 *
 * Deliberately the same resolution order the production sync job uses (resolveAdmitadCredentials
 * in admitadSupplierSync.js), down to the env var name. Certification proving a credential sync
 * would not use — or failing on one it would — would make the probe a test of this function rather
 * than of the supplier.
 *
 * No new auth model is invented: Admitad is an OAuth2 access token presented as a Bearer, exactly
 * as createAdmitadAdapter already does. Whether that token arrives pre-minted in the environment
 * or is exchanged from client credentials is a question for the auth layer, not for this resolver
 * — it reads whatever production reads and hands back the token.
 *
 * One secret, so one outcome: the token or null. Returning null rather than a partial credential
 * keeps "not configured" something the caller reports without describing the credential itself.
 */
export async function resolveAdmitadCertificationCredentials(accountLabel = "default") {
  const accessToken =
    process.env.ADMITAD_ACCESS_TOKEN ||
    (await getOAuthAccessToken("admitad", accountLabel).catch(() => null)) ||
    (await getMarketplaceApiKey("admitad", accountLabel).catch(() => null)) ||
    null;

  if (!accessToken) return null;
  return { accessToken };
}
