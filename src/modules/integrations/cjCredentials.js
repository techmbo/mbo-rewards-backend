import { getMarketplaceApiKey, getOAuthAccessToken } from "./oauth.service.js";

/**
 * CJ credentials for certification.
 *
 * Deliberately the same resolution order the production sync job uses (resolveCjCredentials in
 * cjSupplierSync.js), down to the env var aliases. Certification proving a credential sync would
 * not use — or failing on one it would — would make the probe a test of this function rather than
 * of the supplier.
 *
 * No new auth model is invented: CJ is a Personal Access Token presented as a Bearer, exactly as
 * the adapter already does.
 *
 * requestorCid and websiteId are IDENTIFIERS rather than secrets, but they are resolved here all
 * the same, from configuration only. They are never discovered with a request and never accepted
 * from a caller — a caller-supplied publisher CID would let the probe be pointed at another
 * publisher's advertiser relationships.
 *
 * All three are required, as in production. Returning null rather than a partial credential keeps
 * "not configured" a single outcome the caller reports without describing the credential itself.
 */
export async function resolveCjCertificationCredentials(accountLabel = "default") {
  const accessToken =
    process.env.CJ_ACCESS_TOKEN ||
    (await getOAuthAccessToken("cj", accountLabel).catch(() => null)) ||
    (await getMarketplaceApiKey("cj", accountLabel).catch(() => null)) ||
    null;

  const requestorCid = process.env.CJ_PUBLISHER_CID || process.env.CJ_REQUESTOR_CID || null;
  const websiteId = process.env.CJ_WEBSITE_ID || process.env.CJ_PID || null;

  if (!accessToken || !requestorCid || !websiteId) return null;
  return { accessToken, requestorCid, websiteId };
}
