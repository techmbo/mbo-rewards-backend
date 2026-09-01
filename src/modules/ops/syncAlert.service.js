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

  await updateTimestamps(platform, accountLabel, {
    lastSyncError,
    credentialHealth: CREDENTIAL_HEALTH.FAILED,
    syncEnabled: false,
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
