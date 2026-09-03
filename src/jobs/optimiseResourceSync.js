import { asArray } from "../core/normalize.js";
import { extractUpstreamErrorMessage } from "../core/httpClient.js";
import { classifyOptimiseError, summarizeOptimiseSyncIssues } from "./syncErrors.js";

/** Optimise API resources fetched during syncOptimiseRegion. */
export const OPTIMISE_RESOURCE_ENDPOINTS = {
  campaigns: { method: "GET", path: "/campaigns" },
  conversions: { method: "GET", path: "/conversions" },
  conversionsByPayment: { method: "GET", path: "/conversions" },
  reporting: { method: "POST", path: "/reporting/" },
  invoiceReporting: { method: "POST", path: "/reporting/" },
  payments: { method: "GET", path: "/payments" },
  invoices: { method: "GET", path: "/invoices" },
  voucherCodes: { method: "GET", path: "/vouchercodes" },
  /**
   * Campaign-scoped, not a global paginated list: one request per applicable campaign
   * (see jobs/optimiseCommissionGroupSync.js). Sync metadata carries the per-campaign
   * request tally under `campaignScope`.
   */
  commissionGroups: {
    method: "GET",
    path: "/campaigns/{campaignId}/commission-groups",
    scope: "campaign",
  },
};

function formatEndpoint(resource) {
  const spec = OPTIMISE_RESOURCE_ENDPOINTS[resource];
  if (!spec) return resource;
  return `${spec.method} ${spec.path}`;
}

/**
 * Fetch one Optimise resource; attach resource + endpoint metadata to results and errors.
 */
export async function fetchOptimiseResource(resource, credentials, fn, options = {}) {
  const endpoint = formatEndpoint(resource);
  const { skipped = false, skipReason = null } = options;

  if (skipped) {
    return {
      resource,
      endpoint,
      rows: [],
      error: null,
      skipped: true,
      skipReason,
    };
  }

  try {
    const rows = await fn();
    return {
      resource,
      endpoint,
      rows: asArray(rows),
      error: null,
      skipped: false,
    };
  } catch (error) {
    if (error && typeof error === "object") {
      error.syncResource = resource;
      error.syncEndpoint = endpoint;
    }
    return {
      resource,
      endpoint,
      rows: [],
      error,
      skipped: false,
    };
  }
}

export function buildResourceFailureDiagnostic(resource, endpoint, error, credentials) {
  const classified = classifyOptimiseError(error, credentials);
  return {
    resource,
    endpoint,
    httpStatus: error?.response?.status ?? null,
    retryCount: error?.syncAttemptCount ?? null,
    responseMessage:
      extractUpstreamErrorMessage(error?.response?.data) || error?.message || null,
    userMessage: classified.message,
  };
}

export function collectResourceFailures(resourceResults) {
  return resourceResults
    .filter((result) => result?.error)
    .map((result) => ({
      resource: result.resource,
      endpoint: result.endpoint,
      error: result.error,
    }));
}

export function buildOptimiseSyncMetadata(
  resourceResults,
  credentials,
  { refreshCampaigns, refreshCoupons },
) {
  const resources = {};
  const failures = [];

  for (const result of resourceResults) {
    if (!result?.resource) continue;

    const fetched = asArray(result.rows).length;
    const entry = {
      fetched,
      success: !result.error,
      endpoint: result.endpoint,
    };

    if (result.skipped) {
      entry.skipped = true;
      entry.skipReason = result.skipReason || "skipped";
    }

    if (result.campaignScope) {
      entry.scope = "campaign";
      entry.campaignScope = result.campaignScope;
      if (!result.error && result.campaignScope.requestsFailed > 0) {
        entry.success = false;
        entry.partial = true;
        failures.push({
          resource: result.resource,
          endpoint: result.endpoint,
          httpStatus: null,
          retryCount: null,
          responseMessage: `${result.campaignScope.requestsFailed} of ${result.campaignScope.requestsAttempted} campaign commission-group requests failed`,
          userMessage:
            "Some Optimise campaign commission-group requests failed. Existing supplier commission rules for those campaigns were kept unchanged; detailed commission mapping is incomplete until the next successful sync.",
          campaignIds: (result.campaignScope.failures || []).map((failure) => failure.campaignId),
        });
      }
    }

    resources[result.resource] = entry;

    if (result.error) {
      failures.push(
        buildResourceFailureDiagnostic(
          result.resource,
          result.endpoint,
          result.error,
          credentials,
        ),
      );
    }
  }

  return {
    skippedCampaignRefresh: !refreshCampaigns,
    skippedCouponRefresh: !refreshCoupons,
    resources,
    failures,
  };
}

export function summariseOptimiseResourceWarnings(resourceResults, credentials) {
  const failures = collectResourceFailures(resourceResults);
  return summarizeOptimiseSyncIssues(failures, credentials);
}
