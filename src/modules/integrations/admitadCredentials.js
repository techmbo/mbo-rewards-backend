import { resolveAdmitadAccessToken } from "./admitadTokenProvider.js";

/**
 * Admitad credentials for certification.
 *
 * Deliberately thin: the whole resolution lives in resolveAdmitadAccessToken, which the production
 * sync job calls too. Certification proving a credential path sync would not use — or failing on
 * one it would — would make the probe a test of this function rather than of the supplier, and two
 * copies of a resolution order drift the moment one of them changes.
 *
 * One secret, so one outcome: the token, or null when nothing is configured. A configured-but-
 * broken setup throws instead, so "not configured" stays distinguishable from "misconfigured".
 */
export async function resolveAdmitadCertificationCredentials(accountLabel = "default") {
  const accessToken = await resolveAdmitadAccessToken(accountLabel);
  if (!accessToken) return null;
  return { accessToken };
}
