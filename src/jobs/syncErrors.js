import { extractUpstreamErrorMessage } from "../core/httpClient.js";
import { OPTIMISE_REGION_AGENCY_IDS } from "../modules/integrations/optimiseCredentials.js";

const OPTIMISE_REGION_NAMES = {
  sea: "SEA",
  mena: "MENA",
  uk: "UK",
};

function detectProvider(error) {
  const baseURL = error?.config?.baseURL || "";
  const url = error?.config?.url || "";
  if (baseURL.includes("boostiny") || url.includes("boostiny")) return "Boostiny";
  if (baseURL.includes("optimisemedia") || url.includes("optimisemedia")) return "Optimise";
  if (baseURL.includes("trackier") || url.includes("trackier")) return "Trackier";
  return null;
}

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

export function classifyOptimiseError(error, credentials = null) {
  const status = error?.response?.status;
  const upstream = String(extractUpstreamErrorMessage(error?.response?.data) || "");
  const body = responseBodyText(error).toUpperCase();
  const region = credentials?.region || "";
  const regionName = OPTIMISE_REGION_NAMES[region] || region.toUpperCase() || "this region";
  const expectedAgencyId = credentials?.expectedAgencyId || OPTIMISE_REGION_AGENCY_IDS[region];

  if (credentials?.agencyMismatch && expectedAgencyId) {
    return {
      key: "incorrect_agency_id",
      message: `Incorrect Agency ID. For Optimise ${regionName}, use Agency ID ${expectedAgencyId} (you entered ${credentials.agencyId}).`,
    };
  }

  if (
    status === 401 ||
    /INVALID.*API.*KEY|UNAUTHORIZED|AUTHENTICATION/i.test(body) ||
    /INVALID.*API.*KEY|UNAUTHORIZED/i.test(upstream)
  ) {
    return {
      key: "incorrect_api_key",
      message: `Incorrect API key. Check that you are using the Optimise ${regionName} service account key from Insights → Admin → Service Accounts.`,
    };
  }

  if (
    status === 403 &&
    (/USERID_CANNOT_ACCESS_CONTACT|CANNOT_ACCESS_CONTACT|CONTACT/i.test(body) ||
      /CONTACT/i.test(upstream))
  ) {
    return {
      key: "incorrect_contact_id",
      message: `Incorrect Contact ID. Use your publisher Contact ID (AID/MID) from your Optimise ${regionName} account.`,
    };
  }

  if (status === 403 && /ACCESS_DENIED/i.test(body)) {
    return {
      key: "access_denied",
      message: `Access denied. Your API key may be wrong, or it may not have permission for Optimise ${regionName}.`,
    };
  }

  if (status === 403 && /USER_CAN_NOT_ACCESS_RESOURCE|CANNOT_ACCESS_RESOURCE/i.test(body)) {
    return {
      key: "access_denied",
      message: `Access denied. Confirm the API key, Agency ID (${expectedAgencyId || "see docs"}), and Contact ID all belong to the same Optimise ${regionName} account.`,
    };
  }

  if (status === 403) {
    return {
      key: "access_denied",
      message: `Access denied. Please reconnect Optimise ${regionName} on the Integrations page with the correct API key, Agency ID${expectedAgencyId ? ` (${expectedAgencyId})` : ""}, and Contact ID.`,
    };
  }

  if (status === 429) {
    return {
      key: "rate_limit",
      message: "Optimise is limiting requests. Please wait a minute and try syncing again.",
    };
  }

  if (upstream) {
    return {
      key: `upstream:${upstream}`,
      message: `Optimise returned an error: ${upstream}`,
    };
  }

  return {
    key: "unknown",
    message: "Could not fetch data from Optimise. Please check your connection details and try again.",
  };
}

export function classifyTrackierError(error, _credentials = null) {
  const status = error?.response?.status;
  const upstream = String(extractUpstreamErrorMessage(error?.response?.data) || "");
  const body = responseBodyText(error).toUpperCase();

  if (
    status === 401 ||
    status === 403 ||
    /INVALID.*API.*KEY|UNAUTHORIZED|AUTHENTICATION/i.test(body) ||
    /INVALID.*API.*KEY|UNAUTHORIZED/i.test(upstream)
  ) {
    return {
      key: "incorrect_api_key",
      message: "Incorrect Trackier API key. Reconnect the account on the Integrations page.",
    };
  }

  if (status === 429) {
    return {
      key: "rate_limit",
      message: "Trackier is limiting requests. Please wait a minute and try syncing again.",
    };
  }

  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return {
      key: "upstream_unavailable",
      message: "Trackier is temporarily unavailable. Please try syncing again shortly.",
    };
  }

  if (upstream) {
    return { key: `upstream:${upstream}`, message: `Trackier returned an error: ${upstream}` };
  }

  return {
    key: "unknown",
    message: "Could not fetch data from Trackier. Please check your API key and try again.",
  };
}

