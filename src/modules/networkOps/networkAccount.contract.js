/**
 * NetworkAccount contract — connected publisher/network accounts.
 * Networks provide source facts. MBO owns the canonical account record.
 * Never expose credentials, access tokens, refresh tokens, or API keys
 * in client APIs, HTML, logs, or exception payloads.
 */

import { iso } from "../ops/v15FieldContract.js";

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

export function networkAccountStampData(row, extras = {}) {
  const now = extras.lastAuthCheckAt ?? new Date();
  const secretRef = extras.secretRef ?? networkAccountSecretRef(row.id);
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
