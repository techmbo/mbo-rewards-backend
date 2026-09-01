/**
 * Safe supplier tracking URL construction with MBO attribution params.
 * Preserves existing query params and hash fragments; avoids duplicate keys.
 */

/**
 * @param {string} destinationUrl
 * @param {Record<string, string>} params
 * @param {{ overwriteExisting?: boolean }} [options]
 * @returns {{ url: string, applied: Record<string, string>, skipped: string[] }}
 */
export function appendTrackingParams(destinationUrl, params = {}, options = {}) {
  const overwriteExisting = options.overwriteExisting === true;
  if (!destinationUrl || typeof destinationUrl !== "string") {
    throw new Error("destinationUrl is required.");
  }

  let parsed;
  try {
    parsed = new URL(destinationUrl);
  } catch {
    throw new Error(`Invalid destination URL: ${destinationUrl}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  /** @type {Record<string, string>} */
  const applied = {};
  /** @type {string[]} */
  const skipped = [];

  for (const [key, rawValue] of Object.entries(params || {})) {
    if (!key || rawValue == null || rawValue === "") {
      skipped.push(String(key || "(empty)"));
      continue;
    }
    const value = String(rawValue);
    if (parsed.searchParams.has(key) && !overwriteExisting) {
      skipped.push(key);
      continue;
    }
    parsed.searchParams.set(key, value);
    applied[key] = value;
  }

  return {
    url: parsed.toString(),
    applied,
    skipped,
  };
}
