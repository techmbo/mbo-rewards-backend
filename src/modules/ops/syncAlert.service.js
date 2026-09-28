/**
 * Pointer 21 — sync failure alert handlers (auth pause, rate limit).
 */
import { ExceptionCaseService } from "../order/exceptionCase.service.js";
import { updateAccountSyncTimestamps } from "../../jobs/syncTimestamps.js";
import { CREDENTIAL_HEALTH, sanitizeSecretError } from "../networkOps/networkAccount.contract.js";
import {
  ALERT_CONDITION,
  isAuthenticationSyncError,
  isRateLimitExhaustion,
} from "./alertException.contract.js";

/** pausedReason recorded when a 401/403 pauses a connection. */
export const AUTH_FAILURE_PAUSE_REASON = "AUTH_FAILED";

function authFailureCode(error) {
  const status = Number(error?.response?.status ?? error?.httpStatus);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP_${status}` : "AUTH_FAILED";
}

/**
 * Pause ONE connection by id after a source-object run failed authentication. Used by the
 * per-source-object runner, which knows the connection id but not a platform/label pair. Prior
 * data is never touched; only operational state changes. Returns true when a pause was applied.
 */
export async function pauseConnectionOnAuthFailure(
  { networkAccountId, network, error },
  deps = {},
) {
  if (!isAuthenticationSyncError(error)) return false;
  const db = deps.prisma;
  const exceptions = deps.exceptions ?? new ExceptionCaseService();
  const lastSyncError = sanitizeSecretError(error?.message || error) || "Authentication failed — connection paused";
  let paused = false;
  if (networkAccountId && db?.marketplaceAccount?.updateMany) {
    const now = new Date();
    const res = await db.marketplaceAccount.updateMany({
      where: { id: networkAccountId },
      data: {
        lastSyncError,
        credentialHealth: CREDENTIAL_HEALTH.FAILED,
        pausedAt: now,
        pausedReason: AUTH_FAILURE_PAUSE_REASON,
        lastFailureAt: now,
        lastFailureCode: authFailureCode(error),
      },
    });
    paused = (res?.count ?? 0) > 0;
  }
  await exceptions.report({
    condition: ALERT_CONDITION.AUTHENTICATION_FAILURE,
    supplier: platformToSupplier(network),
    entityId: networkAccountId,
    dedupeKey: `auth:${network}:${networkAccountId ?? "no-connection"}`,
    reason: lastSyncError,
    metadata: {
      network,
      networkAccountId,
      httpStatus: error?.response?.status ?? error?.httpStatus ?? null,
      connectionPaused: paused,
    },
  });
  return paused;
}

function platformToSupplier(platform) {
  return String(platform || "UNKNOWN").toUpperCase().replace(/-/g, "_");
}

export async function handleSyncAuthFailure(
  { platform, accountLabel, error, networkAccountId = null },
  deps = {},
) {
  if (!isAuthenticationSyncError(error)) return false;

  const exceptions = deps.exceptions ?? new ExceptionCaseService();
  const updateTimestamps = deps.updateTimestamps ?? updateAccountSyncTimestamps;
  const lastSyncError =
    sanitizeSecretError(error?.message || error) || "Authentication failed — sync paused";

  // A real pause: the connection's own switches (syncEnabled, per-object toggles) are left as the
  // admin set them, so resuming restores exactly the previous configuration.
  const now = new Date();
  await updateTimestamps(platform, accountLabel, {
    lastSyncError,
    credentialHealth: CREDENTIAL_HEALTH.FAILED,
    pausedAt: now,
    pausedReason: AUTH_FAILURE_PAUSE_REASON,
    lastFailureAt: now,
    lastFailureCode: authFailureCode(error),
  });

  await exceptions.report({
    condition: ALERT_CONDITION.AUTHENTICATION_FAILURE,
    supplier: platformToSupplier(platform),
    entityId: networkAccountId,
    dedupeKey: `auth:${platform}:${accountLabel}`,
    reason: lastSyncError,
    metadata: {
      platform,
      accountLabel,
      networkAccountId,
      httpStatus: error?.response?.status ?? null,
    },
  });

  return true;
}

export async function reportRateLimitExhaustion(
  {
    network,
    networkAccountId = null,
    syncRunId = null,
    error = null,
    checkpointBefore = null,
    endpoint = null,
  },
  deps = {},
) {
  if (!isRateLimitExhaustion(error)) return null;

  const exceptions = deps.exceptions ?? new ExceptionCaseService();
  return exceptions.report({
    condition: ALERT_CONDITION.RATE_LIMIT_EXHAUSTION,
    supplier: platformToSupplier(network),
    entityId: syncRunId,
    dedupeKey: `ratelimit:${network}:${networkAccountId || "default"}:${endpoint || "sync"}`,
    reason: "Repeated rate-limit exhaustion during sync",
    metadata: {
      network,
      networkAccountId,
      syncRunId,
      checkpointBefore,
      retryCount: error?.syncAttemptCount ?? null,
      rateLimitTelemetry: error?.rateLimitTelemetry ?? null,
      httpStatus: error?.response?.status ?? 429,
    },
  });
}

export async function reportCampaignBrandMappingMissing(
  { supplier, supplierCampaignId, blockedReason = null },
  deps = {},
) {
  const exceptions = deps.exceptions ?? new ExceptionCaseService();
  return exceptions.report({
    condition: ALERT_CONDITION.CAMPAIGN_BRAND_MAPPING_MISSING,
    supplier,
    entityId: supplierCampaignId,
    dedupeKey: `brand-map:${supplier}:${supplierCampaignId}`,
    reason: blockedReason || "Campaign/brand mapping missing",
    metadata: { supplierCampaignId, blockedReason },
  });
}
