import axios from "axios";
import { fail } from "../../core/apiResponse.js";
import {
  getMarketplaceApiKey,
  getMarketplaceClientCredentials,
  getOAuthAccessToken,
} from "./oauth.service.js";

/**
 * Admitad client-credentials token provider.
 *
 * The Admitad portal issues a Client ID and a Client Secret, not an access token. The publisher
 * API wants a Bearer, so something has to exchange one for the other, and until now nothing did:
 * the adapter consumed a pre-minted ADMITAD_ACCESS_TOKEN and a live websites probe answered 401.
 *
 * The contract implemented here:
 *
 *   POST https://api.admitad.com/token/
 *   Authorization: Basic base64(clientId:clientSecret)
 *   Content-Type: application/x-www-form-urlencoded
 *   grant_type=client_credentials&client_id=<id>&scope=<scope>
 *
 * The Basic header is DERIVED from the id and secret on every request and never stored, never
 * configured, and never returned. A separate env var holding the same secret in a second encoding
 * would be a second thing to rotate and a second thing to leak.
 */

export const ADMITAD_TOKEN_URL_DEFAULT = "https://api.admitad.com/token/";

/**
 * Re-mint this long before the token actually dies. A token that expires in flight costs a whole
 * probe or sync run; re-minting a minute early costs one extra request a day.
 */
export const ADMITAD_TOKEN_EXPIRY_MARGIN_MS = Number(
  process.env.ADMITAD_TOKEN_EXPIRY_MARGIN_MS || 60000,
);

/** Assumed lifetime when the provider omits expires_in. Short, so an assumption cannot outlive a
 *  real token by much; Admitad documents a longer TTL than this. */
export const ADMITAD_TOKEN_FALLBACK_TTL_MS = 300000;

export const ADMITAD_TOKEN_REQUEST_TIMEOUT_MS = Number(
  process.env.ADMITAD_TOKEN_REQUEST_TIMEOUT_MS || 15000,
);

/**
 * One cached token, in memory only.
 *
 * Never persisted: a token in the database is a credential at rest that something must then
 * encrypt, rotate and expire. The cache dies with the process, which on a serverless runtime is
 * the right lifetime anyway.
 *
 * `configKey` exists so a changed client id, scope or token URL cannot be served a token minted
 * under the old configuration. It is never logged and never returned.
 */
let cache = null;

/** Test seam, and the honest way to prove expiry behaviour without waiting for it. */
export function resetAdmitadTokenCache() {
  cache = null;
}

export function readAdmitadOAuthConfig(env = process.env) {
  return {
    clientId: env.ADMITAD_CLIENT_ID || null,
    clientSecret: env.ADMITAD_CLIENT_SECRET || null,
    scope: env.ADMITAD_OAUTH_SCOPE || null,
    tokenUrl: env.ADMITAD_OAUTH_TOKEN_URL || ADMITAD_TOKEN_URL_DEFAULT,
  };
}

/** True when a client-credentials exchange is even possible. Scope is deliberately NOT part of
 *  this: a configured id and secret with no scope is a misconfiguration to report, not a reason to
 *  silently report "Admitad is not configured". */
export function hasAdmitadClientCredentials(config) {
  return Boolean(config?.clientId && config?.clientSecret);
}

/**
 * Derived per request, held only as a local, and returned to no one. Basic is what the documented
 * contract asks for; the id and secret never appear anywhere else in the request.
 */
