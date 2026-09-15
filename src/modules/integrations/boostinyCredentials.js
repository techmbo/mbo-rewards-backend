import { getMarketplaceApiKey, getOAuthAccessToken } from "./oauth.service.js";

/**
 * Boostiny credentials for certification.
 *
 * Deliberately the same resolution order the production sync job uses, down to the env var name
 * and the DB fallbacks. Certification proving a credential sync would not use — or failing on one
 * it would — would make the probe a test of this function rather than of the supplier.
 *
 * No new auth model is invented: Boostiny is a single API key, sent as the Authorization header
 * exactly as the shared HTTP client already presents it. The base URL follows the same env
 * override the sync job applies, so certification reaches the host production reaches.
 */
export async function resolveBoostinyCertificationCredentials(accountLabel = "default") {
  const apiKey =
    (await getMarketplaceApiKey("boostiny", accountLabel).catch(() => null)) ||
    (await getOAuthAccessToken("boostiny", accountLabel).catch(() => null)) ||
    process.env.BOOSTINY_API_KEY ||
    null;

  if (!apiKey) return null;
  return { apiKey, baseURL: process.env.BOOSTINY_BASE_URL || undefined };
}
