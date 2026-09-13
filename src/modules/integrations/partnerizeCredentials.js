import {
  getMarketplaceApiKey,
  getMarketplaceExternalId,
  getMarketplaceRefreshToken,
  getOAuthAccessToken,
} from "./oauth.service.js";

/**
 * Partnerize credentials for certification.
 *
 * Deliberately the same resolution order the production sync job uses, including the combined
 * "application_key:user_api_key" form some accounts are stored under. Certification proving a
 * credential that sync would not use — or failing on one it would — would make the probe a test of
 * this function rather than of the supplier.
 *
 * The publisher id is resolved here from configuration, never discovered with a request and never
 * accepted from a caller: discovery would be a second supplier call, and a caller-supplied id
 * would let the probe be pointed at another publisher.
 */
export async function resolvePartnerizeCertificationCredentials(accountLabel = "default") {
  const appKey =
    process.env.PARTNERIZE_APPLICATION_KEY || (await getMarketplaceApiKey("partnerize", accountLabel)) || null;
  const userKey =
    process.env.PARTNERIZE_USER_API_KEY ||
    (await getMarketplaceRefreshToken("partnerize", accountLabel)) ||
    (await getOAuthAccessToken("partnerize", accountLabel)) ||
    null;

  const publisherId =
    process.env.PARTNERIZE_PUBLISHER_ID ||
    (await getMarketplaceExternalId("partnerize", accountLabel).catch(() => null)) ||
    null;

  // Some accounts store both halves in one field, separated by a colon.
  if (appKey && String(appKey).includes(":") && !userKey) {
    const index = String(appKey).indexOf(":");
    return {
      applicationKey: String(appKey).slice(0, index),
      userApiKey: String(appKey).slice(index + 1),
      publisherId,
    };
  }
  if (appKey && userKey) return { applicationKey: appKey, userApiKey: userKey, publisherId };
  return null;
}
