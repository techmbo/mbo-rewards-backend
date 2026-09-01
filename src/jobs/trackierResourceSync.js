import { asArray } from "../core/normalize.js";
import { extractUpstreamErrorMessage } from "../core/httpClient.js";
import { classifyTrackierError, summarizeTrackierSyncIssues } from "./syncErrors.js";

/** Trackier API resources fetched during syncTrackierAccount. */
export const TRACKIER_RESOURCE_ENDPOINTS = {
  profile: { method: "GET", path: "/v2/publishers/profile" },
  categories: { method: "GET", path: "/v2/publishers/categories" },
  campaignsCount: { method: "GET", path: "/v2/publishers/:pubId/campaignsCount" },
  campaigns: { method: "GET", path: "/v2/publisher/campaigns" },
  coupons: { method: "GET", path: "/v2/publishers/coupons" },
  deals: { method: "GET", path: "/v2/publishers/deals" },
  conversions: { method: "GET", path: "/v2/publishers/conversions" },
  reportsKpi: { method: "GET", path: "/v2/publishers/reports-kpi" },
  reports: { method: "GET", path: "/v2/publishers/reports" },
};

/** Resources that may be unavailable for some publisher API keys. */
export const TRACKIER_OPTIONAL_RESOURCES = new Set(["campaignsCount"]);

function responseBodyText(error) {
  const data = error?.response?.data;
  if (!data) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function isTrackierIgnorableResourceError(resource, error) {
  if (!TRACKIER_OPTIONAL_RESOURCES.has(resource) || !error) return false;

  const status = error?.response?.status;
  const body = responseBodyText(error).toUpperCase();
  const upstream = String(extractUpstreamErrorMessage(error?.response?.data) || "").toUpperCase();

  return (
    status === 400 ||
    status === 403 ||
    /INSUFFICIENT_PERMISSION|INSUFFICIENT PERMISSION/i.test(body) ||
    /INSUFFICIENT_PERMISSION|INSUFFICIENT PERMISSION/i.test(upstream)
  );
}

function formatEndpoint(resource) {
  const spec = TRACKIER_RESOURCE_ENDPOINTS[resource];
  if (!spec) return resource;
  return `${spec.method} ${spec.path}`;
}

export async function fetchTrackierResource(resource, credentials, fn, options = {}) {
  const endpoint = formatEndpoint(resource);
  const { skipped = false, skipReason = null } = options;

  if (skipped) {
    return {
      resource,
      endpoint,
      rows: [],
      data: null,
      error: null,
      skipped: true,
      skipReason,
    };
  }

  try {
    const result = await fn();
    const isArrayResult = Array.isArray(result);
    return {
      resource,
      endpoint,
      rows: isArrayResult ? asArray(result) : [],
      data: isArrayResult ? null : result,
      error: null,
      skipped: false,
    };
  } catch (error) {
    if (error && typeof error === "object") {
      error.syncResource = resource;
      error.syncEndpoint = endpoint;
    }

    if (isTrackierIgnorableResourceError(resource, error)) {
      return {
        resource,
        endpoint,
        rows: [],
        data: null,
        error: null,
        skipped: true,
        skipReason: "insufficient_permissions",
      };
    }

    return {
      resource,
      endpoint,
      rows: [],
      data: null,
      error,
      skipped: false,
    };
  }
}

export function buildResourceFailureDiagnostic(resource, endpoint, error, credentials) {
  const classified = classifyTrackierError(error, credentials);
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
    .filter((result) => result?.error && !isTrackierIgnorableResourceError(result.resource, result.error))
    .map((result) => ({
      resource: result.resource,
      endpoint: result.endpoint,
      error: result.error,
    }));
}

export function buildTrackierSyncMetadata(
  resourceResults,
  credentials,
  { refreshCampaigns, refreshCoupons, profile, campaignsCount, availableKpis },
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

    resources[result.resource] = entry;

    if (result.error && !isTrackierIgnorableResourceError(result.resource, result.error)) {
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
    publisherProfile: profile ?? null,
    campaignsCount: campaignsCount ?? null,
    availableKpis: availableKpis ?? null,
    resources,
    failures,
  };
}

export function summariseTrackierResourceWarnings(resourceResults, credentials) {
  const failures = collectResourceFailures(resourceResults);
  return summarizeTrackierSyncIssues(failures, credentials);
}