function classifyBoostinyError(error) {
  const status = error?.response?.status;
  const upstream = extractUpstreamErrorMessage(error?.response?.data);

  if (status === 401 || status === 403) {
    return {
      key: "incorrect_api_key",
      message: "Incorrect Boostiny API key. Reconnect the account on the Integrations page.",
    };
  }

  if (status === 429) {
    if (upstream && /minute/i.test(upstream)) {
      return {
        key: "rate_limit",
        message: "Boostiny is temporarily limiting requests. Please wait 10 minutes, then try again.",
      };
    }
    return {
      key: "rate_limit",
      message: "Boostiny is temporarily limiting requests. Please wait a few minutes and try again.",
    };
  }

  if (upstream) {
    return { key: `upstream:${upstream}`, message: upstream };
  }

  return {
    key: "unknown",
    message: "Could not fetch data from Boostiny. Please check your API key and try again.",
  };
}

export function toUserFriendlySyncError(error, credentials = null) {
  const provider = detectProvider(error);

  if (provider === "Optimise") {
    return classifyOptimiseError(error, credentials).message;
  }

  if (provider === "Boostiny") {
    return classifyBoostinyError(error).message;
  }

  if (provider === "Trackier") {
    return classifyTrackierError(error, credentials).message;
  }

  const upstream = extractUpstreamErrorMessage(error?.response?.data);
  if (upstream) return upstream;

  if (error?.code === "P2025") {
    return "Sync finished importing data, but no connected account was found to save timestamps. Connect the network on the Integrations page, then sync again.";
  }

  return error?.message || "Sync failed. Please try again.";
}

/**
 * @param {Array<{ resource?: string, error: unknown }>} resourceFailures
 */
export function summarizeOptimiseSyncIssues(resourceFailures, credentials) {
  if (credentials?.agencyMismatch) {
    return [classifyOptimiseError({ response: { status: 403 } }, credentials).message];
  }

  if (!resourceFailures?.length) {
    return [];
  }

  const messages = [];
  const seen = new Set();

  for (const entry of resourceFailures) {
    const error = entry?.error ?? entry;
    const resource = entry?.resource;
    if (!error) continue;

    const classified = classifyOptimiseError(error, credentials);
    const dedupeKey = `${resource || "unknown"}:${classified.key}`;
    if (!classified?.message || seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    messages.push(resource ? `${resource}: ${classified.message}` : classified.message);
  }

  const hadErrors = resourceFailures.some((entry) => entry?.error ?? entry);
  if (hadErrors && messages.length === 0) {
    messages.push("Some data could not be fetched from Optimise. Please check your connection details.");
  }

  return messages;
}

export function formatSyncError(error) {
  return new Error(toUserFriendlySyncError(error));
}

export function getSyncErrorMessage(error) {
  return toUserFriendlySyncError(error);
}

export function formatOptimiseResourceError(resource, error, credentials = null) {
  return classifyOptimiseError(error, credentials).message;
}

export function joinUserMessages(messages) {
  return messages.filter(Boolean).join("\n");
}

/**
 * @param {Array<{ resource?: string, error: unknown }>} resourceFailures
 */
export function summarizeTrackierSyncIssues(resourceFailures, credentials) {
  if (!resourceFailures?.length) {
    return [];
  }

  const messages = [];
  const seen = new Set();

  for (const entry of resourceFailures) {
    const error = entry?.error ?? entry;
    const resource = entry?.resource;
    if (!error) continue;

    const classified = classifyTrackierError(error, credentials);
    const dedupeKey = `${resource || "unknown"}:${classified.key}`;
    if (!classified?.message || seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    messages.push(resource ? `${resource}: ${classified.message}` : classified.message);
  }

  const hadErrors = resourceFailures.some((entry) => entry?.error ?? entry);
  if (hadErrors && messages.length === 0) {
    messages.push("Some data could not be fetched from Trackier. Please check your connection details.");
  }

  return messages;
}
