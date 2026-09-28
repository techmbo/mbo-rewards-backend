/**
 * NetworkAccount contract — connected publisher/network accounts.
 * Networks provide source facts. MBO owns the canonical account record.
 * Never expose credentials, access tokens, refresh tokens, or API keys
 * in client APIs, HTML, logs, or exception payloads.
 */

import { iso } from "../ops/v15FieldContract.js";
import { describeSecretRef, isProviderSecretRef } from "../integrations/credentials/credentialResolver.js";

export const NETWORK_ACCOUNT_ENVIRONMENT = Object.freeze({
  PRODUCTION: "PRODUCTION",
  SANDBOX: "SANDBOX",
});

export const CREDENTIAL_HEALTH = Object.freeze({
  NOT_CONFIGURED: "NOT_CONFIGURED",
  UNKNOWN: "UNKNOWN",
  HEALTHY: "HEALTHY",
  EXPIRED: "EXPIRED",
  FAILED: "FAILED",
});

/**
 * Truthful account health from the source-object runs of one account sync.
 *   ok             — no source object failed
 *   ran            — how many source-object runs there were (0: nothing fetched, nothing proven)
 *   anySucceeded   — at least one live fetch worked, i.e. the credentials were accepted
 *   authFailed     — a run failed with HTTP 401/403
 *   failed         — [{ sourceObject, errorCode }] for the error summary (codes only, no messages)
 */
export function healthFromSourceRuns(runs = []) {
  const list = (Array.isArray(runs) ? runs : []).filter(Boolean);
  const status = (r) => String(r?.status || "").toUpperCase();
  const failedRuns = list.filter((r) => status(r) === "FAILED");
  const succeeded = list.filter((r) => ["SUCCESS", "SUCCEEDED", "PARTIAL"].includes(status(r)));
  const authFailed = failedRuns.some((r) => /^HTTP_40[13]$/.test(String(r?.errorCode || "")));
  return {
    ok: failedRuns.length === 0,
    ran: list.length,
    anySucceeded: succeeded.length > 0,
    authFailed,
    failed: failedRuns.map((r) => ({ sourceObject: r?.sourceObject ?? null, errorCode: r?.errorCode ?? null })),
  };
}

/** Account stamp fields for a sync whose source runs are summarised by healthFromSourceRuns. */
export function accountHealthStamp(health, now = new Date()) {
  // Nothing was fetched (every object switched off or skipped): nothing was proven either way.
  if (health && health.ok && health.ran === 0) return {};
  if (!health || health.ok) {
    return { credentialHealth: CREDENTIAL_HEALTH.HEALTHY, lastSyncError: null, lastFailureCode: null };
  }
  const summary = health.failed
    .map((f) => `${f.sourceObject || "unknown"}${f.errorCode ? ` (${f.errorCode})` : ""}`)
    .join(", ");
  return {
    lastSyncError: `${health.failed.length} source object(s) failed: ${summary}`.slice(0, 400),
    lastFailureAt: now,
    lastFailureCode: health.failed[0]?.errorCode || "SOURCE_OBJECT_SYNC_FAILED",
    // Credentials are HEALTHY only when a live fetch proved them; FAILED on 401/403; otherwise the
    // previous verdict stands rather than being overwritten either way.
    ...(health.authFailed
      ? { credentialHealth: CREDENTIAL_HEALTH.FAILED }
      : health.anySucceeded
        ? { credentialHealth: CREDENTIAL_HEALTH.HEALTHY }
        : {}),
  };
}

export const NETWORK_ACCOUNT_FORBIDDEN_KEYS = Object.freeze([
  "encryptedAccessToken",
  "encryptedRefreshToken",
  "apiKey",
  "apiSecret",
  "authToken",
  "accessToken",
  "refreshToken",
  "applicationKey",
  "userApiKey",
  "clientSecret",
  "password",
  "secret",
  "authorization",
  "config",
  "publisherProfile",
  "email",
  "phone",
]);

