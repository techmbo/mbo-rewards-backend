import {
  getMarketplaceApiKey,
  getMarketplaceExternalId,
  getOAuthAccessToken,
} from "./oauth.service.js";
import { CREDENTIAL_SLOTS } from "./credentials/credentialCatalog.js";
import { legacyEnvCredential } from "./credentials/credentialResolver.js";

/**
 * Awin credentials for certification.
 *
 * Deliberately the same resolution order the production sync job uses (resolveAwinCredentials in
 * waveESupplierSync.js). Certification proving a credential sync would not use — or failing on one
 * it would — would make the probe a test of this function rather than of the supplier.
 *
 * The publisher id is resolved HERE, from configuration, and handed to the adapter at
 * construction. It is never discovered with a request (that would be a second supplier call) and
 * never accepted from a caller: the Awin token is user-level and may span several publisher
 * accounts, so a caller-supplied id would let the probe be pointed at another one.
 *
 * Both halves are required. Returning null rather than a partial credential keeps "not configured"
 * a single outcome the caller reports without ever describing the credential itself.
 */
export async function resolveAwinCertificationCredentials(accountLabel = "default") {
  const accessToken =
    (await legacyEnvCredential("awin", CREDENTIAL_SLOTS.PRIMARY_SECRET)) ||
    (await getOAuthAccessToken("awin", accountLabel).catch(() => null)) ||
    (await getMarketplaceApiKey("awin", accountLabel).catch(() => null)) ||
    null;

  const publisherId =
    (await legacyEnvCredential("awin", CREDENTIAL_SLOTS.ACCOUNT_EXTERNAL_ID)) ||
    (await getMarketplaceExternalId("awin", accountLabel).catch(() => null)) ||
    null;

  if (accessToken && publisherId) return { accessToken, publisherId };
  return null;
}
