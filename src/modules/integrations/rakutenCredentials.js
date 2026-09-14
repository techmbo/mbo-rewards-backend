import {
  getMarketplaceApiKey,
  getMarketplaceRefreshToken,
  getOAuthAccessToken,
} from "./oauth.service.js";

/**
 * Rakuten credentials for certification.
 *
 * Deliberately the same resolution order the production sync job uses (resolveRakutenCredentials
 * in rakutenSupplierSync.js), down to the env var names and the DB fallbacks. Certification
 * proving a credential sync would not use — or failing on one it would — would make the probe a
 * test of this function rather than of the supplier.
 *
 * No new auth model is invented: Rakuten is a Bearer access token, exactly as the adapter already
 * presents it.
 *
 * TWO CREDENTIALS, DIFFERENT JOBS. The access token is the Bearer every publisher API needs and is
 * required. The web security token is a QUERY PARAMETER on /advancedreports/1.0 alone and is never
 * Bearer auth; it is resolved here so the shape matches production, and it stays optional, exactly
 * as production treats it — the sync job runs with securityToken null and only the Advanced
 * Reports path refuses.
 *
 * The advertisers probe needs the Bearer alone, which is why it is the first object certified: it
 * separates "the Bearer works" from a credential it does not use.
 */
export async function resolveRakutenCertificationCredentials(accountLabel = "default") {
  const accessToken =
    process.env.RAKUTEN_ACCESS_TOKEN ||
    (await getOAuthAccessToken("rakuten", accountLabel).catch(() => null)) ||
    (await getMarketplaceApiKey("rakuten", accountLabel).catch(() => null)) ||
    null;

  const securityToken =
    process.env.RAKUTEN_WEB_SECURITY_TOKEN ||
    (await getMarketplaceRefreshToken("rakuten", accountLabel).catch(() => null)) ||
    null;

  if (!accessToken) return null;
  return { accessToken, securityToken };
}