function basicAuthorizationHeader(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

/**
 * An error safe to let travel.
 *
 * The token endpoint's own body is dropped: it is the one response in this integration guaranteed
 * to be about credentials. Only the HTTP status is carried forward, under `response.status`, so
 * statusCategory and supplierStatusCode keep classifying the failure exactly as they would any
 * other supplier rejection — and supplierMessage finds no body to read, which is the point.
 */
function tokenRequestFailure(error) {
  const status = Number(error?.response?.status ?? error?.status ?? 0);
  const safe = fail("Admitad token request failed.", 424);
  if (status) safe.response = { status };
  if (error?.code) safe.code = error.code;
  safe.admitadTokenRequestFailed = true;
  return safe;
}

function expiresInToMs(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/**
 * Exchanges the configured client credentials for an access token, or serves the cached one.
 *
 * Every configuration failure is raised BEFORE the request is built, so a misconfigured scope
 * costs no supplier call and cannot be mistaken for a supplier rejection.
 */
export async function acquireAdmitadClientCredentialsToken({
  env = process.env,
  transport = null,
  now = Date.now,
} = {}) {
  const config = readAdmitadOAuthConfig(env);

  if (!hasAdmitadClientCredentials(config)) {
    throw fail("Admitad client credentials are not configured.", 424);
  }
  // Required by the documented contract. Checked here, ahead of the request, so the failure names
  // the configuration rather than arriving as an opaque supplier rejection.
  if (!config.scope) {
    throw fail("ADMITAD_OAUTH_SCOPE is not configured; Admitad requires a scope.", 424);
  }

  const configKey = `${config.tokenUrl}|${config.clientId}|${config.scope}`;
  const currentTime = now();
  if (cache && cache.configKey === configKey && cache.expiresAt > currentTime) {
    return cache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    scope: config.scope,
  });

  const post = transport ?? axios.post;

  let response;
  try {
    response = await post(config.tokenUrl, body.toString(), {
      headers: {
        Authorization: basicAuthorizationHeader(config.clientId, config.clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      timeout: ADMITAD_TOKEN_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    throw tokenRequestFailure(error);
  }

  const data = response?.data;
  const accessToken = typeof data?.access_token === "string" ? data.access_token.trim() : "";
  if (!accessToken) {
    // The body is not quoted, not logged and not attached. A token endpoint's response is the one
    // payload in this integration that is definitionally credential material.
    throw fail("Admitad token response did not contain an access_token.", 424);
  }

  const ttlMs = expiresInToMs(data?.expires_in) ?? ADMITAD_TOKEN_FALLBACK_TTL_MS;
  // The margin can exceed a very short TTL; a non-positive lifetime would cache a token already
  // considered stale, so the entry is simply not cached in that case.
  const usableMs = ttlMs - ADMITAD_TOKEN_EXPIRY_MARGIN_MS;
  cache = usableMs > 0 ? { accessToken, expiresAt: currentTime + usableMs, configKey } : null;

  return accessToken;
}

/**
 * The one Admitad token resolution both the production sync job and certification use.
 *
 * Order:
 *   1. ADMITAD_ACCESS_TOKEN — an explicit manual override, kept for isolation probes. It WINS,
 *      which means leaving it set in an environment stops the client-credentials flow from ever
 *      running there.
 *   2. A stored access token on the connected MarketplaceAccount (an admin who pasted a token that
 *      Admitad already issued).
 *   3. Client credentials saved on the connected MarketplaceAccount (authType client_credentials:
 *      client id in accountExternalId, client secret encrypted, optional scope), exchanged here.
 *      Scope falls back to ADMITAD_OAUTH_SCOPE when the account did not save one.
 *   4. The client-credentials exchange from deployment env (ADMITAD_CLIENT_ID / _SECRET).
 *
 * Returns null only when nothing is configured at all. A configured-but-broken setup throws, so
 * "not configured" and "misconfigured" stay distinguishable to the caller.
 */
export async function resolveAdmitadAccessToken(accountLabel = "default", options = {}) {
  const env = options.env ?? process.env;
  const readStoredClientCredentials = options.readStoredClientCredentials ?? getMarketplaceClientCredentials;

  const override = env.ADMITAD_ACCESS_TOKEN || null;
  if (override) return override;

  const stored =
    (await getOAuthAccessToken("admitad", accountLabel).catch(() => null)) ||
    (await getMarketplaceApiKey("admitad", accountLabel).catch(() => null)) ||
    null;
  if (stored) return stored;

  const storedClient = await readStoredClientCredentials("admitad", accountLabel).catch(() => null);
  if (storedClient?.clientId && storedClient?.clientSecret) {
    return acquireAdmitadClientCredentialsToken({
      ...options,
      env: {
        ...env,
        ADMITAD_CLIENT_ID: storedClient.clientId,
        ADMITAD_CLIENT_SECRET: storedClient.clientSecret,
        ADMITAD_OAUTH_SCOPE: storedClient.scope || env.ADMITAD_OAUTH_SCOPE,
      },
    });
  }

  if (!hasAdmitadClientCredentials(readAdmitadOAuthConfig(env))) return null;

  return acquireAdmitadClientCredentialsToken({ ...options, env });
}