export function networkAccountSecretRef(accountId) {
  return `mbo-sm://local-encrypted/network-account/${accountId}`;
}

export function normalizeEnvironment(value) {
  return String(value || "").toUpperCase() === NETWORK_ACCOUNT_ENVIRONMENT.SANDBOX
    ? NETWORK_ACCOUNT_ENVIRONMENT.SANDBOX
    : NETWORK_ACCOUNT_ENVIRONMENT.PRODUCTION;
}

export function hasNetworkAccountSecret(account) {
  if (!account) return false;
  if (account.secretRef) return true;
  if (account.maskedApiKey) return true;
  if (account.encryptedAccessToken && String(account.encryptedAccessToken).length > 0) return true;
  return false;
}

export function deriveCredentialHealth(account, now = new Date()) {
  if (!hasNetworkAccountSecret(account)) return CREDENTIAL_HEALTH.NOT_CONFIGURED;
  if (account.tokenExpiresAt) {
    const exp = new Date(account.tokenExpiresAt);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= now.getTime()) {
      return CREDENTIAL_HEALTH.EXPIRED;
    }
  }
  if (String(account.lastSyncError || "").trim()) return CREDENTIAL_HEALTH.FAILED;
  if (account.lastSuccessfulSync || account.lastAuthCheckAt) return CREDENTIAL_HEALTH.HEALTHY;
  return CREDENTIAL_HEALTH.UNKNOWN;
}

/**
 * Strip credential-looking values from error text before persist, DTO, or logs.
 */
export function sanitizeSecretError(message) {
  if (message == null || message === "") return null;
  let text = String(message);
  text = text.replace(/Bearer\s+[A-Za-z0-9._\-+=/]+/gi, "Bearer [redacted]");
  text = text.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|application[_-]?key|user[_-]?api[_-]?key|client[_-]?secret|password|secret)\s*[:=]\s*\S+/gi,
    "$1=[redacted]",
  );
  text = text.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]");
  if (text.length > 400) text = `${text.slice(0, 400)}…`;
  return text;
}

export function assertNoSecrets(dto) {
  const blob = JSON.stringify(dto);
  for (const key of NETWORK_ACCOUNT_FORBIDDEN_KEYS) {
    if (new RegExp(`"${key}"\\s*:`).test(blob)) {
      throw new Error(`Network DTO must not expose ${key}`);
    }
  }
  return dto;
}

export function toNetworkAccountDto(account) {
  if (!account) return null;
  const health = deriveCredentialHealth(account);
  const dto = {
    id: account.id ?? null,
    network: account.platform ?? null,
    platform: account.platform ?? null,
    accountLabel: account.accountLabel ?? null,
    accountExternalId: account.accountExternalId ?? null,
    authType: account.authType ?? null,
    environment: normalizeEnvironment(account.environment),
    secretRef: account.secretRef ?? null,
    tokenExpiresAt: iso(account.tokenExpiresAt),
    syncEnabled: account.syncEnabled !== false,
    financeSyncEnabled: account.financeSyncEnabled !== false,
    credentialHealth: health,
    lastSuccessfulSync: iso(account.lastSuccessfulSync),
    lastCampaignSyncAt: iso(account.lastCampaignSyncAt),
    lastCouponSyncAt: iso(account.lastCouponSyncAt),
    lastOrderSyncAt: iso(account.lastOrderSyncAt),
    lastPaymentSyncAt: iso(account.lastPaymentSyncAt),
    syncFrequencyMinutes: account.syncFrequencyMinutes ?? null,
    lastAuthCheckAt: iso(account.lastAuthCheckAt),
    lastSyncError: sanitizeSecretError(account.lastSyncError),
    credentialsConfigured: hasNetworkAccountSecret(account),
    maskedApiKey: account.maskedApiKey ?? null,
    connectedAt: iso(account.connectedAt),
    updatedAt: iso(account.updatedAt),
  };
  return assertNoSecrets(dto);
}

