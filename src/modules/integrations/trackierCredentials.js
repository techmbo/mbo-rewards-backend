import { getMarketplaceApiKey, getOAuthAccessToken } from "./oauth.service.js";

/**
 * Trackier credentials for certification.
 *
 * Deliberately the same resolution order the production sync job uses, down to the env var name
 * and the DB fallbacks. Certification proving a credential sync would not use — or failing on one
 * it would — would make the probe a test of this function rather than of the supplier.
 *
 * No new auth model is invented: Trackier is a single API key, sent as the X-Api-Key header
 * exactly as the adapter already presents it. vCommission aliases to Trackier, so there is one
 * credential and one resolution order for both names.
 */
export async function resolveTrackierCertificationCredentials(accountLabel = "default") {
  const apiKey =
    (await getMarketplaceApiKey("trackier", accountLabel).catch(() => null)) ||
    (await getOAuthAccessToken("trackier", accountLabel).catch(() => null)) ||
    process.env.VCOMMISSION_API_KEY ||
    null;

  if (!apiKey) return null;
  return { apiKey };
}