/**
 * Network Connection DTO (control plane). Value-free by construction: it names the credential
 * PROVIDER and whether a reference is configured, never the reference's target, a variable name,
 * a masked key or any secret. Health is the stored verdict written by syncs and Test Connection.
 */
export function toNetworkConnectionDto(account) {
  if (!account) return null;
  const ref = describeSecretRef(account.secretRef);
  const dto = {
    id: account.id ?? null,
    platform: account.platform ?? null,
    accountLabel: account.accountLabel ?? null,
    environment: normalizeEnvironment(account.environment),
    credentialSource: account.credentialSource ?? "ENCRYPTED_DB",
    credentialProvider: ref.provider,
    credentialsConfigured: ref.configured || hasNetworkAccountSecret(account),
    credentialHealth: account.credentialHealth ?? CREDENTIAL_HEALTH.UNKNOWN,
    paused: Boolean(account.pausedAt),
    pausedAt: iso(account.pausedAt),
    pausedReason: account.pausedReason ?? null,
    switches: {
      syncEnabled: account.syncEnabled !== false,
      campaignSyncEnabled: account.campaignSyncEnabled !== false,
      couponSyncEnabled: account.couponSyncEnabled !== false,
      productSyncEnabled: account.productSyncEnabled !== false,
      conversionSyncEnabled: account.conversionSyncEnabled !== false,
      financeSyncEnabled: account.financeSyncEnabled !== false,
    },
    lastTest: {
      at: iso(account.lastTestAt),
      status: account.lastTestStatus ?? null,
      result: account.lastTestResult ?? null,
    },
    lastFailureAt: iso(account.lastFailureAt),
    lastFailureCode: account.lastFailureCode ?? null,
    lastSyncError: sanitizeSecretError(account.lastSyncError),
    lastSuccessfulSync: iso(account.lastSuccessfulSync),
    lastCampaignSyncAt: iso(account.lastCampaignSyncAt),
    lastCouponSyncAt: iso(account.lastCouponSyncAt),
    lastOrderSyncAt: iso(account.lastOrderSyncAt),
    lastPaymentSyncAt: iso(account.lastPaymentSyncAt),
    lastAuthCheckAt: iso(account.lastAuthCheckAt),
    connectedAt: iso(account.connectedAt),
    updatedAt: iso(account.updatedAt),
  };
  return assertNoSecrets(dto);
}

export function networkAccountStampData(row, extras = {}) {
  const now = extras.lastAuthCheckAt ?? new Date();
  // A credential-provider reference is the connection's identity for its secrets: a stamp never
  // replaces it with the encrypted-row placeholder.
  const secretRef = extras.secretRef ?? (isProviderSecretRef(row.secretRef) ? row.secretRef : networkAccountSecretRef(row.id));
  const lastSyncError =
    extras.lastSyncError === undefined ? null : sanitizeSecretError(extras.lastSyncError);
  const merged = {
    ...row,
    secretRef,
    lastAuthCheckAt: now,
    lastSyncError,
    tokenExpiresAt: extras.tokenExpiresAt !== undefined ? extras.tokenExpiresAt : row.tokenExpiresAt,
    lastSuccessfulSync: extras.lastSuccessfulSync !== undefined ? extras.lastSuccessfulSync : row.lastSuccessfulSync,
    environment: extras.environment ? normalizeEnvironment(extras.environment) : row.environment,
  };
  const data = {
    secretRef,
    lastAuthCheckAt: now,
    lastSyncError,
    credentialHealth: deriveCredentialHealth(merged, now),
  };
  if (extras.environment) data.environment = normalizeEnvironment(extras.environment);
  if (typeof extras.syncEnabled === "boolean") data.syncEnabled = extras.syncEnabled;
  if (typeof extras.financeSyncEnabled === "boolean") data.financeSyncEnabled = extras.financeSyncEnabled;
  return data;
}
